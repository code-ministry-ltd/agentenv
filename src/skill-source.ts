import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseFrontmatter } from './content-items.js';

/**
 * A resolved git skill source (design D17). `repo` is the canonical origin
 * recorded in provenance (`owner/repo` for GitHub, a `file://` URL for a local
 * repo); `cloneUrl` is what `git clone` is handed; `subpath` is the directory
 * inside the repo to scan for skills (`''` = the repo root); `ref` is the
 * requested branch/tag/sha, or undefined for the repo's default branch.
 */
export interface ParsedSkillSource {
  repo: string;
  cloneUrl: string;
  subpath: string;
  ref?: string;
}

export type ParseSkillSourceResult = ParsedSkillSource | { error: string };

/** A single subpath segment that would escape the clone (`.`/`..`) is refused. */
function validateSubpath(subpath: string, original: string): string | null {
  for (const seg of subpath.split('/')) {
    if (seg === '..' || seg === '.') {
      return `invalid source path '${original}' (path segments '.' and '..' are not allowed)`;
    }
  }
  return null;
}

/**
 * Split `owner/repo[/…]` path segments (from a URL, scp locator, or shorthand)
 * into an origin identity, clone URL and subpath. GitHub web `/{tree,blob}/<ref>/…`
 * segments are recognised and their ref honoured (an explicit `@ref` wins).
 */
function fromOwnerRepoPath(
  segments: readonly string[],
  cloneUrlFor: (owner: string, repo: string) => string,
  ref: string | undefined,
  original: string,
): ParseSkillSourceResult {
  const parts = segments.filter((s) => s !== '');
  if (parts.length < 2) {
    return { error: `invalid source '${original}' (expected owner/repo[/path][@ref])` };
  }
  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/, '');
  let rest = parts.slice(2);
  let effectiveRef = ref;
  if ((rest[0] === 'tree' || rest[0] === 'blob') && rest.length >= 2) {
    if (effectiveRef === undefined) effectiveRef = rest[1];
    rest = rest.slice(2);
  }
  const subpath = rest.join('/');
  const subpathError = validateSubpath(subpath, original);
  if (subpathError) return { error: subpathError };
  const source: ParsedSkillSource = {
    repo: `${owner}/${repo}`,
    cloneUrl: cloneUrlFor(owner, repo),
    subpath,
  };
  if (effectiveRef !== undefined) source.ref = effectiveRef;
  return source;
}

/** Is `dir` a git repository — a working tree (`.git`) or a bare repo (`HEAD`+`objects`)? */
async function isGitRepo(dir: string): Promise<boolean> {
  if (await exists(join(dir, '.git'))) return true;
  if ((await exists(join(dir, 'HEAD'))) && (await exists(join(dir, 'objects')))) return true;
  return false;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the git repository at or above `absPath` (offline, filesystem only), and
 * the subpath from that root down to `absPath`. Handles both a working tree (the
 * skill dir lives under `<root>/.git`) and a bare repo (`<root>.git`, whose
 * subpath need not exist on disk — it materialises after clone).
 */
async function resolveLocalRepo(absPath: string): Promise<{ root: string; subpath: string } | null> {
  let dir = absPath;
  const rel: string[] = [];
  for (;;) {
    if (await isGitRepo(dir)) {
      return { root: dir, subpath: rel.slice().reverse().join('/') };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    rel.push(basename(dir));
    dir = parent;
  }
}

async function resolveLocalSource(
  fileUrl: string,
  ref: string | undefined,
  original: string,
): Promise<ParseSkillSourceResult> {
  let absPath: string;
  try {
    absPath = fileURLToPath(fileUrl);
  } catch {
    return { error: `invalid file URL '${original}'` };
  }
  const found = await resolveLocalRepo(absPath);
  if (!found) {
    return {
      error:
        `no git repository found at or above '${original}' ` +
        '(the source is unreachable — nothing was changed)',
    };
  }
  const subpathError = validateSubpath(found.subpath, original);
  if (subpathError) return { error: subpathError };
  const cloneUrl = pathToFileURL(found.root).href;
  const source: ParsedSkillSource = { repo: cloneUrl, cloneUrl, subpath: found.subpath };
  if (ref !== undefined) source.ref = ref;
  return source;
}

/**
 * Resolve a skill-source argument (design D17). Accepts `owner/repo[/path][@ref]`
 * shorthand, full GitHub URLs (`https://…`, `git@github.com:…`, `ssh://…`) with
 * optional `/tree/<ref>/<path>`, and `file://` URLs pointing into a local git
 * repo (the offline-testable path). Pure apart from filesystem probing for the
 * `file://` case; never touches the network.
 */
export async function resolveSkillSource(arg: string): Promise<ParseSkillSourceResult> {
  const trimmed = arg.trim();
  if (trimmed === '') return { error: 'empty skill source' };

  // Peel a trailing `@ref` — a ref has no '/' or '@', which leaves scp hosts
  // (`git@host:…`) and bare repo URLs untouched while catching `repo@v1.2`.
  let ref: string | undefined;
  let locator = trimmed;
  const refMatch = /@([^@/]+)$/.exec(locator);
  if (refMatch) {
    ref = refMatch[1];
    locator = locator.slice(0, refMatch.index);
  }
  if (locator === '') return { error: `invalid skill source '${arg}'` };

  // scp-style: user@host:owner/repo[/path]
  const scp = /^([^@/]+)@([^:/]+):(.+)$/.exec(locator);
  if (scp) {
    const user = scp[1]!;
    const host = scp[2]!;
    const segments = scp[3]!.split('/');
    return fromOwnerRepoPath(
      segments,
      (owner, repo) => `${user}@${host}:${owner}/${repo}.git`,
      ref,
      arg,
    );
  }

  // scheme URL
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(locator);
  if (scheme) {
    const proto = scheme[1]!.toLowerCase();
    if (proto === 'file') {
      return resolveLocalSource(locator, ref, arg);
    }
    let url: URL;
    try {
      url = new URL(locator);
    } catch {
      return { error: `invalid skill source URL '${arg}'` };
    }
    const host = url.host;
    const segments = url.pathname.split('/');
    return fromOwnerRepoPath(
      segments,
      (owner, repo) => `${proto}://${host}/${owner}/${repo}.git`,
      ref,
      arg,
    );
  }

  // shorthand: owner/repo[/path]
  if (locator.includes('/')) {
    return fromOwnerRepoPath(
      locator.split('/'),
      (owner, repo) => `https://github.com/${owner}/${repo}.git`,
      ref,
      arg,
    );
  }

  return {
    error:
      `'${arg}' is not a recognised skill source ` +
      '(expected owner/repo[/path][@ref], a git URL, or an existing local skill directory)',
  };
}

/** A generous ceiling so a wedged clone can never hang an invocation forever. */
const GIT_TIMEOUT_MS = 120_000;

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run `git <args>` (optionally in `cwd`), capturing output. Never throws on a
 * non-zero exit — the caller inspects `code`. A spawn error (git missing) or a
 * timeout resolves with `code: null` and an explanatory `stderr`. */
function runGit(args: readonly string[], cwd?: string): Promise<GitResult> {
  return new Promise((resolvePromise) => {
    const child = spawn('git', [...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      stderr += '\ngit timed out';
      child.kill('SIGKILL');
    }, GIT_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({ code: null, stdout, stderr: `${stderr}${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

/** First non-empty line of git's stderr, for a compact error message. */
function firstLine(text: string): string {
  return text.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
}

/** A fetched clone (design D17): a temp checkout the caller must clean up. */
export interface FetchedSource {
  /** The temp clone directory (caller removes it when done). */
  cloneDir: string;
  /** The subpath inside the clone to scan for skills. */
  scanDir: string;
  /** Resolved HEAD commit sha. */
  commit: string;
  /** The ref that was checked out: the requested ref, or the default branch name. */
  ref: string;
}

export type FetchSkillSourceResult = FetchedSource | { error: string };

/**
 * Clone a resolved skill source into a temp dir with `git clone --depth 1`
 * (design D17): plain git, so the user's existing git auth covers private repos.
 * Honours `@ref` (a branch/tag via `--branch`, falling back to fetch+checkout for
 * an arbitrary sha). On any git failure the temp dir is removed and a clear error
 * is returned, so nothing outside the temp dir is ever touched — this is the one
 * command that may fail offline (spec criterion 11).
 */
export async function fetchSkillSource(source: ParsedSkillSource): Promise<FetchSkillSourceResult> {
  const cloneDir = await mkdtemp(join(tmpdir(), 'agentenv-skill-clone-'));
  const fail = async (message: string): Promise<{ error: string }> => {
    await rm(cloneDir, { recursive: true, force: true });
    return { error: message };
  };

  const clone = source.ref
    ? await runGit(['clone', '--depth', '1', '--branch', source.ref, source.cloneUrl, cloneDir])
    : await runGit(['clone', '--depth', '1', source.cloneUrl, cloneDir]);

  if (clone.code !== 0) {
    // `--branch` fails for a bare commit sha; retry with a shallow fetch+checkout.
    if (source.ref) {
      const plain = await runGit(['clone', '--depth', '1', source.cloneUrl, cloneDir]);
      if (plain.code !== 0) {
        return fail(cloneError(source, plain.stderr || clone.stderr));
      }
      const fetched = await runGit(['fetch', '--depth', '1', 'origin', source.ref], cloneDir);
      const checkout = fetched.code === 0 ? await runGit(['checkout', source.ref], cloneDir) : fetched;
      if (checkout.code !== 0) {
        return fail(
          `could not resolve ref '${source.ref}' in ${source.repo}` +
            `${firstLine(checkout.stderr) ? ` (${firstLine(checkout.stderr)})` : ''}`,
        );
      }
    } else {
      return fail(cloneError(source, clone.stderr));
    }
  }

  const rev = await runGit(['rev-parse', 'HEAD'], cloneDir);
  if (rev.code !== 0) return fail(`could not read the cloned commit for ${source.repo}`);
  const commit = rev.stdout.trim();

  let ref = source.ref;
  if (ref === undefined) {
    const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cloneDir);
    ref = branch.code === 0 && branch.stdout.trim() !== '' ? branch.stdout.trim() : 'HEAD';
  }

  // Resolve the subpath and re-check it never escaped the clone.
  const scanDir = resolve(cloneDir, source.subpath);
  const rel = relative(cloneDir, scanDir);
  if (rel.startsWith('..') || rel.startsWith(`${sep}..`)) {
    return fail(`invalid source path '${source.subpath}'`);
  }
  if (!(await exists(scanDir))) {
    return fail(
      `path '${source.subpath || '.'}' does not exist in ${source.repo}` +
        `${source.ref ? ` at ${source.ref}` : ''}`,
    );
  }

  return { cloneDir, scanDir, commit, ref };
}

function cloneError(source: ParsedSkillSource, stderr: string): string {
  const detail = firstLine(stderr);
  return (
    `could not clone ${source.repo} (${source.cloneUrl})` +
    `${detail ? `: ${detail}` : ''} — the source is unreachable; nothing was changed`
  );
}

/** A skill directory discovered by scanning a fetched source. */
export interface SkillCandidate {
  /** Absolute path of the skill directory. */
  dir: string;
  /** The directory's basename (the skill's folder name). */
  name: string;
  /** The SKILL.md frontmatter `description`, or '' when absent/unreadable. */
  description: string;
}

/**
 * Recursively find every directory under `root` (inclusive) that directly
 * contains a `SKILL.md`, reading each one's frontmatter description. Returned
 * sorted by name for stable, testable output. `.git` is never descended into.
 */
export async function scanSkillDirs(root: string): Promise<SkillCandidate[]> {
  const found: SkillCandidate[] = [];
  const visit = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
      found.push({ dir, name: basename(dir), description: await readDescription(dir) });
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== '.git') {
        await visit(join(dir, entry.name));
      }
    }
  };
  await visit(root);
  found.sort((a, b) => a.name.localeCompare(b.name));
  return found;
}

async function readDescription(dir: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(join(dir, 'SKILL.md'), 'utf8');
  } catch {
    return '';
  }
  const frontmatter = parseFrontmatter(text);
  const description = frontmatter?.description;
  return typeof description === 'string' ? description : '';
}

/**
 * A stable content hash of a directory tree (design D17 provenance): sha256 over
 * every file's relative path and bytes, in sorted order, so identical content
 * yields an identical hash on any machine and drift is detectable. `.git` is
 * excluded. Returns a hex digest.
 */
export async function hashDir(dir: string): Promise<string> {
  const files: string[] = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  };
  await walk(dir);
  files.sort((a, b) => relative(dir, a).localeCompare(relative(dir, b)));
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(relative(dir, file).split(sep).join('/'));
    hash.update('\0');
    hash.update(await readFile(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}
