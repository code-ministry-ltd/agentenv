import { access } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
