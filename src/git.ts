import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, cp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseEnvConfig } from './env-config.js';
import { writeFileAtomic } from './fs-atomic.js';
import type { Paths } from './paths.js';

/**
 * Git plumbing for the store repo (design D9/D14). The store at {@link Paths.store}
 * is an ordinary local git repository that optionally syncs through a single
 * remote. Everything here is:
 *
 * - **offline-first** — every helper degrades to a silent no-op when the store is
 *   not a git repo or has no remote, so the tool works with no network at all;
 * - **fail-soft** — a network failure never throws to the caller: a pull that
 *   cannot reach the remote is skipped, a push that fails is *queued* for the next
 *   invocation, and neither is ever fatal (spec assumption 6, criterion 11);
 * - **spawn-based** — `git` is invoked with no shell, `GIT_TERMINAL_PROMPT=0` (so a
 *   private remote never blocks on a credential prompt), and a timeout, mirroring
 *   the {@link import('./skill-source.js') skill-source} pattern;
 * - **credential-safe** — a URL is normalised/redacted before it is ever logged,
 *   and a resolved secret is NEVER written into the repo (the pre-commit scan
 *   blocks it, D6/D9).
 *
 * The invocation lifecycle wiring (drift-commit → pull → materialise, commit per
 * mutation, one push at the end) lives in {@link beginStoreSync} / {@link
 * commitStore} / {@link endStoreSync}; the command layer composes them.
 */

// ---------------------------------------------------------------------------
// Low-level runner
// ---------------------------------------------------------------------------

/** The outcome of one `git` invocation. `code: null` means spawn-error or timeout. */
export interface GitRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * A `git` runner. Injected (via {@link RunOptions.gitRun}) so tests can count
 * pushes or simulate failures deterministically; the default spawns real git.
 */
export type GitRunner = (
  args: readonly string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<GitRunResult>;

/** A generous default ceiling; network ops override it with a short timeout. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** The pull budget: never block an invocation more than ~3s on the network (D9). */
export const PULL_TIMEOUT_MS = 3_000;

/**
 * Run `git <args>` in `cwd`, capturing output. Never throws on a non-zero exit —
 * the caller inspects `code`. A spawn error (git missing) or a timeout resolves
 * with `code: null`; `timedOut` distinguishes the two. No shell; credential
 * prompts are disabled so a private remote fails fast instead of hanging.
 *
 * Timeout is a HARD bound even against a black-holing remote (F1): git spawns a
 * transport helper (`git-remote-https`) as a grandchild that inherits git's stdout
 * pipe. Killing only the direct `git` leaves that helper alive (reparented) holding
 * the pipe open, so `'close'` — which waits for the stdio to close — never fires and
 * the promise would hang forever. So we spawn `detached` (git leads its own process
 * GROUP), kill the whole GROUP on timeout (helper included), and settle on `'exit'`
 * — which fires on the direct child's death regardless of a grandchild still holding
 * a pipe. The happy path still settles on `'close'` so full output is captured; a
 * `settled` guard makes resolution single-shot.
 */
export const defaultGitRunner: GitRunner = (args, opts) =>
  new Promise<GitRunResult>((resolvePromise) => {
    const child = spawn('git', [...args], {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...opts.env, GIT_TERMINAL_PROMPT: '0' },
      detached: true, // own process group, so a timeout can kill the transport helper too
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      timedOut = true;
      // Kill the whole process GROUP (negative pid) so the reparented transport
      // helper dies too; fall back to the direct child if the group kill is denied.
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }, opts.timeoutMs);
    timer.unref?.();
    const settle = (result: GitRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Drop the pipes so a lingering grandchild that still holds one open can never
      // keep the event loop (or a test) alive after we have resolved.
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolvePromise(result);
    };
    child.on('error', (err) => {
      settle({ code: null, stdout, stderr: `${stderr}${err.message}`, timedOut });
    });
    // Happy path: 'close' fires once stdio is flushed → full output captured.
    child.on('close', (code) => {
      settle({ code, stdout, stderr, timedOut });
    });
    // Hang path: on timeout the group is killed; 'exit' fires on the direct child's
    // death even while a grandchild still holds the pipe open (so 'close' may never
    // come). We settle with whatever output we captured before the kill.
    child.on('exit', (code) => {
      if (timedOut) settle({ code, stdout, stderr, timedOut });
    });
  });

/** First non-empty, trimmed line of text — for compact one-line diagnostics. */
function firstLine(text: string): string {
  return text.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** Everything a git helper needs, resolved once from the invocation. */
export interface GitContext {
  paths: Paths;
  env: NodeJS.ProcessEnv;
  /** The git runner (injectable). Defaults to {@link defaultGitRunner}. */
  run: GitRunner;
}

/** Build a {@link GitContext}, taking an injected runner when one is supplied. */
export function gitContext(paths: Paths, env: NodeJS.ProcessEnv, run?: GitRunner): GitContext {
  return { paths, env, run: run ?? defaultGitRunner };
}

/** Run git in the store repo with the default (non-network) timeout. */
function git(ctx: GitContext, args: readonly string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<GitRunResult> {
  return ctx.run(args, { cwd: ctx.paths.store, env: ctx.env, timeoutMs });
}

// ---------------------------------------------------------------------------
// Repo state
// ---------------------------------------------------------------------------

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Is `dir` (or any ancestor up to itself) a git working tree? Cheap fs check. */
export async function isGitRepo(dir: string): Promise<boolean> {
  return pathExists(join(dir, '.git'));
}

/** Is the STORE a git repo? Convenience over {@link isGitRepo}. */
export function storeIsRepo(paths: Paths): Promise<boolean> {
  return isGitRepo(paths.store);
}

function nulSeparatedPaths(stdout: string): string[] {
  return stdout.split('\0').filter((path) => path !== '');
}

/**
 * List every dirty canonical store path without touching the index. The drift
 * publisher uses this to include changes made directly inside the store (including
 * untracked files) in the same required, secret-scanned commit as projected drift.
 */
export async function listStoreDirtyPaths(
  paths: Paths,
  env: NodeJS.ProcessEnv,
  run?: GitRunner,
): Promise<string[]> {
  if (!(await storeIsRepo(paths))) return [];
  const ctx = gitContext(paths, env, run);
  const results = await Promise.all([
    git(ctx, ['diff', '--name-only', '-z', '--']),
    git(ctx, ['diff', '--cached', '--name-only', '-z', '--']),
    git(ctx, ['ls-files', '--others', '--exclude-standard', '-z', '--']),
  ]);
  const failed = results.find((result) => result.code !== 0);
  if (failed) {
    throw new Error(`agentenv: could not inspect store drift (${firstLine(failed.stderr)})`);
  }
  return [...new Set(results.flatMap((result) => nulSeparatedPaths(result.stdout)))]
    .map((path) => resolve(paths.store, path));
}

/** The current branch (works even on an unborn branch with no commits). */
async function currentBranch(ctx: GitContext): Promise<string> {
  const res = await git(ctx, ['branch', '--show-current']);
  const name = res.stdout.trim();
  return name !== '' ? name : 'main';
}

/** Does the store repo have at least one commit? */
async function hasCommits(ctx: GitContext): Promise<boolean> {
  const res = await git(ctx, ['rev-parse', '--verify', 'HEAD']);
  return res.code === 0;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** The commit identity: the local git config, else a stable agentenv default. */
export interface GitIdentity {
  name: string;
  email: string;
}

/**
 * Resolve a commit identity. A real machine almost always has a global
 * `user.name`/`user.email`; when it does not we still must be able to commit, so
 * we fall back to a clearly-marked agentenv identity rather than failing. The
 * per-commit `-c user.*` overrides (see {@link commitArgs}) mean the store never
 * needs its own committed identity config either way.
 */
export async function resolveGitIdentity(ctx: GitContext): Promise<GitIdentity> {
  const name = (await git(ctx, ['config', 'user.name'])).stdout.trim();
  const email = (await git(ctx, ['config', 'user.email'])).stdout.trim();
  return {
    name: name !== '' ? name : 'agentenv',
    email: email !== '' ? email : 'agentenv@localhost',
  };
}

/** Commit argument prefix that pins identity + disables signing, so a commit never
 *  fails on a missing global identity or a machine-wide GPG requirement. */
function commitArgs(identity: GitIdentity): string[] {
  return [
    '-c',
    `user.name=${identity.name}`,
    '-c',
    `user.email=${identity.email}`,
    '-c',
    'commit.gpgsign=false',
  ];
}

// ---------------------------------------------------------------------------
// URL normalisation (never log credentials)
// ---------------------------------------------------------------------------

/**
 * Normalise a remote URL for comparison (D14 "same normalised URL"): trim, drop a
 * trailing slash and a trailing `.git`. Intentionally conservative — it does not
 * canonicalise host/scheme, so it never claims two genuinely different remotes are
 * the same.
 */
export function normaliseRemoteUrl(url: string): string {
  let u = url.trim();
  u = u.replace(/\/+$/, '');
  u = u.replace(/\.git$/, '');
  return u;
}

/**
 * Redact any credential before logging it (spec assumption 7): every
 * `scheme://user:secret@host/…` becomes `scheme://user:***@host/…`. scp-style
 * (`git@host:owner/repo`) and `file://` URLs carry no password and pass through.
 *
 * Unanchored + global so it also redacts a credentialed URL EMBEDDED in arbitrary
 * text — e.g. a `git` stderr line like `fatal: unable to access
 * 'https://user:tok@host/…'` shown to the user (F5). git strips creds itself today,
 * but this makes any git stderr we surface defensively credential-safe.
 */
export function redactRemoteUrl(url: string): string {
  return url.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]*:)[^/@\s]*@/gi, (_m, scheme, userColon) => {
    return `${scheme}${userColon}***@`;
  });
}

// ---------------------------------------------------------------------------
// Secret scan (D6/D9) — key-name patterns + known high-confidence tokens
// ---------------------------------------------------------------------------

/** One suspected secret found by the scan. */
export interface SecretFinding {
  /** Store-relative path of the file, or '' when scanning a bare string. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** Why it tripped the scan, for the human-readable block message. */
  reason: string;
}

/**
 * High-confidence token shapes. These are unambiguous provider prefixes / formats,
 * so they carry almost no false-positive risk (a store legitimately contains
 * sha-1/sha-256 hex — commit ids and provenance hashes — which none of these match).
 */
const TOKEN_PATTERNS: readonly { re: RegExp; reason: string }[] = [
  { re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/, reason: 'PEM private key block' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, reason: 'AWS access key id' },
  { re: /\bASIA[0-9A-Z]{16}\b/, reason: 'AWS temporary access key id' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, reason: 'GitHub token' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/, reason: 'GitHub fine-grained token' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, reason: 'Slack token' },
  { re: /\bsk-[A-Za-z0-9]{20,}\b/, reason: 'OpenAI-style secret key' },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/, reason: 'Google API key' },
  { re: /\bxapp-[0-9]-[A-Za-z0-9-]{10,}\b/, reason: 'Slack app token' },
];

/** Secret-y assignment key names for the value-shaped rule. */
const SECRET_KEY_RE =
  /\b(?:api[_-]?key|apikey|secret[_-]?key|secret|access[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|password|passwd|token)\b/i;

/** Values that are clearly placeholders/fixtures, never a real secret (D6). */
const PLACEHOLDER_RE = /\$\{[^}]+\}|\{env:[^}]+\}|^\$[A-Za-z_]|<[^>]+>/;
const FIXTURE_WORD_RE =
  /\b(?:example|sample|dummy|changeme|change-me|placeholder|redacted|your[_-]?|todo|xxxx+|test[_-]?token|fake)\b/i;
/**
 * The same fixture markers WITHOUT word boundaries — for matching a marker embedded
 * INSIDE a token, which is how providers publish documentation keys (AWS's public
 * `AKIAIOSFODNN7EXAMPLE` / `…EXAMPLEKEY`). Applied only to a matched token (never a
 * whole line), so it exempts a documented example without weakening a real token.
 */
const FIXTURE_MARKER_IN_TOKEN_RE =
  /example|sample|dummy|changeme|placeholder|redacted|xxxx+|faketoken/i;
/**
 * A scoped, inline opt-out (D6): mark a legitimately token-shaped line — the store
 * is designed to hold vendored + security skills that legitimately contain
 * token-shaped strings — so a documented token is not an unrecoverable wedge. The
 * scan blocks loudly by DEFAULT; this marker is the deliberate, per-line override.
 */
const ALLOW_SECRET_RE = /agentenv:allow-secret/i;

/**
 * Extract the value of a KEYLESS list item — a YAML block-sequence entry (`- x`) or a
 * JSON array string element (a quoted string alone on its line, no `key:`). Returns
 * `undefined` for anything else. This is where an array-nested secret lands (canonical
 * MCP `args: [..., "<secret>"]`), which the key:value and provider-shape rules miss.
 */
function bareListItemValue(line: string): string | undefined {
  const yaml = /^\s*-\s+(.+?)\s*$/.exec(line);
  if (yaml) {
    const raw = yaml[1] as string;
    const q = /^(["'])(.*)\1$/.exec(raw);
    return q ? (q[2] as string) : raw;
  }
  const json = /^\s*"((?:[^"\\]|\\.)*)"\s*,?\s*$/.exec(line);
  if (json) return json[1] as string;
  return undefined;
}

/** Shannon entropy in bits-per-character — a cheap randomness signal. */
function shannonEntropyBits(v: string): number {
  const freq = new Map<string, number>();
  for (const ch of v) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of freq.values()) {
    const p = count / v.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * Whether a bare value looks like an opaque high-entropy secret. Deliberately
 * CONSERVATIVE so ordinary list items (skill names, short args, package specs,
 * lowercase-hex hashes) never trip it: ≥24 chars, token charset only, MIXED case
 * AND a digit, real randomness (Shannon ≥3.5 bits/char), and never a `${VAR}`
 * placeholder or fixture word.
 */
function looksHighEntropyToken(v: string): boolean {
  if (v.length < 24) return false;
  if (PLACEHOLDER_RE.test(v) || FIXTURE_WORD_RE.test(v)) return false;
  if (!/^[A-Za-z0-9_+/=-]+$/.test(v)) return false;
  if (!/[a-z]/.test(v) || !/[A-Z]/.test(v) || !/[0-9]/.test(v)) return false;
  return shannonEntropyBits(v) >= 3.5;
}

/**
 * Scan one text for suspected secrets, returning a finding per offending line.
 * Three rules, all conservative to avoid blocking legitimate commits:
 *
 * 1. **Known token shapes** — unambiguous provider prefixes/formats.
 * 2. **Secret-named assignment** — a `secret|token|password|api_key…` key set to a
 *    value that *looks real* (≥16 chars, has a letter AND a digit) and is not a
 *    `${VAR}` placeholder or an obvious fixture word.
 * 3. **Keyless high-entropy list item** — a bare `- <secret>` / JSON array element
 *    with no key, so an OPAQUE array-nested secret (canonical MCP `args`) is caught
 *    even when it carries no provider prefix (belt-and-braces, D9).
 */
export function scanTextForSecrets(text: string): { line: number; reason: string }[] {
  const out: { line: number; reason: string }[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    // Scoped override (D6): an `agentenv:allow-secret` marker on the line — or the
    // line immediately above — exempts a legitimately token-shaped line, so a
    // vendored/security skill is never an unrecoverable wedge.
    if (ALLOW_SECRET_RE.test(line) || ALLOW_SECRET_RE.test(lines[i - 1] ?? '')) continue;
    let matched = false;
    for (const { re, reason } of TOKEN_PATTERNS) {
      const m = re.exec(line);
      if (m) {
        // A documented example / placeholder / ${VAR} is never a real secret (D6).
        // The exemption now covers the token-shape rule too (not just the value rule
        // below): a `${VAR}`/`<...>` placeholder, a fixture WORD on the line (a
        // comment marker), or a fixture marker embedded IN the matched token (AWS's
        // public `AKIAIOSFODNN7EXAMPLE`) exempts it — while a REAL token on an
        // unmarked line still trips.
        const exempt =
          PLACEHOLDER_RE.test(line) ||
          FIXTURE_WORD_RE.test(line) ||
          FIXTURE_MARKER_IN_TOKEN_RE.test(m[0]);
        if (!exempt) out.push({ line: i + 1, reason });
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // Keyless high-entropy list item (`- <secret>` / a JSON array string element):
    // the last line of defence for an opaque array-nested secret with no provider
    // prefix. The `allow-secret` override at the top of the loop still exempts it.
    const listItem = bareListItemValue(line);
    if (listItem !== undefined && looksHighEntropyToken(listItem)) {
      out.push({ line: i + 1, reason: 'high-entropy value in a keyless list item' });
      continue;
    }

    // Secret-named assignment with a real-looking value.
    const assign = /(["']?)([A-Za-z0-9_.-]+)\1\s*[:=]\s*(.+)$/.exec(line.trim());
    if (!assign) continue;
    const keyName = assign[2] ?? '';
    if (!SECRET_KEY_RE.test(keyName)) continue;
    let value = (assign[3] ?? '').trim();
    // Strip surrounding quotes and a trailing comma.
    value = value.replace(/,\s*$/, '').replace(/^["']|["']$/g, '');
    if (value === '' || PLACEHOLDER_RE.test(value) || FIXTURE_WORD_RE.test(value)) continue;
    if (value.length < 16) continue;
    if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) continue;
    out.push({ line: i + 1, reason: `secret-named field '${keyName}' with a literal value` });
  }
  return out;
}

/** Whether a filename looks like text we should scan (skip obvious binaries). */
function isProbablyText(name: string): boolean {
  return !/\.(?:png|jpg|jpeg|gif|webp|ico|pdf|zip|gz|tar|woff2?|ttf|otf|mp4|mp3|wasm|node)$/i.test(name);
}

/**
 * Walk the store working tree (excluding `.git`) and scan every text file for
 * secrets (D9). Returns every finding across the tree — the pre-commit / post-pull
 * caller decides whether to block or quarantine.
 */
export async function scanStoreForSecrets(paths: Paths): Promise<SecretFinding[]> {
  const findings: SecretFinding[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && isProbablyText(entry.name)) {
        let text: string;
        try {
          text = await readFile(full, 'utf8');
        } catch {
          continue;
        }
        const rel = relative(paths.store, full).split(sep).join('/');
        for (const hit of scanTextForSecrets(text)) {
          findings.push({ file: rel, line: hit.line, reason: hit.reason });
        }
      }
    }
  };
  await walk(paths.store);
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return findings;
}

/**
 * Scan every text blob newly reachable from a candidate revision, not merely
 * the candidate's final tree. This catches credentials introduced in one remote
 * commit and deleted in a later commit: the clean tip must not make leaked
 * history eligible for promotion.
 */
export async function scanRevisionRangeForSecrets(
  paths: Paths,
  env: NodeJS.ProcessEnv,
  baseRevision: string | null,
  candidateRevision: string,
  run?: GitRunner,
): Promise<SecretFinding[]> {
  const ctx = gitContext(paths, env, run);
  const listed = await git(ctx, [
    'rev-list',
    '--objects',
    candidateRevision,
    ...(baseRevision ? [`^${baseRevision}`] : []),
  ]);
  if (listed.code !== 0) {
    throw new Error('could not enumerate newly reachable candidate history');
  }

  const findings: SecretFinding[] = [];
  const seen = new Set<string>();
  for (const line of listed.stdout.split('\n')) {
    const separator = line.indexOf(' ');
    const objectId = (separator === -1 ? line : line.slice(0, separator)).trim();
    const objectPath = separator === -1 ? '' : line.slice(separator + 1);
    if (!/^[0-9a-f]{40,64}$/i.test(objectId) || seen.has(objectId)) continue;
    seen.add(objectId);
    const type = await git(ctx, ['cat-file', '-t', objectId]);
    if (type.code !== 0) throw new Error('could not inspect a newly reachable candidate object');
    if (type.stdout.trim() !== 'blob') continue;
    const size = await git(ctx, ['cat-file', '-s', objectId]);
    const byteLength = Number.parseInt(size.stdout.trim(), 10);
    if (size.code !== 0 || !Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new Error('could not size a newly reachable candidate blob');
    }
    // Candidate history is hostile input. The bounded scanner must fail closed
    // instead of silently trusting a blob it declines to load.
    if (byteLength > 2 * 1024 * 1024) {
      const label = objectPath || `<blob-${objectId.slice(0, 12)}>`;
      findings.push({
        file: `history:${label}@${objectId.slice(0, 12)}`,
        line: 1,
        reason: 'candidate blob exceeds the bounded secret-scan limit',
      });
      continue;
    }
    const blob = await git(ctx, ['cat-file', 'blob', objectId]);
    if (blob.code !== 0) throw new Error('could not read a newly reachable candidate blob');
    const label = objectPath || `<blob-${objectId.slice(0, 12)}>`;
    for (const hit of scanTextForSecrets(blob.stdout)) {
      findings.push({
        file: `history:${label}@${objectId.slice(0, 12)}`,
        line: hit.line,
        reason: hit.reason,
      });
    }
  }
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return findings;
}

/**
 * Scan only the STAGED changes for secrets (D6/D9) — the files THIS commit would
 * write, not the whole working tree. So a pre-existing, unrelated flagged file can
 * never block an unrelated commit (it is not in the staged diff), and the gate
 * inspects exactly what is being committed. Runs after `git add -A`, so the working
 * tree of each changed path equals its staged blob. Deletions/binaries are skipped.
 *
 * The untrusted post-pull path deliberately stays a WHOLE-tree scan (see {@link
 * validatePulledStore} / {@link scanStoreForSecrets}) — a pulled remote tree is
 * shared input, so every file of it is suspect.
 */
async function scanStagedForSecrets(
  ctx: GitContext,
  paths: Paths,
  relativePathspecs: readonly string[] = [],
): Promise<SecretFinding[]> {
  const listed = await git(ctx, [
    'diff',
    '--cached',
    '--name-only',
    '-z',
    ...(relativePathspecs.length > 0 ? ['--', ...relativePathspecs] : []),
  ]);
  const names = listed.stdout.split('\0').filter((n) => n !== '');
  const findings: SecretFinding[] = [];
  for (const rel of names) {
    if (!isProbablyText(rel)) continue;
    let text: string;
    try {
      text = await readFile(join(paths.store, ...rel.split('/')), 'utf8');
    } catch {
      continue; // a staged deletion / unreadable / binary — nothing to scan
    }
    for (const hit of scanTextForSecrets(text)) {
      findings.push({ file: rel, line: hit.line, reason: hit.reason });
    }
  }
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return findings;
}

/** Render findings as a compact, human-readable block for a warning/error. */
export function describeFindings(findings: readonly SecretFinding[]): string {
  return findings
    .map((f) => `  ${f.file || '<staged>'}:${f.line} — ${f.reason}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Store-as-repo init (idempotent)
// ---------------------------------------------------------------------------

const STORE_GITIGNORE = `# agentenv store — machine-local artifacts live OUTSIDE this repo
# (state.json, secrets.env, backups/, live/, shims/ all sit beside store/,
# never inside it). This file only keeps OS/editor cruft out of the synced store.
.DS_Store
*.swp
Thumbs.db
`;

/**
 * Make {@link Paths.store} a git repository (design D9). Idempotent: an existing
 * repo is left alone. On first init it runs `git init -b main`, writes a store
 * `.gitignore`, and makes a baseline `agentenv: initialise store` commit so a
 * later `remote` connect has history to push. Never touches the network.
 *
 * The store dir must already exist (callers run `ensureStore` first).
 */
export async function ensureStoreRepo(
  paths: Paths,
  env: NodeJS.ProcessEnv,
  run?: GitRunner,
): Promise<{ initialised: boolean }> {
  const ctx = gitContext(paths, env, run);
  if (await storeIsRepo(paths)) return { initialised: false };

  const init = await git(ctx, ['init', '-b', 'main']);
  if (init.code !== 0) {
    // A git that predates `-b` (<2.28) — fall back and rename the branch.
    const plain = await git(ctx, ['init']);
    if (plain.code !== 0) {
      throw new Error(`agentenv: could not git-init the store (${firstLine(init.stderr || plain.stderr)})`);
    }
    await git(ctx, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  }

  const ignore = join(paths.store, '.gitignore');
  if (!(await pathExists(ignore))) {
    await writeFileAtomic(ignore, STORE_GITIGNORE);
  }

  // Baseline commit so `remote` (empty-repo connect) has history to push.
  if (!(await hasCommits(ctx))) {
    const identity = await resolveGitIdentity(ctx);
    await git(ctx, ['add', '-A']);
    const staged = await git(ctx, ['diff', '--cached', '--name-only']);
    if (staged.stdout.trim() !== '') {
      await git(ctx, [...commitArgs(identity), 'commit', '-m', 'agentenv: initialise store', '--no-verify']);
    }
  }
  return { initialised: true };
}

// ---------------------------------------------------------------------------
// Remote
// ---------------------------------------------------------------------------

/** The configured `origin` URL, or `null` when no remote is set / not a repo. */
export async function getRemoteUrl(paths: Paths, env: NodeJS.ProcessEnv, run?: GitRunner): Promise<string | null> {
  if (!(await storeIsRepo(paths))) return null;
  const ctx = gitContext(paths, env, run);
  const res = await git(ctx, ['remote', 'get-url', 'origin']);
  if (res.code !== 0) return null;
  const url = res.stdout.trim();
  return url !== '' ? url : null;
}

/** Add `origin` pointing at `url` (no network). */
export async function addRemote(paths: Paths, env: NodeJS.ProcessEnv, url: string, run?: GitRunner): Promise<void> {
  const ctx = gitContext(paths, env, run);
  const res = await git(ctx, ['remote', 'add', 'origin', url]);
  if (res.code !== 0) throw new Error(`agentenv: could not add remote (${firstLine(res.stderr)})`);
}

/** Remove `origin` (used to back out of a connect that must not proceed). */
export async function removeRemote(paths: Paths, env: NodeJS.ProcessEnv, run?: GitRunner): Promise<void> {
  const ctx = gitContext(paths, env, run);
  await git(ctx, ['remote', 'remove', 'origin']);
}

/** What a `git ls-remote` probe of the configured remote found. */
export interface RemoteProbe {
  status: 'empty' | 'nonempty' | 'unreachable';
  detail?: string;
}

/**
 * Probe the configured remote with `git ls-remote` (short timeout): does it exist
 * and does it already have refs? Used by `agentenv remote` to distinguish the
 * empty-repo first-connect case (this task) from a non-empty remote whose
 * same/related/unrelated CLASSIFICATION is Task 2.3.
 */
export async function probeRemote(
  paths: Paths,
  env: NodeJS.ProcessEnv,
  opts: { run?: GitRunner; timeoutMs?: number } = {},
): Promise<RemoteProbe> {
  const ctx = gitContext(paths, env, opts.run);
  const res = await git(ctx, ['ls-remote', 'origin'], opts.timeoutMs ?? PULL_TIMEOUT_MS);
  if (res.code !== 0 || res.timedOut) {
    return { status: 'unreachable', detail: res.timedOut ? 'network timeout' : redactRemoteUrl(firstLine(res.stderr)) };
  }
  return { status: res.stdout.trim() === '' ? 'empty' : 'nonempty' };
}

/**
 * Probe an ARBITRARY url (design D14, Task 2.3) — a candidate that is NOT yet a
 * configured remote — with `git ls-remote <url>`. Unlike {@link probeRemote} (which
 * probes the configured `origin`), this never touches `origin`, so the old remote's
 * URL stays configured throughout classification (the flip is the LAST step). No
 * refs ⇒ `empty`; refs present ⇒ `nonempty`; a transport failure ⇒ `unreachable`
 * with a credential-redacted detail.
 */
export async function probeRemoteUrl(
  paths: Paths,
  env: NodeJS.ProcessEnv,
  url: string,
  opts: { run?: GitRunner; timeoutMs?: number } = {},
): Promise<RemoteProbe> {
  const ctx = gitContext(paths, env, opts.run);
  const res = await git(ctx, ['ls-remote', url], opts.timeoutMs ?? PULL_TIMEOUT_MS);
  if (res.code !== 0 || res.timedOut) {
    return { status: 'unreachable', detail: res.timedOut ? 'network timeout' : redactRemoteUrl(firstLine(res.stderr)) };
  }
  return { status: res.stdout.trim() === '' ? 'empty' : 'nonempty' };
}

// ---------------------------------------------------------------------------
// New-machine bootstrap: clone a populated remote into the store (design D14)
// ---------------------------------------------------------------------------

/** A generous clone budget — a full store clone can move more than a 3s probe. */
const CLONE_TIMEOUT_MS = 30_000;

/** The outcome of a {@link cloneStore} bootstrap. */
export interface CloneResult {
  /**
   * `ok` — the populated remote was cloned into the store (`origin` set to `url`);
   * `empty` — the remote has no history to clone (caller inits empty + connects);
   * `unreachable` — a transport failure or timeout (caller inits empty + connects).
   */
  status: 'ok' | 'empty' | 'unreachable';
  detail?: string;
}

/**
 * Clone a POPULATED remote into the store directory — the clean-machine restore
 * bootstrap (design D14, spec criterion 5). A fresh machine with no local store
 * must CLONE an existing remote, not init-empty-then-classify: a fresh empty local
 * plus a populated remote would classify as UNRELATED and refuse to integrate.
 *
 * The store directory MUST NOT yet exist as a git repo (`git clone` refuses a
 * non-empty target). Probes first, so an empty or unreachable remote returns a
 * status the caller can fall back on (init an empty store, connect the remote) with
 * a clear message rather than a confusing clone error. On success `origin` points at
 * `url` and the full store history is present. Offline-safe and credential-safe: the
 * probe/clone never prompt for credentials and any error detail is URL-redacted.
 */
export async function cloneStore(
  paths: Paths,
  env: NodeJS.ProcessEnv,
  url: string,
  opts: { run?: GitRunner; timeoutMs?: number } = {},
): Promise<CloneResult> {
  const ctx = gitContext(paths, env, opts.run);
  // The base must exist so `git ls-remote`/`git clone` have an existing cwd — the
  // store dir does NOT exist yet on a fresh machine, so we can't run git from it.
  await mkdir(paths.base, { recursive: true });

  // Probe first (from `base`, not the not-yet-existent store): an empty/unreachable
  // remote has nothing (useful) to clone.
  const probe = await ctx.run(['ls-remote', url], {
    cwd: paths.base,
    env: ctx.env,
    timeoutMs: opts.timeoutMs ?? PULL_TIMEOUT_MS,
  });
  if (probe.code !== 0 || probe.timedOut) {
    return { status: 'unreachable', detail: probe.timedOut ? 'network timeout' : redactRemoteUrl(firstLine(probe.stderr)) };
  }
  if (probe.stdout.trim() === '') return { status: 'empty' };

  const res = await ctx.run(['clone', url, paths.store], {
    cwd: paths.base,
    env: ctx.env,
    timeoutMs: opts.timeoutMs ?? CLONE_TIMEOUT_MS,
  });
  if (res.code !== 0 || res.timedOut) {
    return {
      status: 'unreachable',
      detail: res.timedOut ? 'network timeout' : redactRemoteUrl(firstLine(res.stderr)),
    };
  }
  return { status: 'ok' };
}

// ---------------------------------------------------------------------------
// Safe remote replacement classification (design D14, Task 2.3)
// ---------------------------------------------------------------------------

/**
 * The private, machine-local ref namespace a candidate remote's heads are fetched
 * into during classification. It is NEVER `origin` (which stays pointed at the OLD
 * remote until the final flip) and never a branch, so it cannot pollute `git log`
 * of `HEAD` or the store's own branches. {@link cleanupCandidateRefs} deletes it.
 */
const CANDIDATE_REF_NS = 'refs/agentenv-candidate';

/** How a candidate remote's history relates to the local store (design D14). */
export type RemoteHistoryClass = 'empty' | 'related' | 'unrelated' | 'unreachable';

export interface RemoteClassification {
  status: RemoteHistoryClass;
  /**
   * For `related`/`unrelated`: the local temp ref the candidate's integrate/adopt
   * branch was fetched to (offline after this point — no second network round-trip).
   */
  candidateRef?: string;
  detail?: string;
}

/** List the private candidate refs currently on disk. */
async function listCandidateRefs(ctx: GitContext): Promise<string[]> {
  const res = await git(ctx, ['for-each-ref', '--format=%(refname)', CANDIDATE_REF_NS]);
  return res.stdout.split('\n').map((s) => s.trim()).filter((s) => s !== '');
}

/**
 * Delete every private candidate ref (design D14, Task 2.3). Called in a `finally`
 * by the command so classification never leaves temp refs behind — win, lose, or
 * throw. Safe to call when none exist.
 */
export async function cleanupCandidateRefs(paths: Paths, env: NodeJS.ProcessEnv, run?: GitRunner): Promise<void> {
  const ctx = gitContext(paths, env, run);
  for (const ref of await listCandidateRefs(ctx)) {
    await git(ctx, ['update-ref', '-d', ref]);
  }
}

/**
 * Classify a candidate remote's history relative to the local store (design D14):
 *
 * 1. `git ls-remote <url>` — a transport failure ⇒ `unreachable` (change nothing);
 *    no refs ⇒ `empty`.
 * 2. Otherwise `git fetch <url>` the candidate's heads into the private {@link
 *    CANDIDATE_REF_NS} namespace (NOT `origin`), then `git merge-base HEAD <ref>`
 *    against each: a shared commit ⇒ `related` (integrable); none ⇒ `unrelated`.
 *
 * Everything runs against the explicit `url`, so `origin` — the OLD remote — is never
 * touched here; the flip is the final step after the chosen action succeeds. The
 * fetched candidate ref is returned so a `related` integrate / `unrelated` adopt can
 * work offline from it. The caller MUST {@link cleanupCandidateRefs} afterwards.
 */
export async function classifyRemoteHistory(
  paths: Paths,
  env: NodeJS.ProcessEnv,
  url: string,
  opts: { run?: GitRunner; timeoutMs?: number } = {},
): Promise<RemoteClassification> {
  const ctx = gitContext(paths, env, opts.run);
  const timeoutMs = opts.timeoutMs ?? PULL_TIMEOUT_MS;

  const probe = await probeRemoteUrl(paths, env, url, { ...(opts.run ? { run: opts.run } : {}), timeoutMs });
  if (probe.status === 'unreachable') return { status: 'unreachable', ...(probe.detail ? { detail: probe.detail } : {}) };
  if (probe.status === 'empty') return { status: 'empty' };

  // Non-empty: fetch the candidate's heads into the private namespace. `+…` force-
  // updates only these LOCAL tracking refs (never a force-PUSH). --no-tags keeps it
  // to branches, which is all a store history classification cares about.
  await cleanupCandidateRefs(paths, env, opts.run); // clear any stale temp refs first
  const fetch = await git(ctx, ['fetch', '--no-tags', url, `+refs/heads/*:${CANDIDATE_REF_NS}/*`], timeoutMs);
  if (fetch.code !== 0 || fetch.timedOut) {
    await cleanupCandidateRefs(paths, env, opts.run);
    return { status: 'unreachable', detail: fetch.timedOut ? 'network timeout' : redactRemoteUrl(firstLine(fetch.stderr)) };
  }

  const refs = await listCandidateRefs(ctx);
  if (refs.length === 0) {
    // Non-empty by ls-remote yet no heads fetched (a tags-only remote): nothing to
    // integrate/adopt. Treat as unrelated with no candidate ref — the command refuses.
    return { status: 'unrelated' };
  }
  const branch = await currentBranch(ctx);
  const preferred = `${CANDIDATE_REF_NS}/${branch}`;
  const candidateRef = refs.includes(preferred) ? preferred : refs[0]!;

  const mb = await git(ctx, ['merge-base', 'HEAD', candidateRef]);
  const related = mb.code === 0 && mb.stdout.trim() !== '';
  return { status: related ? 'related' : 'unrelated', candidateRef };
}

/** Outcome of a {@link pushUrl}. NEVER force: a `rejected` is surfaced, never forced. */
export interface PushUrlResult {
  status: 'ok' | 'rejected' | 'unreachable' | 'nothing';
  detail?: string;
}

/**
 * Push the local branch to an explicit `url` with a NORMAL, non-force push (design
 * D14): `git push <url> <branch>:<branch>` — no `--force`, no `+refspec`, so a
 * concurrent first push that would need a force LOSES the race safely (`rejected`)
 * rather than clobbering the remote. Pushes to the url directly, never via `origin`,
 * so the OLD remote stays configured until the caller flips it after this succeeds.
 */
export async function pushUrl(
  paths: Paths,
  env: NodeJS.ProcessEnv,
  url: string,
  opts: { run?: GitRunner; timeoutMs?: number } = {},
): Promise<PushUrlResult> {
  const ctx = gitContext(paths, env, opts.run);
  if (!(await hasCommits(ctx))) return { status: 'nothing' };
  const branch = await currentBranch(ctx);
  const res = await git(ctx, ['push', url, `${branch}:${branch}`], opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (res.code === 0) return { status: 'ok' };
  const blob = `${res.stdout}\n${res.stderr}`;
  if (res.timedOut) return { status: 'unreachable', detail: 'network timeout' };
  if (/\[rejected\]|non-fast-forward|fetch first|Updates were rejected/i.test(blob)) {
    return { status: 'rejected', detail: redactRemoteUrl(firstLine(res.stderr)) || 'push rejected (non-fast-forward)' };
  }
  if (/could not read|unable to access|Could not resolve host|Connection|repository .* not found|does not appear to be a git repository|No such file/i.test(blob)) {
    return { status: 'unreachable', detail: redactRemoteUrl(firstLine(res.stderr)) };
  }
  return { status: 'rejected', detail: redactRemoteUrl(firstLine(res.stderr)) || 'push failed' };
}

/** Push one already-validated revision to the current branch at an explicit URL. */
export async function pushRevisionUrl(
  paths: Paths,
  env: NodeJS.ProcessEnv,
  url: string,
  revision: string,
  opts: { run?: GitRunner; timeoutMs?: number } = {},
): Promise<PushUrlResult> {
  const ctx = gitContext(paths, env, opts.run);
  const branch = await currentBranch(ctx);
  const res = await git(
    ctx,
    ['push', url, `${revision}:refs/heads/${branch}`],
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (res.code === 0) return { status: 'ok' };
  const blob = `${res.stdout}\n${res.stderr}`;
  if (res.timedOut) return { status: 'unreachable', detail: 'network timeout' };
  if (/\[rejected\]|non-fast-forward|fetch first|Updates were rejected/i.test(blob)) {
    return { status: 'rejected', detail: redactRemoteUrl(firstLine(res.stderr)) || 'push rejected (non-fast-forward)' };
  }
  if (/could not read|unable to access|Could not resolve host|Connection|repository .* not found|does not appear to be a git repository|No such file/i.test(blob)) {
    return { status: 'unreachable', detail: redactRemoteUrl(firstLine(res.stderr)) };
  }
  return { status: 'rejected', detail: redactRemoteUrl(firstLine(res.stderr)) || 'push failed' };
}

export interface PreparedRelatedCandidate {
  status: 'ok' | 'conflict' | 'error';
  revision?: string;
  preparedRef?: string;
  detail?: string;
}

/** Rebase in a detached private worktree. Canonical HEAD and its worktree remain
 * untouched until the remote replacement transaction publishes the result. */
export async function prepareRelatedCandidate(
  paths: Paths,
  env: NodeJS.ProcessEnv,
  candidateRef: string,
  opts: { run?: GitRunner } = {},
): Promise<PreparedRelatedCandidate> {
  const ctx = gitContext(paths, env, opts.run);
  const id = randomUUID();
  const worktree = join(paths.live, 'remote-preparations', id);
  const preparedRef = `refs/agentenv-prepared/${id}`;
  await mkdir(dirname(worktree), { recursive: true });
  const added = await git(ctx, ['worktree', 'add', '--detach', worktree, 'HEAD']);
  if (added.code !== 0) return { status: 'error', detail: 'could not construct isolated integration worktree' };
  try {
    const identity = await resolveGitIdentity(ctx);
    const rebaseEnv: NodeJS.ProcessEnv = {
      ...env,
      GIT_EDITOR: 'true',
      GIT_SEQUENCE_EDITOR: 'true',
    };
    const rebased = await ctx.run([...commitArgs(identity), 'rebase', candidateRef], {
      cwd: worktree,
      env: rebaseEnv,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    if (rebased.code !== 0) {
      await ctx.run(['rebase', '--abort'], { cwd: worktree, env, timeoutMs: DEFAULT_TIMEOUT_MS });
      const blob = `${rebased.stdout}\n${rebased.stderr}`;
      return /CONFLICT|could not apply|needs merge|Resolve all conflicts/i.test(blob)
        ? { status: 'conflict', detail: 'store history diverged from the candidate remote' }
        : { status: 'error', detail: redactRemoteUrl(firstLine(rebased.stderr)) || 'integration failed' };
    }
    const head = await ctx.run(['rev-parse', '--verify', 'HEAD'], {
      cwd: worktree,
      env,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    const revision = head.stdout.trim();
    if (head.code !== 0 || revision === '') return { status: 'error', detail: 'could not identify prepared revision' };
    const retained = await git(ctx, ['update-ref', preparedRef, revision]);
    if (retained.code !== 0) return { status: 'error', detail: 'could not retain prepared revision' };
    return { status: 'ok', revision, preparedRef };
  } finally {
    await git(ctx, ['worktree', 'remove', '--force', worktree]);
    await rm(worktree, { recursive: true, force: true });
    await git(ctx, ['worktree', 'prune']);
  }
}

export async function deletePreparedRemoteRef(
  paths: Paths,
  env: NodeJS.ProcessEnv,
  ref: string,
  run?: GitRunner,
): Promise<void> {
  const ctx = gitContext(paths, env, run);
  await git(ctx, ['update-ref', '-d', ref]);
}

/** Set `origin` during a durable remote cutover. `set-url` when it exists;
 * `add` on first connect. This only writes local Git config. */
export async function setRemoteUrl(paths: Paths, env: NodeJS.ProcessEnv, url: string, run?: GitRunner): Promise<void> {
  const ctx = gitContext(paths, env, run);
  const res = await git(ctx, ['remote', 'set-url', 'origin', url]);
  if (res.code === 0) return;
  const add = await git(ctx, ['remote', 'add', 'origin', url]);
  if (add.code !== 0) {
    throw new Error(`agentenv: could not set remote url (${firstLine(res.stderr || add.stderr)})`);
  }
}

/** The local `HEAD` commit sha (for a save-point the caller can roll back to), or `null`. */
export async function headCommit(paths: Paths, env: NodeJS.ProcessEnv, run?: GitRunner): Promise<string | null> {
  const ctx = gitContext(paths, env, run);
  const res = await git(ctx, ['rev-parse', '--verify', 'HEAD']);
  return res.code === 0 && res.stdout.trim() !== '' ? res.stdout.trim() : null;
}

/** `git reset --hard <ref>` — restore/adopt the working branch to an exact commit or ref. */
export async function resetHardTo(paths: Paths, env: NodeJS.ProcessEnv, ref: string, run?: GitRunner): Promise<GitRunResult> {
  const ctx = gitContext(paths, env, run);
  return git(ctx, ['reset', '--hard', ref]);
}

/** Outcome of an {@link integrateCandidate}. A CONFLICT is aborted, never auto-resolved. */
export interface IntegrateResult {
  status: 'ok' | 'conflict' | 'error';
  detail?: string;
}

/**
 * Integrate a RELATED candidate history into the local store (design D14): `git
 * rebase <candidateRef>` replays the local-only commits on top of the candidate's
 * history, so afterwards the local branch is a fast-forward of the candidate (a
 * non-force push then sends it back). The candidate ref was already fetched during
 * classification, so this is offline.
 *
 * NEVER auto-resolves: a rebase left mid-flight (a conflict, or any apply failure) is
 * `--abort`ed so the pre-rebase local state is fully restored — leaving the OLD url
 * configured and every local commit intact. A conflict is reported so the caller can
 * refuse and point the user at the manual resolve (Task 2.2's `sync --resolve` seam).
 * Identity/signing are pinned exactly like {@link commitStore}, and the editor is
 * disabled so the replay is non-interactive.
 */
export async function integrateCandidate(
  paths: Paths,
  env: NodeJS.ProcessEnv,
  candidateRef: string,
  opts: { run?: GitRunner } = {},
): Promise<IntegrateResult> {
  const ctx = gitContext(paths, env, opts.run);
  const identity = await resolveGitIdentity(ctx);
  const rebaseEnv: NodeJS.ProcessEnv = { ...env, GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' };
  const res = await ctx.run([...commitArgs(identity), 'rebase', candidateRef], {
    cwd: paths.store,
    env: rebaseEnv,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
  if (res.code === 0) return { status: 'ok' };

  const blob = `${res.stdout}\n${res.stderr}`;
  // A rebase left in-progress means a conflict (or another apply failure). Abort to
  // restore the exact pre-rebase local state — never leave a half-rebased tree.
  if (await rebaseInProgress(paths)) {
    await git(ctx, ['rebase', '--abort']);
    if (/CONFLICT|could not apply|needs merge|Resolve all conflicts/i.test(blob)) {
      return { status: 'conflict', detail: 'store history diverged from the candidate remote' };
    }
  }
  return { status: 'error', detail: redactRemoteUrl(firstLine(res.stderr)) || 'integration failed' };
}

/** Where recoverable pre-adoption store archives land (design D14): beside the store,
 *  under `~/.agentenv/archives/`, NEVER inside the store repo (so it never syncs). */
export function archivesDir(paths: Paths): string {
  return join(paths.base, 'archives');
}

/** Outcome of an {@link archiveStore}. `path` is the recoverable copy on success. */
export interface ArchiveResult {
  status: 'ok' | 'error';
  path?: string;
  detail?: string;
}

/**
 * Archive the ENTIRE local store — working tree AND `.git` (so every local commit is
 * recoverable) — to a timestamped copy under {@link archivesDir} before an
 * unrelated-remote adoption discards it (design D14, spec criterion 8). NEVER
 * destructive: it only copies. A copy failure returns `error` so the caller aborts
 * BEFORE touching local content — nothing is lost, nothing changed. The archive sits
 * beside the store, never inside it, so it is never synced.
 */
export async function archiveStore(paths: Paths, opts: { now?: () => number } = {}): Promise<ArchiveResult> {
  const stamp = new Date((opts.now ?? Date.now)()).toISOString().replace(/[:.]/g, '-');
  const dest = join(archivesDir(paths), `store-${stamp}`);
  try {
    await mkdir(archivesDir(paths), { recursive: true });
    await cp(paths.store, dest, { recursive: true });
    return { status: 'ok', path: dest };
  } catch (err) {
    return { status: 'error', detail: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Commit (with pre-commit secret scan)
// ---------------------------------------------------------------------------

/** Outcome of a {@link commitStore}. */
export interface CommitResult {
  status: 'committed' | 'nothing' | 'blocked' | 'no-repo' | 'rebase-in-progress';
  /** Secret findings when `status === 'blocked'`. */
  findings?: SecretFinding[];
  /** Exact HEAD created or observed for an idempotent scoped step. */
  commitId?: string;
}

/**
 * Stage everything in the store and commit it under `message`, after a pre-commit
 * secret scan of the STAGED DIFF (D6/D9). A clean tree is a `nothing` no-op. A
 * secret in what is being committed BLOCKS the commit (findings returned, staging
 * reset) rather than writing a leak into history — but a pre-existing, unrelated
 * flagged file elsewhere in the tree never blocks an unrelated commit, and a
 * documented example / `agentenv:allow-secret`-marked line is exempt. No-op
 * (`no-repo`) when the store is not a git repo.
 *
 * Belt-and-suspenders (D9, Task 2.2, criterion 11 "never auto-resolve"): NEVER
 * touch the index during a HELD rebase. A `sync --resolve` deliberately leaves a
 * real `git rebase` in progress across invocations (the manual two-step); the
 * conflicted `env.yaml` on disk still carries `<<<<<<< / ======= / >>>>>>>`
 * markers. A `git add -A && git commit` here would stage that marker-laden tree and
 * commit garbage — which then pushes to the shared remote (permanent history
 * pollution). So refuse (`rebase-in-progress`) and let ONLY `sync --resolve` /
 * `--abort` ever advance a held rebase.
 */
export async function commitStore(
  paths: Paths,
  env: NodeJS.ProcessEnv,
  message: string,
  run?: GitRunner,
): Promise<CommitResult> {
  if (!(await storeIsRepo(paths))) return { status: 'no-repo' };
  if (await rebaseInProgress(paths)) return { status: 'rebase-in-progress' };
  const ctx = gitContext(paths, env, run);

  await git(ctx, ['add', '-A']);
  const staged = await git(ctx, ['diff', '--cached', '--name-only']);
  if (staged.stdout.trim() === '') return { status: 'nothing' };

  const findings = await scanStagedForSecrets(ctx, paths);
  if (findings.length > 0) {
    await git(ctx, ['reset']); // unstage — never leave a secret staged
    return { status: 'blocked', findings };
  }

  const identity = await resolveGitIdentity(ctx);
  const res = await git(ctx, [...commitArgs(identity), 'commit', '-m', message, '--no-verify']);
  if (res.code !== 0) {
    throw new Error(`agentenv: git commit failed (${firstLine(res.stderr)})`);
  }
  return { status: 'committed' };
}

/** Commit exactly the declared store paths while preserving unrelated dirty or
 * staged content. Repeating the same completed step is a `nothing` no-op, which
 * makes post-commit command-WAL recovery idempotent. */
export async function commitStorePaths(
  paths: Paths,
  env: NodeJS.ProcessEnv,
  message: string,
  absolutePaths: readonly string[],
  run?: GitRunner,
): Promise<CommitResult> {
  if (!(await storeIsRepo(paths))) return { status: 'no-repo' };
  if (await rebaseInProgress(paths)) return { status: 'rebase-in-progress' };
  const store = resolve(paths.store);
  const relativePaths = absolutePaths.map((path) => {
    const rel = relative(store, resolve(path));
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) {
      throw new Error(`declared Git path is outside the canonical store: ${path}`);
    }
    return rel.split(sep).join('/');
  });
  if (relativePaths.length === 0) throw new Error('at least one scoped Git path is required');
  const unique = [...new Set(relativePaths)];
  const ctx = gitContext(paths, env, run);

  await git(ctx, ['add', '-A', '--', ...unique]);
  const staged = await git(ctx, ['diff', '--cached', '--name-only', '--', ...unique]);
  if (staged.stdout.trim() === '') {
    const head = await git(ctx, ['rev-parse', '--verify', 'HEAD']);
    return {
      status: 'nothing',
      ...(head.code === 0 && head.stdout.trim() !== '' ? { commitId: head.stdout.trim() } : {}),
    };
  }

  const findings = await scanStagedForSecrets(ctx, paths, unique);
  if (findings.length > 0) {
    await git(ctx, ['reset', '--', ...unique]);
    return { status: 'blocked', findings };
  }

  const identity = await resolveGitIdentity(ctx);
  const res = await git(ctx, [
    ...commitArgs(identity),
    'commit',
    '--only',
    '-m',
    message,
    '--no-verify',
    '--',
    ...unique,
  ]);
  if (res.code !== 0) {
    throw new Error(`agentenv: git commit failed (${firstLine(res.stderr)})`);
  }
  const head = await git(ctx, ['rev-parse', '--verify', 'HEAD']);
  if (head.code !== 0 || head.stdout.trim() === '') {
    throw new Error('agentenv: committed scoped paths but could not record the resulting commit identity');
  }
  return { status: 'committed', commitId: head.stdout.trim() };
}

// ---------------------------------------------------------------------------
// Push queue (machine-local; NEVER synced — lives beside the store, not in it)
// ---------------------------------------------------------------------------

/** The machine-local push-retry queue file (design D9). Never enters the store. */
export function pushQueuePath(paths: Paths): string {
  return join(paths.base, 'push-queue.json');
}

/** The queued-push marker shape. A queued push means "commits await a reachable remote". */
export interface PushQueue {
  pending: boolean;
  since: number;
  lastError?: string;
}

/** Read the push queue; a missing/corrupt file reads as "nothing queued". */
export async function readPushQueue(paths: Paths): Promise<PushQueue> {
  try {
    const text = await readFile(pushQueuePath(paths), 'utf8');
    const raw = JSON.parse(text) as Partial<PushQueue>;
    return { pending: raw.pending === true, since: typeof raw.since === 'number' ? raw.since : 0, ...(typeof raw.lastError === 'string' ? { lastError: raw.lastError } : {}) };
  } catch {
    return { pending: false, since: 0 };
  }
}

/** Whether a push is currently queued for retry. */
export async function isPushQueued(paths: Paths): Promise<boolean> {
  return (await readPushQueue(paths)).pending;
}

async function enqueuePush(paths: Paths, error: string, now: number): Promise<void> {
  const existing = await readPushQueue(paths);
  const queue: PushQueue = {
    pending: true,
    since: existing.pending && existing.since > 0 ? existing.since : now,
    lastError: error,
  };
  await writeFileAtomic(pushQueuePath(paths), `${JSON.stringify(queue, null, 2)}\n`);
}

async function clearPushQueue(paths: Paths): Promise<void> {
  await rm(pushQueuePath(paths), { force: true });
}

// ---------------------------------------------------------------------------
// Conflict marker (machine-local; NEVER synced — a divergence is THIS machine's)
// ---------------------------------------------------------------------------

/**
 * The machine-local rebase-conflict marker (design D9, Task 2.2). A pull that hits a
 * rebase conflict is `--abort`ed by 2.1 so the working tree stays usable, which
 * means the conflict state is NOT left on disk as an in-progress rebase — so we
 * persist this marker instead. It lets `agentenv status` surface "sync blocked" and
 * tells the user to run `agentenv sync --resolve`. It sits beside the store (never
 * inside it), so a divergence — which is local to THIS machine — is never synced.
 */
export function conflictMarkerPath(paths: Paths): string {
  return join(paths.base, 'sync-conflict.json');
}

/** The persisted conflict marker. `pending` true means "a pull is blocked by a rebase conflict". */
export interface ConflictMarker {
  pending: boolean;
  since: number;
  detail?: string;
}

/** Read the conflict marker; a missing/corrupt file reads as "no conflict". */
export async function readConflictMarker(paths: Paths): Promise<ConflictMarker> {
  try {
    const text = await readFile(conflictMarkerPath(paths), 'utf8');
    const raw = JSON.parse(text) as Partial<ConflictMarker>;
    return {
      pending: raw.pending === true,
      since: typeof raw.since === 'number' ? raw.since : 0,
      ...(typeof raw.detail === 'string' ? { detail: raw.detail } : {}),
    };
  } catch {
    return { pending: false, since: 0 };
  }
}

/** Whether a rebase conflict is currently blocking sync on this machine. */
export async function isConflictPending(paths: Paths): Promise<boolean> {
  return (await readConflictMarker(paths)).pending;
}

/** Record that a pull is blocked by a rebase conflict (idempotent; keeps the first `since`). */
export async function writeConflictMarker(paths: Paths, detail: string, now: number = Date.now()): Promise<void> {
  const existing = await readConflictMarker(paths);
  const marker: ConflictMarker = {
    pending: true,
    since: existing.pending && existing.since > 0 ? existing.since : now,
    detail,
  };
  await writeFileAtomic(conflictMarkerPath(paths), `${JSON.stringify(marker, null, 2)}\n`);
}

/** Clear the conflict marker (a clean pull, or a completed `--resolve`/`--abort`). */
export async function clearConflictMarker(paths: Paths): Promise<void> {
  await rm(conflictMarkerPath(paths), { force: true });
}

// ---------------------------------------------------------------------------
// Push (one fail-soft push per invocation; failure queues for next time)
// ---------------------------------------------------------------------------

/** Outcome of a {@link pushStore}. */
export interface PushResult {
  status: 'ok' | 'no-repo' | 'no-remote' | 'nothing' | 'queued';
  detail?: string;
}

/**
 * Push the store to its remote (design D9): ONE push per invocation, after every
 * commit. `git push` sends all unpushed commits, so this also FLUSHES a queue left
 * by a prior failed invocation. Failure is never fatal — it enqueues a retry for
 * the next invocation that reaches a reachable remote. No-op without a repo/remote.
 */
export async function pushStore(
  paths: Paths,
  env: NodeJS.ProcessEnv,
  opts: { run?: GitRunner; timeoutMs?: number; now?: () => number } = {},
): Promise<PushResult> {
  if (!(await storeIsRepo(paths))) return { status: 'no-repo' };
  const url = await getRemoteUrl(paths, env, opts.run);
  if (!url) return { status: 'no-remote' };

  const ctx = gitContext(paths, env, opts.run);
  if (!(await hasCommits(ctx))) return { status: 'nothing' };
  const branch = await currentBranch(ctx);
  const timeoutMs = opts.timeoutMs ?? PULL_TIMEOUT_MS;
  const res = await git(ctx, ['push', 'origin', branch], timeoutMs);
  if (res.code === 0) {
    await clearPushQueue(paths);
    return { status: 'ok' };
  }
  const detail = res.timedOut ? 'network timeout' : redactRemoteUrl(firstLine(res.stderr)) || 'push failed';
  await enqueuePush(paths, detail, (opts.now ?? Date.now)());
  return { status: 'queued', detail };
}

// ---------------------------------------------------------------------------
// Pull (rebase, short timeout, silently skipped offline; conflicts abort)
// ---------------------------------------------------------------------------

/** Outcome of a {@link pullRebase}. */
export interface PullResult {
  status: 'ok' | 'no-repo' | 'no-remote' | 'offline' | 'conflict' | 'nothing' | 'error';
  detail?: string;
}

/**
 * `git pull --rebase origin <branch>` with a ~3s budget (design D9). Silently
 * skipped when there is no repo/remote. Offline / unreachable → `offline` (never
 * fatal). A rebase CONFLICT is aborted (`git rebase --abort`) so the store stays
 * usable from the working tree — `agentenv sync --resolve` (Task 2.2) owns the
 * resolution UX; here we only refuse to leave a half-rebased tree.
 *
 * `opts.holdConflict` (Task 2.2 resolve path) DELIBERATELY skips that abort so the
 * conflicted rebase is left in progress for {@link continueRebase} to walk through.
 * The default stays abort-on-conflict, so every OTHER caller (the invocation
 * lifecycle) keeps the store usable exactly as in 2.1.
 */
export async function pullRebase(
  paths: Paths,
  env: NodeJS.ProcessEnv,
  opts: { run?: GitRunner; timeoutMs?: number; holdConflict?: boolean } = {},
): Promise<PullResult> {
  if (!(await storeIsRepo(paths))) return { status: 'no-repo' };
  const url = await getRemoteUrl(paths, env, opts.run);
  if (!url) return { status: 'no-remote' };

  const ctx = gitContext(paths, env, opts.run);
  if (!(await hasCommits(ctx))) return { status: 'nothing' }; // nothing local to rebase onto
  const branch = await currentBranch(ctx);
  const timeoutMs = opts.timeoutMs ?? PULL_TIMEOUT_MS;
  const res = await git(ctx, ['pull', '--rebase', 'origin', branch], timeoutMs);
  if (res.code === 0) return { status: 'ok' };

  if (res.timedOut) return { status: 'offline', detail: 'network timeout' };

  const stderr = `${res.stdout}\n${res.stderr}`;
  // A rebase left in-progress means a real conflict. By default abort to keep the
  // tree usable; `holdConflict` leaves it in progress for the guided resolve.
  if (/CONFLICT|could not apply|Resolve all conflicts|needs merge/i.test(stderr)) {
    if (!opts.holdConflict) await git(ctx, ['rebase', '--abort']);
    return { status: 'conflict', detail: 'store history diverged — run `agentenv sync --resolve`' };
  }
  // Could-not-connect / unknown host / repository-not-found → treat as offline.
  if (/could not read|unable to access|Could not resolve host|Connection|repository .* not found|does not appear to be a git repository|No such file/i.test(stderr)) {
    return { status: 'offline', detail: redactRemoteUrl(firstLine(res.stderr)) };
  }
  // Any other non-zero exit: report, but never fatal.
  return { status: 'error', detail: redactRemoteUrl(firstLine(res.stderr)) || 'pull failed' };
}

// ---------------------------------------------------------------------------
// Rebase resolution primitives (Task 2.2) — detect, list, continue, abort.
// NEVER auto-resolve: the caller injects the human's on-disk resolution.
// ---------------------------------------------------------------------------

/** One conflicted (unmerged) store file during a rebase resolution (Task 2.2). */
export interface ConflictedFile {
  /** Store-relative path (posix separators). */
  path: string;
  /** Absolute path on disk — the resolver reads/writes it to record its resolution. */
  absPath: string;
}

/**
 * Is a `git rebase` currently in progress in the store? (i.e. a conflict is being
 * HELD for resolution — see {@link pullRebase} `holdConflict`). Cheap fs check for
 * the state dirs git leaves under `.git/` mid-rebase.
 */
export async function rebaseInProgress(paths: Paths): Promise<boolean> {
  const gitDir = join(paths.store, '.git');
  return (await pathExists(join(gitDir, 'rebase-merge'))) || (await pathExists(join(gitDir, 'rebase-apply')));
}

/** The store's currently-unmerged files (`git diff --diff-filter=U`), for the walkthrough. */
export async function listConflictedFiles(
  paths: Paths,
  env: NodeJS.ProcessEnv,
  run?: GitRunner,
): Promise<ConflictedFile[]> {
  const ctx = gitContext(paths, env, run);
  const res = await git(ctx, ['diff', '--name-only', '--diff-filter=U', '-z']);
  return res.stdout
    .split('\0')
    .filter((n) => n !== '')
    .map((rel) => ({ path: rel, absPath: join(paths.store, ...rel.split('/')) }));
}

/**
 * Stage the (human-)resolved working tree and `git rebase --continue` (Task 2.2).
 * The editor is disabled (`GIT_EDITOR=true`) so the replayed commit keeps its
 * message non-interactively, and identity/signing are pinned exactly like {@link
 * commitStore}. If the resolution left the patch empty (the user resolved identical
 * to upstream), continue would error "no changes" — we `--skip` that commit instead.
 * NEVER auto-resolves: it only stages what the caller's resolver already wrote.
 */
export async function continueRebase(
  paths: Paths,
  env: NodeJS.ProcessEnv,
  run?: GitRunner,
): Promise<GitRunResult> {
  const ctx = gitContext(paths, env, run);
  const identity = await resolveGitIdentity(ctx);
  await git(ctx, ['add', '-A']); // mark the resolved paths resolved
  const contEnv: NodeJS.ProcessEnv = { ...env, GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' };
  const res = await ctx.run([...commitArgs(identity), 'rebase', '--continue'], {
    cwd: paths.store,
    env: contEnv,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
  if (res.code !== 0 && /no changes|nothing to commit|patch is empty/i.test(`${res.stdout}\n${res.stderr}`)) {
    return ctx.run(['rebase', '--skip'], { cwd: paths.store, env: contEnv, timeoutMs: DEFAULT_TIMEOUT_MS });
  }
  return res;
}

/** Abort an in-progress rebase (`git rebase --abort`) — restores the pre-rebase local state. */
export async function abortRebase(paths: Paths, env: NodeJS.ProcessEnv, run?: GitRunner): Promise<GitRunResult> {
  const ctx = gitContext(paths, env, run);
  return git(ctx, ['rebase', '--abort']);
}

// ---------------------------------------------------------------------------
// Post-pull safeguards: schema-validate + secret-scan, and manifest reconcile
// ---------------------------------------------------------------------------

/** The verdict on a freshly-pulled store tree (D9). */
export interface PulledStoreValidation {
  ok: boolean;
  /** Malformed-manifest problems (schema validation). */
  schemaProblems: string[];
  /** Secret findings anywhere in the pulled tree. */
  secretFindings: SecretFinding[];
}

/**
 * Validate a pulled store tree before anything materialises (design D9): every
 * `environments/<env>/env.yaml` must parse against the schema, and the whole tree
 * is secret-scanned. A malformed or secret-bearing tree is `ok: false` — the
 * caller QUARANTINES it (reports + does not materialise) rather than trusting a
 * shared input.
 */
export async function validatePulledStore(paths: Paths): Promise<PulledStoreValidation> {
  const schemaProblems: string[] = [];
  let envNames: string[];
  try {
    const entries = await readdir(paths.environments, { withFileTypes: true });
    envNames = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    envNames = [];
  }
  for (const name of envNames) {
    const file = paths.envYaml(name);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      schemaProblems.push(`environment '${name}' has no env.yaml`);
      continue;
    }
    try {
      parseEnvConfig(text, file);
    } catch (err) {
      schemaProblems.push((err as Error).message);
    }
  }
  const secretFindings = await scanStoreForSecrets(paths);
  return { ok: schemaProblems.length === 0 && secretFindings.length === 0, schemaProblems, secretFindings };
}

/**
 * Validate a fetched remote ref in a detached private worktree before remote
 * bootstrap/replacement can integrate or adopt it. Both its final tree and all
 * history not already shared with local HEAD are scanned.
 */
export async function validateRemoteCandidate(
  paths: Paths,
  env: NodeJS.ProcessEnv,
  candidateRef: string,
  run?: GitRunner,
): Promise<PulledStoreValidation> {
  const ctx = gitContext(paths, env, run);
  const worktree = join(paths.live, 'remote-candidates', randomUUID());
  await mkdir(join(paths.live, 'remote-candidates'), { recursive: true });
  const added = await git(ctx, ['worktree', 'add', '--detach', worktree, candidateRef]);
  if (added.code !== 0) {
    return {
      ok: false,
      schemaProblems: ['could not construct an isolated remote candidate worktree'],
      secretFindings: [],
    };
  }
  try {
    const candidatePaths: Paths = {
      ...paths,
      store: worktree,
      environments: join(worktree, 'environments'),
      storeReadme: join(worktree, 'README.md'),
      envDir: (name: string) => join(worktree, 'environments', name),
      envYaml: (name: string) => join(worktree, 'environments', name, 'env.yaml'),
    };
    const tree = await validatePulledStore(candidatePaths);
    const revisionResult = await git(ctx, ['rev-parse', '--verify', candidateRef]);
    if (revisionResult.code !== 0 || revisionResult.stdout.trim() === '') {
      return {
        ok: false,
        schemaProblems: [...tree.schemaProblems, 'could not identify the remote candidate revision'],
        secretFindings: tree.secretFindings,
      };
    }
    const mergeBase = await git(ctx, ['merge-base', 'HEAD', candidateRef]);
    const base = mergeBase.code === 0 && mergeBase.stdout.trim() !== ''
      ? mergeBase.stdout.trim()
      : null;
    const historyFindings = await scanRevisionRangeForSecrets(
      paths,
      env,
      base,
      revisionResult.stdout.trim(),
      run,
    );
    const secretFindings = [...tree.secretFindings, ...historyFindings];
    return {
      ok: tree.schemaProblems.length === 0 && secretFindings.length === 0,
      schemaProblems: tree.schemaProblems,
      secretFindings,
    };
  } finally {
    await git(ctx, ['worktree', 'remove', '--force', worktree]);
    await rm(worktree, { recursive: true, force: true });
    await git(ctx, ['worktree', 'prune']);
  }
}

/** A manifest-reconcile warning after a pull (D9). */
export interface ReconcileResult {
  /** Active envs whose store directory vanished remotely (deleted/renamed). */
  missingActiveEnvs: string[];
  /** Loud, doctor-pointing warnings, ready to print. */
  warnings: string[];
}

/**
 * Reconcile the local manifest against a freshly-pulled store (design D9): if an
 * environment that is ACTIVE here (materialised globally or bound in a session)
 * was deleted or renamed on another machine, its live symlinks would dangle. We
 * never silently leave them — a LOUD warning names the env and points at `doctor`
 * (the repair command itself is Task 3.3; here we detect + warn + point).
 */
export async function reconcileManifest(
  paths: Paths,
  activeEnvs: readonly string[],
): Promise<ReconcileResult> {
  const missingActiveEnvs: string[] = [];
  for (const env of activeEnvs) {
    if (!(await pathExists(paths.envDir(env)))) missingActiveEnvs.push(env);
  }
  const warnings = missingActiveEnvs.map(
    (env) =>
      `agentenv: WARNING — environment '${env}' is active on this machine but was removed from the ` +
      `store on another machine. Its materialised links now dangle. Run \`agentenv doctor\` to repair ` +
      `(restore it from git history, or drop the stale materialisation).`,
  );
  return { missingActiveEnvs, warnings };
}
