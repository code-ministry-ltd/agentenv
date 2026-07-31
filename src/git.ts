import { spawn } from 'node:child_process';
import { access, readFile, readdir, rm } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
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
 * Redact any credential in a URL before logging it (spec assumption 7): a
 * `scheme://user:secret@host/…` becomes `scheme://user:***@host/…`. scp-style
 * (`git@host:owner/repo`) and `file://` URLs carry no password and pass through.
 */
export function redactRemoteUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/@]*:)[^/@]*@/i, (_m, scheme, userColon) => {
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
 * Scan one text for suspected secrets, returning a finding per offending line.
 * Two rules, both conservative to avoid blocking legitimate commits:
 *
 * 1. **Known token shapes** — unambiguous provider prefixes/formats.
 * 2. **Secret-named assignment** — a `secret|token|password|api_key…` key set to a
 *    value that *looks real* (≥16 chars, has a letter AND a digit) and is not a
 *    `${VAR}` placeholder or an obvious fixture word.
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
async function scanStagedForSecrets(ctx: GitContext, paths: Paths): Promise<SecretFinding[]> {
  const listed = await git(ctx, ['diff', '--cached', '--name-only', '-z']);
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
    return { status: 'unreachable', detail: res.timedOut ? 'network timeout' : firstLine(res.stderr) };
  }
  return { status: res.stdout.trim() === '' ? 'empty' : 'nonempty' };
}

// ---------------------------------------------------------------------------
// Commit (with pre-commit secret scan)
// ---------------------------------------------------------------------------

/** Outcome of a {@link commitStore}. */
export interface CommitResult {
  status: 'committed' | 'nothing' | 'blocked' | 'no-repo';
  /** Secret findings when `status === 'blocked'`. */
  findings?: SecretFinding[];
}

/**
 * Stage everything in the store and commit it under `message`, after a pre-commit
 * secret scan of the STAGED DIFF (D6/D9). A clean tree is a `nothing` no-op. A
 * secret in what is being committed BLOCKS the commit (findings returned, staging
 * reset) rather than writing a leak into history — but a pre-existing, unrelated
 * flagged file elsewhere in the tree never blocks an unrelated commit, and a
 * documented example / `agentenv:allow-secret`-marked line is exempt. No-op
 * (`no-repo`) when the store is not a git repo.
 */
export async function commitStore(
  paths: Paths,
  env: NodeJS.ProcessEnv,
  message: string,
  run?: GitRunner,
): Promise<CommitResult> {
  if (!(await storeIsRepo(paths))) return { status: 'no-repo' };
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
  const detail = res.timedOut ? 'network timeout' : firstLine(res.stderr) || 'push failed';
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
 */
export async function pullRebase(
  paths: Paths,
  env: NodeJS.ProcessEnv,
  opts: { run?: GitRunner; timeoutMs?: number } = {},
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
  // A rebase left in-progress means a real conflict → abort to keep the tree usable.
  if (/CONFLICT|could not apply|Resolve all conflicts|needs merge/i.test(stderr)) {
    await git(ctx, ['rebase', '--abort']);
    return { status: 'conflict', detail: 'store history diverged — run `agentenv sync --resolve` (Task 2.2)' };
  }
  // Could-not-connect / unknown host / repository-not-found → treat as offline.
  if (/could not read|unable to access|Could not resolve host|Connection|repository .* not found|does not appear to be a git repository|No such file/i.test(stderr)) {
    return { status: 'offline', detail: firstLine(res.stderr) };
  }
  // Any other non-zero exit: report, but never fatal.
  return { status: 'error', detail: firstLine(res.stderr) || 'pull failed' };
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
