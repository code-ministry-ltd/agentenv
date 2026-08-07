import { lstat, readFile, readlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { writeFileAtomic } from '../fs-atomic.js';
import { withLock } from '../lock.js';
import type { Paths } from '../paths.js';
import { isApproved, recordApproval } from './approvals.js';
import { validateEnvName } from '../store.js';

/**
 * The session registry — machine-local, per-shell bindings that drive session
 * mode (D8/D11/D15). Separate from `state.json` (which is the global ownership
 * manifest): a binding is neither a mutation nor synced content, and D11 says
 * session-view builds need no global lock. Writes here (rare: `use`/`drop`, Task
 * 1.7) take the lock only to serialise the read-modify-write of one small file;
 * the shim's READ path is lock-free and fail-open (D15).
 *
 * Task 1.6 provides the registry + the read path the shim uses. The `use`/`drop`
 * COMMANDS that write bindings are Task 1.7; tests here write via {@link setBinding}.
 */

/** The registry schema version, mirroring state.json / env.yaml tolerance (D4). */
export const SESSION_REGISTRY_VERSION = '1.0';

/** A problem reading the registry file (corrupt JSON / wrong shape). Names the file. */
export class SessionRegistryError extends Error {
  constructor(
    message: string,
    readonly file: string,
  ) {
    super(message);
    this.name = 'SessionRegistryError';
  }
}

export class SessionEnvironmentUnavailableError extends Error {
  constructor(readonly environment: string) {
    super(`environment '${environment}' disappeared during session activation`);
    this.name = 'SessionEnvironmentUnavailableError';
  }
}

/**
 * One binding: an env stack bound to a shell session at a project root (D8). The
 * pair (session, projectRoot) is the identity — a shell can bind different envs
 * in different project dirs, and two shells (session ids) bind independently,
 * which is what gives per-shell concurrency (D11).
 */
export interface SessionBinding {
  /** The shell session id (the `AGENTENV_SESSION` the shell hook assigns). */
  session: string;
  /** The canonicalised project root this binding applies in (D8). */
  projectRoot: string;
  /** The env stack; later entries win item-name conflicts, last is top (D5). */
  envs: string[];
  /**
   * Optional per-harness scoping (`use --harness`, Task 1.7). Unset = all
   * supported harnesses. When set, a launch of a harness not listed is unbound.
   */
  harnesses?: string[];
  /**
   * `--global` marker (Task 1.7). Session-mode composition ignores a global
   * binding (global mode materialises into real paths, not a private view); it
   * is carried here so `status` can report the shell's mode.
   */
  global?: boolean;
  /** When the binding was written (ms epoch), for `status`/diagnostics. */
  createdAt: number;
}

/** The parsed registry: known fields typed, unknown top-level fields preserved. */
export interface SessionRegistry {
  version: string;
  bindings: SessionBinding[];
  [key: string]: unknown;
}

/** The on-disk location of the registry (derived from the frozen base path). */
export function sessionRegistryPath(paths: Paths): string {
  return join(paths.base, 'sessions.json');
}

function emptyRegistry(): SessionRegistry {
  return { version: SESSION_REGISTRY_VERSION, bindings: [] };
}

function isBinding(value: unknown): value is SessionBinding {
  if (value === null || typeof value !== 'object') return false;
  const b = value as Record<string, unknown>;
  return (
    typeof b.session === 'string' &&
    typeof b.projectRoot === 'string' &&
    Array.isArray(b.envs) &&
    b.envs.every((e) => typeof e === 'string')
  );
}

/**
 * Read and validate the registry. A missing file yields an empty registry (not
 * an error — no shell has bound anything yet). Throws {@link SessionRegistryError}
 * on corrupt JSON or a malformed shape; the shim wraps this in its fail-open
 * guard so a broken registry launches the real binary untouched (D15).
 */
export async function readSessionRegistry(paths: Paths): Promise<SessionRegistry> {
  const file = sessionRegistryPath(paths);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyRegistry();
    throw err;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new SessionRegistryError(`${file}: corrupt sessions.json (${(err as Error).message})`, file);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new SessionRegistryError(`${file}: expected a JSON object at the top level`, file);
  }
  const obj = data as Record<string, unknown>;
  const rawBindings = obj.bindings;
  if (rawBindings !== undefined && !Array.isArray(rawBindings)) {
    throw new SessionRegistryError(`${file}: 'bindings' must be an array`, file);
  }
  const bindings: SessionBinding[] = [];
  for (const entry of rawBindings ?? []) {
    if (!isBinding(entry)) {
      throw new SessionRegistryError(`${file}: malformed binding entry`, file);
    }
    bindings.push(entry);
  }
  return { ...obj, version: typeof obj.version === 'string' ? obj.version : SESSION_REGISTRY_VERSION, bindings };
}

/** The binding for a (session, projectRoot) pair, or `undefined`. Pure. */
export function findBinding(
  registry: SessionRegistry,
  session: string,
  projectRoot: string,
): SessionBinding | undefined {
  return registry.bindings.find((b) => b.session === session && b.projectRoot === projectRoot);
}

/**
 * Upsert a binding (by session + projectRoot), atomically and under the machine
 * lock. `createdAt` is stamped when absent. This is the write API `use` (Task
 * 1.7) builds on; tests call it directly to set up a bound launch.
 */
export async function setBinding(
  paths: Paths,
  binding: Omit<SessionBinding, 'createdAt'> & { createdAt?: number },
): Promise<void> {
  await withLock(paths, async () => {
    const registry = await readSessionRegistry(paths);
    const full: SessionBinding = { ...binding, createdAt: binding.createdAt ?? Date.now() };
    const at = registry.bindings.findIndex(
      (b) => b.session === full.session && b.projectRoot === full.projectRoot,
    );
    if (at >= 0) registry.bindings[at] = full;
    else registry.bindings.push(full);
    await writeRegistry(paths, registry);
  });
}

/** Command-facing binding write: validation and persistence share the machine
 * lock so a concurrent environment deletion cannot leave a fresh dangling
 * binding after it removes the directory. Low-level `setBinding` remains
 * permissive for registry migration/repair tests. */
export async function setBindingForExistingEnvironments(
  paths: Paths,
  binding: Omit<SessionBinding, 'createdAt'> & { createdAt?: number },
): Promise<void> {
  await withLock(paths, async () => {
    for (const environment of binding.envs) {
      try {
        const identity = await lstat(paths.envDir(environment));
        if (!identity.isDirectory()) throw new SessionEnvironmentUnavailableError(environment);
      } catch (error) {
        if (error instanceof SessionEnvironmentUnavailableError) throw error;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new SessionEnvironmentUnavailableError(environment);
        }
        throw error;
      }
    }
    const registry = await readSessionRegistry(paths);
    const full: SessionBinding = {
      ...binding,
      createdAt: binding.createdAt ?? Date.now(),
    };
    const at = registry.bindings.findIndex(
      (candidate) => candidate.session === full.session &&
        candidate.projectRoot === full.projectRoot,
    );
    if (at >= 0) registry.bindings[at] = full;
    else registry.bindings.push(full);
    await writeRegistry(paths, registry);
  });
}

/** Remove the binding for a (session, projectRoot). Returns whether one existed. */
export async function removeBinding(
  paths: Paths,
  session: string,
  projectRoot: string,
): Promise<boolean> {
  return withLock(paths, async () => {
    const registry = await readSessionRegistry(paths);
    const before = registry.bindings.length;
    registry.bindings = registry.bindings.filter(
      (b) => !(b.session === session && b.projectRoot === projectRoot),
    );
    if (registry.bindings.length === before) return false;
    await writeRegistry(paths, registry);
    return true;
  });
}

/** Remove every binding for a session (e.g. a shell exited). Returns the count. */
export async function clearSession(paths: Paths, session: string): Promise<number> {
  return withLock(paths, async () => {
    const registry = await readSessionRegistry(paths);
    const before = registry.bindings.length;
    registry.bindings = registry.bindings.filter((b) => b.session !== session);
    const removed = before - registry.bindings.length;
    if (removed > 0) await writeRegistry(paths, registry);
    return removed;
  });
}

async function writeRegistry(paths: Paths, registry: SessionRegistry): Promise<void> {
  const out = { ...registry, version: SESSION_REGISTRY_VERSION, bindings: registry.bindings };
  await writeFileAtomic(sessionRegistryPath(paths), `${JSON.stringify(out, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Project root (D8) and .agentenv discovery (D16 — hook point for Task 3.2)
// ---------------------------------------------------------------------------

/** Resolve a path, following one level of symlink where possible (best-effort canonical). */
async function canonical(p: string): Promise<string> {
  const abs = resolve(p);
  try {
    const st = await lstat(abs);
    if (st.isSymbolicLink()) return resolve(dirname(abs), await readlink(abs));
  } catch {
    /* not a symlink / missing — use the resolved path */
  }
  return abs;
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The project root a binding applies to (D8): the containing git worktree root
 * (the dir holding `.git`, whether a dir for a normal checkout or a file for a
 * worktree/submodule), else the canonical cwd. Walks up to the filesystem root.
 */
export async function resolveProjectRoot(cwd: string): Promise<string> {
  let dir = await canonical(cwd);
  for (;;) {
    if (await exists(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return await canonical(cwd); // reached root, no worktree
    dir = parent;
  }
}

/**
 * Locate a `.agentenv` file for `projectRoot` (D16): regular files only, walking
 * up from the project root and stopping at the containing worktree root, or at
 * `$HOME` **exclusive** outside a repo — which also ignores the `~/.agentenv/`
 * store directory that shares the name. Returns the file path, or `null`.
 *
 * HOOK POINT: this is the discovery half of `.agentenv` pickup. APPLYING it
 * (per-project approval, the `.mcp.json` trust model) is Task 3.2 — {@link
 * resolveSessionBinding} finds it here but never binds it unapproved.
 */
export async function findAgentenvFile(
  projectRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const home = resolve(env.HOME ?? homedir());
  let dir = resolve(projectRoot);
  for (;;) {
    const candidate = join(dir, '.agentenv');
    try {
      const st = await lstat(candidate);
      if (st.isFile()) return candidate; // regular files only (D16)
    } catch {
      /* absent — keep walking */
    }
    // Stop at a worktree boundary (don't cross into a parent repo/home).
    if (await exists(join(dir, '.git'))) return null;
    const parent = dirname(dir);
    if (parent === dir || parent === home || dir === home) return null; // $HOME exclusive
    dir = parent;
  }
}

/**
 * Parse a `.agentenv` file into its env stack (D16): the content is just the env
 * name(s), one per line. Blank lines and `#` comments are ignored (a forgiving
 * parse). Only syntactically valid names survive — this is a path-safety gate as
 * much as a filter, since these names feed `environmentExists` / `envDir(name)`
 * downstream (mirrors the `rm` command validating before any path construction).
 * Order-preserving and de-duplicated. Never throws.
 */
export function parseAgentenvEnvs(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (validateEnvName(line) !== null) continue; // drop malformed names, don't bind them
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

/** A request to grant a one-time approval to an unapproved `.agentenv` (D16). */
export interface AgentenvApprovalRequest {
  /** The discovered `.agentenv` file. */
  file: string;
  /** The canonical project folder that declares it (the approval key). */
  projectDir: string;
  /** The env stack the file names. */
  envs: string[];
}

/**
 * Interactive one-time approval seam. Returning `true` trusts the folder (the
 * caller records it); anything else leaves it inert. Absent → non-interactive:
 * the `.agentenv` is skipped with a notice and NEVER auto-approved (D16).
 */
export type ApproveAgentenv = (req: AgentenvApprovalRequest) => Promise<boolean>;

/** Where a resolved binding came from (D16 precedence). */
export type BindingSource = 'explicit' | 'agentenv-file' | 'none';

/** The outcome of resolving what (if anything) a launch is bound to. */
export interface ResolvedBinding {
  source: BindingSource;
  /** The bound env stack — present for `explicit`. */
  binding?: SessionBinding;
  /** A human note (e.g. why a discovered `.agentenv` was not applied). */
  note?: string;
}

/**
 * Resolve the binding for a launch, applying the D16 precedence: an explicit
 * `use` binding in this shell/project wins; otherwise an **approved** `.agentenv`
 * for the project applies at session scope; otherwise none. A blank/absent
 * session id can never have an explicit binding.
 *
 * `.agentenv` pickup (D16): a discovered file does nothing until a one-time
 * per-project approval (the `.mcp.json` trust model). Already-approved → bind its
 * env stack (`source: 'agentenv-file'`) with no prompt. Unapproved → the `approve`
 * seam decides (interactive); a `true` records the approval and binds, anything
 * else (including no seam = non-interactive) leaves it inert with a notice, never
 * auto-approving. Missing/invalid env names are the caller's concern (the shim
 * validates existence and warns) — approval trusts the FILE, not the env set.
 *
 * Fail-open: any error resolving `.agentenv` yields an inert result with a note,
 * never a throw — the launch must never be bricked by this feature.
 */
export async function resolveSessionBinding(args: {
  paths: Paths;
  session: string | undefined;
  projectRoot: string;
  env: NodeJS.ProcessEnv;
  /** One-time approval seam for an unapproved `.agentenv` (absent = non-interactive). */
  approve?: ApproveAgentenv;
  /** Injectable clock for the approval timestamp (tests). */
  now?: () => number;
}): Promise<ResolvedBinding> {
  const { paths, session, projectRoot, env, approve, now } = args;

  if (session && session.trim() !== '') {
    const registry = await readSessionRegistry(paths);
    const binding = findBinding(registry, session, projectRoot);
    if (binding) return { source: 'explicit', binding }; // explicit `use` wins (D16)
  }

  try {
    const agentenvFile = await findAgentenvFile(projectRoot, env);
    if (!agentenvFile) return { source: 'none' };

    const envs = parseAgentenvEnvs(await readFile(agentenvFile, 'utf8'));
    if (envs.length === 0) {
      return { source: 'none', note: `${agentenvFile} names no environment(s) — launching unbound` };
    }

    const projectDir = resolve(dirname(agentenvFile));
    let approved = await isApproved(paths, projectDir);
    if (!approved && approve) {
      approved = await approve({ file: agentenvFile, projectDir, envs });
      if (approved) await recordApproval(paths, projectDir, now);
    }
    if (!approved) {
      return {
        source: 'none',
        note:
          `found ${agentenvFile} (default: ${envs.join(', ')}) — a .agentenv needs a one-time ` +
          'approval before it applies; not approved (non-interactive or declined), launching unbound',
      };
    }

    const binding: SessionBinding = {
      session: session ?? '',
      projectRoot,
      envs,
      global: false,
      createdAt: (now ?? Date.now)(),
    };
    return {
      source: 'agentenv-file',
      binding,
      note: `applying .agentenv default [${envs.join(', ')}] from ${agentenvFile}`,
    };
  } catch (err) {
    // Fail-open: a `.agentenv` problem must never brick the launch (D15/D16).
    return { source: 'none', note: `.agentenv resolution failed (${(err as Error).message}) — launching unbound` };
  }
}
