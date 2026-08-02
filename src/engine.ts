import { lstat, mkdir, readdir, readFile, readlink, rm, symlink } from 'node:fs/promises';
import { basename, extname, join, sep } from 'node:path';
import { resolveGlobalSurfaceDestination } from './adapter-v2.js';
import {
  storeToken,
  type Adapter,
  type ConfigKeysSurface,
  type DirMergeSurface,
  type FileBlockSurface,
  type SelfCheckResult,
} from './adapter.js';
import { backup } from './backups.js';
import {
  ConfigKeysError,
  injectArrayElement,
  injectKeyed,
  removeKey,
  type ConfigKeysItem,
  type KeyPath,
} from './config-keys.js';
import {
  dematerialise as dmDematerialise,
  materialise as dmMaterialise,
  type DirMergeItem,
  type DirMergeMode,
} from './dir-merge.js';
import {
  dematerialise as fbDematerialise,
  materialise as fbMaterialise,
  type FileBlockSource,
} from './file-block.js';
import { beginTransaction, recoverState } from './journal.js';
import { withLock } from './lock.js';
import type { Paths } from './paths.js';
import { loadResolver, substituteSecretFields, type SecretResolver } from './secrets.js';
import { findOwner, readState, writeState, type ManifestItem, type StateManifest } from './state.js';

/**
 * The GLOBAL-mode engine (design D4/D5/D7). `agentenv use … --global` materialises
 * an env STACK onto the harness's REAL config paths through the three surface
 * mechanisms (dir-merge / file-block / config-keys); `drop --global` reverses it
 * from the MANIFEST only. This is the "explicit fallback" for GUI apps and
 * machine-wide setups that session mode (the default) cannot reach.
 *
 * Transaction shape. The three mechanisms are consumed as libraries with two
 * different transaction contracts, which the FROZEN interfaces fix:
 *
 * - dir-merge and file-block each open their OWN `withLock` + journal transaction
 *   per item/file (their `materialise`/`dematerialise` are self-contained and
 *   atomic). `withLock` is non-reentrant, so the engine CANNOT wrap them in an
 *   outer lock — it drives them sequentially, each atomic.
 * - config-keys takes an OPEN transaction, so the engine batches every key across
 *   every surface and adapter under ONE `withLock` + journal transaction.
 *
 * The whole invocation is therefore **recovery-first + plan → journal → apply →
 * verify**, with each mechanism op individually atomic and the whole thing
 * idempotent. A kill mid-invocation leaves at most one pending journal, which the
 * next command's {@link recoverState} rolls back deterministically; re-running
 * `use` then completes the stack (idempotent). This is the closest crash-safe
 * shape achievable without editing the frozen self-locking mechanisms — see the
 * Task 1.7 report for the deviation note.
 */

/** A surface/env the engine did not fully apply, surfaced to the user + `status` (D6/D7). */
export interface GlobalSkip {
  adapterId: string;
  surfaceId: string;
  /**
   * `unsupported` (adapter says so), `shadowed` (a later env or a user item won),
   * `user-collision` (a non-owned real item/key won), `compile-error`,
   * `secret-unresolved` (a substitute-rung `${VAR}` resolved to nothing → the server
   * is skipped, fail-closed per server, D6), `validation-failed` (the written
   * config-keys file was rejected wholesale by `adapter.validateConfigFile`, so the
   * whole surface's write was rolled back — fail-closed, F2/M5), or
   * `validation-baseline` (the file was ALREADY rejected before this invocation, by a
   * PRE-EXISTING entry of the user's — nothing was written and the blame is not ours,
   * F5/7).
   */
  reason:
    | 'unsupported'
    | 'shadowed'
    | 'user-collision'
    | 'compile-error'
    | 'secret-unresolved'
    | 'validation-failed'
    | 'validation-baseline';
  detail: string;
}

/** Outcome of {@link materialiseGlobal} / {@link dematerialiseGlobal}. */
export interface GlobalResult {
  /** Items materialised (dir-merge + file-block + config-keys), this invocation. */
  applied: number;
  /** Items removed (dematerialise). */
  removed: number;
  /** Surfaces/envs skipped, for the caller to report. */
  skips: GlobalSkip[];
  /** The global stack after the operation. */
  stack: string[];
  /** Post-apply verification problems (missing owned paths), if any. */
  verifyWarnings: string[];
}

export interface MaterialiseGlobalRequest {
  paths: Paths;
  /** In-scope adapters (already filtered by `--harness`). */
  adapters: readonly Adapter[];
  /** The FULL env stack to materialise (later entries win, D5). */
  envs: readonly string[];
  /** Environment used to resolve each adapter's real config root. */
  env: NodeJS.ProcessEnv;
  onWarn?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Global-stack persistence (a tolerated top-level field in state.json)
// ---------------------------------------------------------------------------

/** The persisted global env stack (order = precedence; last wins, D5). */
export function readGlobalStack(manifest: StateManifest): string[] {
  const raw = (manifest as { globalStack?: unknown }).globalStack;
  return Array.isArray(raw) ? raw.filter((e): e is string => typeof e === 'string') : [];
}

/** Persist the global stack under the lock, preserving the rest of the manifest. */
async function writeGlobalStack(paths: Paths, stack: readonly string[]): Promise<void> {
  await withLock(paths, async () => {
    const manifest = await readState(paths);
    (manifest as { globalStack?: string[] }).globalStack = [...stack];
    await writeState(paths, manifest);
  });
}

/** Merge new envs into the stack: existing positions drop, new envs append at top (D5). */
export function mergeStack(current: readonly string[], added: readonly string[]): string[] {
  return [...current.filter((e) => !added.includes(e)), ...added];
}

/**
 * The EFFECTIVE active set for global mode: the persisted {@link readGlobalStack
 * global stack} UNION every env that still owns a manifest item. A crash between an
 * item commit and {@link writeGlobalStack} (D4) leaves manifest-owned items on disk
 * with an empty stack and NO pending journal, so {@link recoverState} is a no-op;
 * without this union those orphaned items are undroppable by `drop --all` and
 * invisible to `status`/`describeGlobal` (Finding 1). Mirrors rm's `envActivity`,
 * which already treats an env as active on stack-membership OR materialised
 * ownership. Stack entries keep their precedence order; extra owners append.
 */
export function effectiveGlobalEnvs(manifest: StateManifest): string[] {
  const stack = readGlobalStack(manifest);
  const extra: string[] = [];
  for (const item of manifest.items) {
    if (!stack.includes(item.ownerEnv) && !extra.includes(item.ownerEnv)) {
      extra.push(item.ownerEnv);
    }
  }
  return [...stack, ...extra];
}

/** Select adapters a `--harness a,b` scope applies to (by id or binaryName). Empty scope ⇒ all. */
export function selectAdapters(
  adapters: readonly Adapter[],
  harnesses: readonly string[] | undefined,
): Adapter[] {
  if (!harnesses || harnesses.length === 0) return [...adapters];
  return adapters.filter((a) => harnesses.includes(a.id) || harnesses.includes(a.binaryName));
}

// ---------------------------------------------------------------------------
// Small fs helpers
// ---------------------------------------------------------------------------

async function listNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function lexists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

function keyPathEqual(a: KeyPath, b: KeyPath): boolean {
  return a.length === b.length && a.every((seg, i) => seg === b[i]);
}

function dirMergeItemName(surface: DirMergeSurface, storeName: string): string | null {
  if (surface.layout !== 'command-skill') return storeName;
  return extname(storeName) === '.md' ? basename(storeName, '.md') : null;
}

/** Build the derived directory Codex needs to expose one command markdown as a skill. */
async function commandSkillWrapper(
  paths: Paths,
  env: string,
  name: string,
  source: string,
): Promise<string> {
  const wrapper = join(paths.live, 'global', 'command-skills', env, name);
  const current = await lstat(wrapper).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (current && !current.isDirectory()) await rm(wrapper, { recursive: true, force: true });
  await mkdir(wrapper, { recursive: true });
  const skill = join(wrapper, 'SKILL.md');
  const skillState = await lstat(skill).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (skillState?.isSymbolicLink() && (await readlink(skill)) === source) return wrapper;
  if (skillState) await rm(skill, { recursive: true, force: true });
  await symlink(source, skill);
  return wrapper;
}

/** The env owning a keyed config value at (file, keyPath), or null (for idempotency). */
function ownedConfigKey(manifest: StateManifest, file: string, keyPath: KeyPath): string | null {
  for (const item of manifest.items) {
    if (item.surface !== 'config-keys' || item.path !== file) continue;
    const cfg = item as ConfigKeysItem;
    if (cfg.mode === 'keyed' && keyPathEqual(cfg.keyPath, keyPath)) return cfg.ownerEnv;
  }
  return null;
}

/** The store instruction files an env contributes as file-block sources (base.md then <token>.md). */
async function instructionSources(
  paths: Paths,
  adapter: Adapter,
  env: string,
): Promise<FileBlockSource[]> {
  const dir = join(paths.envDir(env), 'instructions');
  const out: FileBlockSource[] = [];
  for (const name of ['base.md', `${storeToken(adapter)}.md`]) {
    const storePath = join(dir, name);
    if (await lexists(storePath)) out.push({ source: name, storePath });
  }
  return out;
}

// ---------------------------------------------------------------------------
// materialise
// ---------------------------------------------------------------------------

/**
 * Materialise the env stack onto the in-scope adapters' real config paths, then
 * persist the merged global stack. Recovery-first; each mechanism op is atomic;
 * config-keys are batched under one transaction; idempotent.
 */
export async function materialiseGlobal(req: MaterialiseGlobalRequest): Promise<GlobalResult> {
  const { paths, adapters, envs, env } = req;
  const onWarn = req.onWarn ?? ((m: string) => console.warn(m));
  const skips: GlobalSkip[] = [];

  // Recovery-first: roll back any journal a previous crash left pending, so the
  // manifest is consistent before we begin (D4).
  await withLock(paths, () => recoverState(paths));

  let applied = 0;
  // dir-merge and file-block: each self-locks + self-journals (one atomic op).
  for (const adapter of adapters) {
    for (const surface of adapter.surfaces) {
      if (!surface.supported) {
        skips.push({
          adapterId: adapter.id,
          surfaceId: surface.id,
          reason: 'unsupported',
          detail: surface.unsupportedReason ?? `${adapter.id} does not support '${surface.id}'`,
        });
        continue;
      }
      const target = resolveGlobalSurfaceDestination(adapter, surface, env);
      if (surface.mechanism === 'dir-merge') {
        applied += await materialiseDirMerge(req, adapter, surface, target, skips, onWarn);
      } else if (surface.mechanism === 'file-block') {
        applied += await materialiseFileBlock(req, adapter, surface, target);
      }
      // config-keys handled below, batched under one transaction.
    }
  }

  // config-keys: ONE withLock + transaction across every surface and adapter.
  applied += await materialiseConfigKeys(req, skips, onWarn);

  const stack = mergeStack(readGlobalStack(await readState(paths)), envs);
  await writeGlobalStack(paths, stack);

  const verifyWarnings = await verifyOwned(paths, envs);
  for (const w of verifyWarnings) onWarn(w);

  return { applied, removed: 0, skips, stack, verifyWarnings };
}

/**
 * Place an env stack's items into one dir-merge surface. Iterates the stack in
 * REVERSE so a LATER env claims a shared name first (D5); an earlier env's item of
 * that name is shadowed; a non-owned user item always wins (D1/D7 — handled by
 * `dir-merge.materialise`, which skips it).
 */
async function materialiseDirMerge(
  req: MaterialiseGlobalRequest,
  adapter: Adapter,
  surface: DirMergeSurface,
  targetDir: string,
  skips: GlobalSkip[],
  onWarn: (m: string) => void,
): Promise<number> {
  const { paths, envs } = req;
  const mode: DirMergeMode = surface.mode ?? 'symlink';
  const claimed = new Set<string>();
  let applied = 0;

  for (const env of [...envs].reverse()) {
    const storeDir = join(paths.envDir(env), surface.storeKind);
    for (const storeName of await listNames(storeDir)) {
      const name = dirMergeItemName(surface, storeName);
      if (name === null) continue;
      if (claimed.has(name)) {
        skips.push({
          adapterId: adapter.id,
          surfaceId: surface.id,
          reason: 'shadowed',
          detail: `'${name}' from env '${env}' shadowed by a higher-precedence item in ${surface.id}`,
        });
        continue;
      }
      claimed.add(name);
      const canonicalSource = join(storeDir, storeName);
      const sourcePath = surface.layout === 'command-skill'
        ? await commandSkillWrapper(paths, env, name, canonicalSource)
        : canonicalSource;
      const result = await dmMaterialise(paths, {
        ownerEnv: env,
        sourcePath,
        targetDir,
        itemName: name,
        mode,
        onWarn,
      });
      if (result.status === 'materialised') {
        applied += 1;
      } else {
        skips.push({
          adapterId: adapter.id,
          surfaceId: surface.id,
          reason: 'user-collision',
          detail: `'${name}' from env '${env}' skipped — a non-agentenv item already exists`,
        });
      }
    }
  }
  return applied;
}

/**
 * Materialise each env's instruction region into one file-block surface. Every
 * env owns its OWN sub-block region (keyed by env), so envs coexist rather than
 * collide; an env with no instruction files contributes nothing.
 */
async function materialiseFileBlock(
  req: MaterialiseGlobalRequest,
  adapter: Adapter,
  surface: FileBlockSurface,
  target: string,
): Promise<number> {
  const { paths, envs } = req;
  let applied = 0;
  for (const env of envs) {
    const sources = await instructionSources(paths, adapter, env);
    if (sources.length === 0) continue;
    await fbMaterialise(paths, { target, env, mode: surface.layering, sources });
    applied += 1;
  }
  return applied;
}

/**
 * Apply the `${VAR}` rung (D6) to one keyed injection before it is written to the
 * REAL config. A *substitute* surface ({@link ConfigKeysSurface.substitutePlaceholders})
 * resolves each flagged placeholder to its literal from `secrets.env`/the shell;
 * a *passthrough* surface (the default) is a no-op — the placeholder is kept so the
 * harness interpolates it. Either way the caller passes the ORIGINAL `secretFields`
 * to the manifest, so drift write-back always restores `${VAR}`. Unresolved names
 * are returned so the caller can fail closed for that server only.
 */
function resolveInjectionSecrets(
  surface: ConfigKeysSurface,
  injection: import('./adapter.js').ConfigKeysInjection,
  resolver: SecretResolver,
): { value: import('./config-keys.js').JsonValue; unresolved: string[] } {
  if (
    injection.style !== 'keyed' ||
    !surface.substitutePlaceholders ||
    !injection.secretFields ||
    Object.keys(injection.secretFields).length === 0
  ) {
    return { value: injection.value, unresolved: [] };
  }
  return substituteSecretFields(injection.value, injection.secretFields, (n) => resolver.resolve(n));
}

/**
 * Inject every env's compiled config keys under ONE transaction. Keyed injections
 * respect later-wins (reversed stack, first claim wins) and idempotency (a key we
 * already own is skipped, not re-injected — `injectKeyed` would otherwise refuse
 * the collision); a non-owned user value at the key path wins (D7 skip). Array
 * elements merge order-independently.
 */
async function materialiseConfigKeys(
  req: MaterialiseGlobalRequest,
  skips: GlobalSkip[],
  onWarn: (m: string) => void,
): Promise<number> {
  const { paths, adapters, envs, env } = req;

  const planned: Planned[] = [];

  for (const adapter of adapters) {
    for (const surface of adapter.surfaces) {
      if (surface.mechanism !== 'config-keys' || !surface.supported) continue;
      const file = resolveGlobalSurfaceDestination(adapter, surface, env);
      const claimedKeys = new Set<string>();
      for (const envName of [...envs].reverse()) {
        let injections;
        try {
          injections = await adapter.compileConfigKeys(surface, {
            envContentDir: paths.envDir(envName),
            projectRoot: null,
            // A compile that refuses to emit something unsafe (a SHADOWED bearer, F6/3)
            // must reach the user rather than vanish into a default console.warn.
            onWarn,
          });
        } catch (err) {
          skips.push({
            adapterId: adapter.id,
            surfaceId: surface.id,
            reason: 'compile-error',
            detail: `env '${envName}': ${(err as Error).message}`,
          });
          continue;
        }
        for (const injection of injections) {
          if (injection.style === 'keyed') {
            const k = JSON.stringify([...injection.keyPath]);
            if (claimedKeys.has(k)) {
              skips.push({
                adapterId: adapter.id,
                surfaceId: surface.id,
                reason: 'shadowed',
                detail: `key '${injection.keyPath.join('.')}' from env '${envName}' shadowed by a higher-precedence env`,
              });
              continue;
            }
            claimedKeys.add(k);
          }
          planned.push({ adapter, adapterId: adapter.id, surface, file, env: envName, injection });
        }
      }
    }
  }

  if (planned.length === 0) return 0;

  // Secrets resolver for the substitute rung (D6): secrets.env first, then the
  // shell env. Loaded once per invocation — a substitute-surface `${VAR}` is
  // resolved to a LITERAL in the real config here, while the manifest keeps the
  // placeholder (below) so drift write-back never carries the literal to the store.
  const resolver = await loadResolver(paths, env);

  // Per-file record of what THIS invocation injected, so a whole-file rejection
  // (F2/M5) can roll back exactly this surface's write (see validateWrittenConfigFiles).
  const written = new Map<string, WrittenConfigFile>();
  const recordWrite = (p: Planned, item: ConfigKeysItem): void => {
    let w = written.get(p.file);
    if (!w) {
      w = { adapter: p.adapter, items: [] };
      written.set(p.file, w);
    }
    w.items.push({ item, surfaceId: p.surface.id, env: p.env });
  };

  return withLock(paths, async () => {
    // BASELINE validation (F5/7), BEFORE any write. Cursor's validator rejects the file
    // if ANY entry is malformed — explicitly including a PRE-EXISTING user entry. Without
    // this check a file that was already broken makes our own (valid) injection look like
    // the culprit: we write, the whole file is rejected, we roll back, and we blame
    // ourselves — forever, with nothing pointing at the real offender. So a file that is
    // already invalid is left completely alone and reported under its own reason.
    const blocked = await baselineRejectedFiles(paths, planned, skips, onWarn);
    const writable = blocked.size === 0 ? planned : planned.filter((p) => !blocked.has(p.file));
    if (writable.length === 0) return 0;

    const tx = await beginTransaction(paths);
    const manifest = await readState(paths); // ownership snapshot for idempotency
    let applied = 0;
    try {
      for (const p of writable) {
        if (p.injection.style === 'keyed') {
          const owner = ownedConfigKey(manifest, p.file, p.injection.keyPath);
          if (owner !== null) continue; // already ours (or a stack env's) — idempotent no-op
          // Substitute rung: resolve `${VAR}` in the flagged fields to literals for
          // the real config; unresolved → fail closed for THIS server only (D6).
          const resolved = resolveInjectionSecrets(p.surface, p.injection, resolver);
          if (resolved.unresolved.length > 0) {
            const detail = `key '${p.injection.keyPath.join('.')}' from env '${p.env}' skipped — unresolved secret(s): ${resolved.unresolved.join(', ')} (set them in ~/.agentenv/secrets.env or the shell)`;
            onWarn(`agentenv: ${detail}`);
            skips.push({
              adapterId: p.adapterId,
              surfaceId: p.surface.id,
              reason: 'secret-unresolved',
              detail,
            });
            continue;
          }
          try {
            const item = await injectKeyed(paths, tx, {
              file: p.file,
              format: p.surface.format,
              keyPath: p.injection.keyPath,
              value: resolved.value,
              ownerEnv: p.env,
              // Always the ORIGINAL placeholder text — the manifest records the
              // placeholder regardless of rung, so write-back restores `${VAR}` (D6).
              ...(p.injection.secretFields ? { secretFields: p.injection.secretFields } : {}),
            });
            recordWrite(p, item);
            applied += 1;
          } catch (err) {
            if (err instanceof ConfigKeysError) {
              onWarn(`agentenv: ${err.message}`);
              skips.push({
                adapterId: p.adapterId,
                surfaceId: p.surface.id,
                reason: 'user-collision',
                detail: err.message,
              });
              continue;
            }
            throw err;
          }
        } else {
          try {
            const item = await injectArrayElement(paths, tx, {
              file: p.file,
              format: p.surface.format,
              arrayPath: p.injection.arrayPath,
              value: p.injection.value,
              ownerEnv: p.env,
            });
            recordWrite(p, item);
            applied += 1;
          } catch (err) {
            // Same skip-and-warn boundary as the keyed branch above (D7): a user's
            // non-array value at the target path is a conflict to skip, NOT a reason
            // to abort the whole invocation — an unguarded throw here rolls back the
            // config-keys batch and orphans every already-committed dir-merge /
            // file-block item with an empty global stack (Finding 1/2).
            if (err instanceof ConfigKeysError) {
              onWarn(`agentenv: ${err.message}`);
              skips.push({
                adapterId: p.adapterId,
                surfaceId: p.surface.id,
                reason: 'user-collision',
                detail: err.message,
              });
              continue;
            }
            throw err;
          }
        }
      }
      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }
    // F2/M5: after the batch commits, validate every written config-keys file whose
    // adapter defines `validateConfigFile` (Cursor's whole-file `mcp.json` check). A
    // rejected file has THIS invocation's write to it rolled back (fail-closed) so a
    // bad injection never leaves a whole-file-rejecting config on the user's disk.
    applied -= await validateWrittenConfigFiles(paths, written, skips, onWarn);
    return applied;
  });
}

/** One config-keys injection, resolved to the real file it targets. */
interface Planned {
  adapter: Adapter;
  adapterId: string;
  surface: ConfigKeysSurface;
  file: string;
  env: string;
  injection: import('./adapter.js').ConfigKeysInjection;
}

/** What THIS invocation injected into one config-keys file (for whole-file rollback). */
interface WrittenConfigFile {
  adapter: Adapter;
  items: { item: ConfigKeysItem; surfaceId: string; env: string }[];
}

/**
 * Read a file's text for validation. A missing file is empty; ANY other fault (EACCES,
 * EISDIR, …) is reported rather than thrown — the caller must treat an unreadable config
 * as a validation FAILURE and fail closed, never let the error escape `withLock` after
 * the batch has already committed (F5/6).
 */
async function readFileForValidation(file: string): Promise<{ text: string } | { error: string }> {
  try {
    return { text: await readFile(file, 'utf8') };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return { text: '' };
    return { error: `${file}: unreadable (${e.code ?? e.message})` };
  }
}

/**
 * Read + validate one config file, treating EVERY fault as a validation FAILURE (F5/6).
 * An unreadable file or a validator that throws must fail CLOSED: every other adapter-hook
 * call site here is defensively wrapped, and this one runs AFTER `tx.commit()` — an
 * unguarded throw would escape `withLock`, exit with a stack trace, AND leave the
 * whole-file-rejecting config committed on disk, the exact outcome the check exists to
 * prevent.
 */
async function validateConfigFileSafely(
  adapter: Adapter,
  file: string,
): Promise<SelfCheckResult> {
  const read = await readFileForValidation(file);
  if ('error' in read) return { ok: false, detail: read.error };
  try {
    return adapter.validateConfigFile!(file, read.text);
  } catch (err) {
    return {
      ok: false,
      detail: `${file}: ${adapter.id} whole-file validation threw — ${(err as Error).message}`,
    };
  }
}

/** The keyed config-keys paths agentenv's manifest still claims to own in `file`. */
function ownedConfigKeysIn(manifest: StateManifest, file: string): string[] {
  const out: string[] = [];
  for (const item of manifest.items) {
    if (item.surface !== 'config-keys' || item.path !== file) continue;
    const cfg = item as ConfigKeysItem;
    out.push(cfg.key ?? cfg.keyPath.join('.'));
  }
  return out;
}

/**
 * BASELINE whole-file validation (F5/7), run under the lock BEFORE anything is written.
 * A file the harness ALREADY rejects must not be written to: our injection would be rolled
 * back and blamed for a breakage it did not cause, leaving the real offender undiagnosed.
 * Returns the set of files to leave alone, recording one `validation-baseline` skip per
 * losing (surface, env).
 *
 * The rejection is NOT automatically the user's fault (F6/8). {@link
 * validateWrittenConfigFiles} explicitly contemplates leaving OUR own rejecting key behind
 * when `removeKey` cannot take it out, and the manifest records that ownership — so the
 * manifest is consulted and the skip says which it is, instead of asserting "a pre-existing
 * entry, not ours" and sending the user after an offender that may be agentenv's.
 */
async function baselineRejectedFiles(
  paths: Paths,
  planned: readonly Planned[],
  skips: GlobalSkip[],
  onWarn: (m: string) => void,
): Promise<Set<string>> {
  const blocked = new Set<string>();
  const checked = new Map<string, boolean>();
  const seen = new Set<string>();
  const manifest = await readState(paths);
  for (const p of planned) {
    if (!p.adapter.validateConfigFile) continue;
    let bad = checked.get(p.file);
    if (bad === undefined) {
      const verdict = await validateConfigFileSafely(p.adapter, p.file);
      bad = !verdict.ok;
      checked.set(p.file, bad);
      if (bad) {
        blocked.add(p.file);
        onWarn(
          `agentenv: ${p.file} is ALREADY rejected by ${p.adapter.id} before agentenv ` +
            `touches it — ${verdict.detail ?? 'whole-file validation failed'}. Fix it, then re-run.`,
        );
      }
    }
    if (!bad) continue;
    const k = JSON.stringify([p.surface.id, p.env]);
    if (seen.has(k)) continue;
    seen.add(k);
    const ours = ownedConfigKeysIn(manifest, p.file);
    const provenance =
      ours.length > 0
        ? `agentenv still owns ${ours.length === 1 ? 'a key' : 'keys'} in this file ` +
          `(${ours.join(', ')}), so the offending entry may well be OURS — a previous ` +
          `invocation's rollback may have failed to remove it`
        : 'agentenv owns nothing in this file, so the offending entry is a pre-existing one';
    skips.push({
      adapterId: p.adapterId,
      surfaceId: p.surface.id,
      reason: 'validation-baseline',
      detail:
        `env '${p.env}': ${p.file} was already rejected by ${p.adapter.id} whole-file ` +
        `validation BEFORE this invocation — ${provenance}. Nothing was written. Fix the ` +
        `file, then re-run.`,
    });
  }
  return blocked;
}

/**
 * Post-write whole-file validation for config-keys surfaces (F2/M5). For each written
 * file whose adapter defines {@link Adapter.validateConfigFile}, read the committed file
 * and validate it; on `{ok:false}` remove EVERY key/element this invocation added to that
 * file (keyed inject→remove is byte-identical on an existing file, D3 — see
 * `injectArrayElement`'s F5/12 note for the array-element caveat, which no adapter reaches
 * today), restoring the user's real config unchanged, and record a `validation-failed`
 * skip per losing surface. Runs under the caller's lock
 * (a fresh transaction per rolled-back file). Returns how many items were ACTUALLY rolled
 * back, so the caller can discount them from `applied`. Never throws for a rejection or a
 * misbehaving validator — fail-closed is the whole point; only an fs/tx fault propagates.
 */
async function validateWrittenConfigFiles(
  paths: Paths,
  written: Map<string, WrittenConfigFile>,
  skips: GlobalSkip[],
  onWarn: (m: string) => void,
): Promise<number> {
  let rolledBack = 0;
  for (const [file, { adapter, items }] of written) {
    if (!adapter.validateConfigFile || items.length === 0) continue;
    const verdict = await validateConfigFileSafely(adapter, file);
    if (verdict.ok) continue;

    // Fail-closed: undo this invocation's contribution to the rejected file. Each
    // removeKey normally matches the value we just wrote (hash agrees) and prunes any
    // parents the inject created, so the file returns to its pre-injection bytes.
    const tx = await beginTransaction(paths);
    let removed = 0;
    let gone = 0;
    const stuck: string[] = [];
    try {
      for (const { item } of items) {
        // `removeKey` returns `{removed:false, reason:'absent'|'hash-mismatch'}` WITHOUT
        // touching the file. Counting the attempt instead of the result would report a
        // clean rollback while the bad key is still in the harness's config and the
        // manifest still claims ownership of it (F5/5) — so check every result. The two
        // reasons are NOT the same outcome (F6/10): `hash-mismatch` means our key is
        // still in the file and only a human can take it out, while `absent` means it is
        // already gone — telling the user to remove it by hand sends them after nothing.
        const res = await removeKey(paths, tx, item);
        if (res.removed) removed += 1;
        else if (res.reason === 'absent') gone += 1;
        else stuck.push(`${item.key ?? item.keyPath.join('.')} (${res.reason ?? 'unknown'})`);
      }
      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }
    // An `absent` key is discounted from `applied` too (F6/11): it is not in the file, so
    // counting it as applied claims a server the harness will never see.
    rolledBack += removed + gone;

    const outcome =
      stuck.length === 0
        ? 'write rolled back'
        : `write only PARTIALLY rolled back — agentenv could not remove ${stuck.join(', ')}; ` +
          `${file} is still rejected by ${adapter.id}, so remove ${stuck.length === 1 ? 'it' : 'them'} by hand`;
    const detail = verdict.detail
      ? `${verdict.detail} — ${outcome}`
      : `${file}: rejected by ${adapter.id} whole-file validation — ${outcome}`;
    onWarn(`agentenv: ${detail}`);
    // One skip per distinct (surface, env) so every env whose server was dropped is named.
    const seen = new Set<string>();
    for (const { surfaceId, env } of items) {
      const k = JSON.stringify([surfaceId, env]);
      if (seen.has(k)) continue;
      seen.add(k);
      skips.push({
        adapterId: adapter.id,
        surfaceId,
        reason: 'validation-failed',
        detail: `env '${env}': ${detail}`,
      });
    }
  }
  return rolledBack;
}

// ---------------------------------------------------------------------------
// describe (status) — READ-ONLY view of the global stack + per-surface support
// ---------------------------------------------------------------------------

/** Per-surface support + ownership, for `status` (never pretends unsupported works, D6). */
export interface SurfaceStatus {
  surfaceId: string;
  mechanism: 'dir-merge' | 'file-block' | 'config-keys';
  supported: boolean;
  unsupportedReason?: string;
  /** Items in the manifest owned by the active global stack for this surface. */
  ownedItems: number;
}

/** Per-adapter global status. */
export interface AdapterStatus {
  adapterId: string;
  /** Whether this harness can be session-activated at all (Cursor is global-only, D11/D15). */
  sessionSupported: boolean;
  /** Why session mode is unavailable, when {@link sessionSupported} is `false`. */
  sessionUnsupportedReason?: string;
  surfaces: SurfaceStatus[];
  /** Shadowing / user-collision skips the active global stack would incur (D7). */
  skips: GlobalSkip[];
}

/** The read-only global picture `status` renders. */
export interface GlobalStatus {
  stack: string[];
  /**
   * Envs that own manifest items but are NOT in the persisted stack — surfaced by a
   * crash between an item commit and the stack write (Finding 1). `status` flags
   * them as recovered so they are neither invisible nor undroppable.
   */
  orphanedEnvs: string[];
  adapters: AdapterStatus[];
}

/**
 * Compute a READ-ONLY description of global mode for `status`: the active stack,
 * each adapter's per-surface support + owned-item count, and the shadowing /
 * user-collision skips the stack incurs. Mutates nothing.
 */
export async function describeGlobal(req: {
  paths: Paths;
  adapters: readonly Adapter[];
  env: NodeJS.ProcessEnv;
}): Promise<GlobalStatus> {
  const { paths, adapters, env } = req;
  const manifest = await readState(paths);
  const stack = readGlobalStack(manifest);
  // Count/expose owned items against the EFFECTIVE active set (stack ∪ owners) so a
  // crash-orphaned env's items are visible, not hidden by an empty stack (Finding 1).
  const active = effectiveGlobalEnvs(manifest);
  const orphanedEnvs = active.filter((e) => !stack.includes(e));

  const out: AdapterStatus[] = [];
  for (const adapter of adapters) {
    const surfaces: SurfaceStatus[] = [];
    const skips: GlobalSkip[] = [];
    for (const surface of adapter.surfaces) {
      const target = resolveGlobalSurfaceDestination(adapter, surface, env);
      surfaces.push({
        surfaceId: surface.id,
        mechanism: surface.mechanism,
        supported: surface.supported,
        ...(surface.unsupportedReason ? { unsupportedReason: surface.unsupportedReason } : {}),
        ownedItems: countOwned(manifest, surface, target, active),
      });
      if (!surface.supported) {
        skips.push({
          adapterId: adapter.id,
          surfaceId: surface.id,
          reason: 'unsupported',
          detail: surface.unsupportedReason ?? `${adapter.id} does not support '${surface.id}'`,
        });
        continue;
      }
      if (stack.length > 0 && surface.mechanism === 'dir-merge') {
        skips.push(...(await dirMergeStatusSkips(paths, adapter, surface, target, stack, manifest)));
      }
    }
    out.push({
      adapterId: adapter.id,
      sessionSupported: adapter.sessionSupported,
      ...(adapter.sessionUnsupportedReason
        ? { sessionUnsupportedReason: adapter.sessionUnsupportedReason }
        : {}),
      surfaces,
      skips,
    });
  }
  return { stack, orphanedEnvs, adapters: out };
}

/**
 * Count manifest items owned by the effective active set that live under one
 * surface's target. `active` is stack ∪ owners (see {@link effectiveGlobalEnvs}),
 * so an orphaned env's items are counted rather than hidden by an empty stack.
 */
function countOwned(
  manifest: StateManifest,
  surface: DirMergeSurface | FileBlockSurface | ConfigKeysSurface,
  target: string,
  active: readonly string[],
): number {
  return manifest.items.filter((i) => {
    if (!active.includes(i.ownerEnv)) return false;
    if (surface.mechanism === 'dir-merge') return i.path.startsWith(target + sep);
    return i.path === target;
  }).length;
}

/** Re-derive the shadowing / user-collision skips a dir-merge surface incurs (read-only). */
async function dirMergeStatusSkips(
  paths: Paths,
  adapter: Adapter,
  surface: DirMergeSurface,
  targetDir: string,
  stack: readonly string[],
  manifest: StateManifest,
): Promise<GlobalSkip[]> {
  const claimed = new Set<string>();
  const skips: GlobalSkip[] = [];
  for (const env of [...stack].reverse()) {
    const storeDir = join(paths.envDir(env), surface.storeKind);
    for (const storeName of await listNames(storeDir)) {
      const name = dirMergeItemName(surface, storeName);
      if (name === null) continue;
      const targetPath = join(targetDir, name);
      if (claimed.has(name)) {
        skips.push({
          adapterId: adapter.id,
          surfaceId: surface.id,
          reason: 'shadowed',
          detail: `'${name}' from env '${env}' shadowed by a higher-precedence item in ${surface.id}`,
        });
        continue;
      }
      claimed.add(name);
      const owner = findOwner(manifest, targetPath);
      if ((await lexists(targetPath)) && (!owner || !stack.includes(owner.ownerEnv))) {
        skips.push({
          adapterId: adapter.id,
          surfaceId: surface.id,
          reason: 'user-collision',
          detail: `'${name}' from env '${env}' skipped — a non-agentenv item already exists`,
        });
      }
    }
  }
  return skips;
}

// ---------------------------------------------------------------------------
// dematerialise (drop --global)
// ---------------------------------------------------------------------------

export interface DematerialiseGlobalRequest {
  paths: Paths;
  /** In-scope adapters, used to RE-materialise anything a dropped env shadowed. */
  adapters: readonly Adapter[];
  /** Envs to drop; ignored when {@link all} is set. */
  envs: readonly string[];
  /** Drop the whole global stack. */
  all: boolean;
  env: NodeJS.ProcessEnv;
  /**
   * Restrict removal to items under these real config roots (`--harness` scoping).
   * `undefined` ⇒ remove every owned item of the dropped envs, regardless of adapter.
   */
  restrictToRoots?: readonly string[];
  onWarn?: (message: string) => void;
}

/**
 * Dematerialise dropped envs from the harness's real config paths using the
 * MANIFEST only — never scan-and-guess (D4) — then re-materialise the remaining
 * stack so anything a dropped (higher) env had shadowed reappears (D5). Removal is
 * recovery-first and idempotent. `all` clears the whole global stack.
 */
export async function dematerialiseGlobal(req: DematerialiseGlobalRequest): Promise<GlobalResult> {
  const { paths, adapters, env, all } = req;
  const onWarn = req.onWarn ?? ((m: string) => console.warn(m));
  const skips: GlobalSkip[] = [];

  await withLock(paths, () => recoverState(paths));

  const manifest = await readState(paths);
  const currentStack = readGlobalStack(manifest);
  // `--all` drops the EFFECTIVE active set (stack ∪ every manifest owner), so a
  // crash-orphaned env whose stack write was lost is still fully removed (Finding 1).
  const toDrop = all ? effectiveGlobalEnvs(manifest) : [...req.envs];
  const inScope = (path: string): boolean => {
    if (!req.restrictToRoots) return true;
    return req.restrictToRoots.some((root) => path === root || path.startsWith(root + sep));
  };

  const owned = manifest.items.filter((i) => toDrop.includes(i.ownerEnv) && inScope(i.path));

  // dir-merge and file-block: each self-locks + self-journals (one atomic op).
  let removed = 0;
  const configItems: ConfigKeysItem[] = [];
  for (const item of owned) {
    if (item.surface === 'dir-merge') {
      await dmDematerialise(paths, item as DirMergeItem, onWarn);
      removed += 1;
    } else if (item.surface === 'file-block') {
      await fbDematerialise(paths, { target: item.path, env: item.ownerEnv });
      removed += 1;
    } else if (item.surface === 'config-keys') {
      configItems.push(item as ConfigKeysItem);
    }
  }

  // config-keys: batch every removal under ONE transaction.
  if (configItems.length > 0) {
    removed += await removeConfigKeys(paths, configItems, onWarn);
  }

  // Recompute the stack: a dropped env leaves it only when no owned item survives
  // (with `--harness` an env may retain items under other adapters).
  const after = await readState(paths);
  const remaining = currentStack.filter(
    (e) => !toDrop.includes(e) || after.items.some((i) => i.ownerEnv === e),
  );
  await writeGlobalStack(paths, remaining);

  // Re-materialise the survivors: idempotent for still-present items, and it
  // places anything the dropped env had shadowed (D5).
  let applied = 0;
  if (remaining.length > 0) {
    if (adapters.length === 0) {
      onWarn('agentenv: no in-scope adapter to re-materialise the remaining stack');
    } else {
      const re = await materialiseGlobal({ paths, adapters, envs: remaining, env, onWarn });
      applied = re.applied;
      skips.push(...re.skips);
    }
  }

  return { applied, removed, skips, stack: remaining, verifyWarnings: [] };
}

/**
 * Remove owned config keys under one transaction. A key that already vanished
 * from the file (`absent`) still has its ownership dropped via a journalled no-op,
 * so the manifest never keeps a stale record. A DRIFTED key (`hash-mismatch`) is
 * left owned with a warning — the drift sweep (run before drop) normally brings
 * the hash back into agreement first.
 */
async function removeConfigKeys(
  paths: Paths,
  items: readonly ConfigKeysItem[],
  onWarn: (m: string) => void,
): Promise<number> {
  return withLock(paths, async () => {
    const tx = await beginTransaction(paths);
    let removed = 0;
    try {
      for (const item of items) {
        const result = await removeKey(paths, tx, item);
        if (result.removed) {
          removed += 1;
        } else if (result.reason === 'absent') {
          // Drop stale ownership without touching the file (journalled no-op).
          const backupRef = await backup(paths, item.path);
          await tx.apply(
            { op: 'remove', item: item as ManifestItem, undo: { path: item.path, backupRef } },
            async () => {
              /* file already lacks the key — only the manifest record is removed */
            },
          );
          removed += 1;
        } else {
          onWarn(`agentenv: ${result.note ?? `could not remove config key ${item.key ?? ''}`}`);
        }
      }
      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }
    return removed;
  });
}

/**
 * VERIFY: after apply, confirm every manifest item owned by the stack points at a
 * path that still exists on disk. A missing path is a soft warning (doctor
 * territory, Task 3.3), not a failure — the transaction already committed.
 */
async function verifyOwned(paths: Paths, envs: readonly string[]): Promise<string[]> {
  const manifest = await readState(paths);
  const warnings: string[] = [];
  for (const item of manifest.items) {
    if (!envs.includes(item.ownerEnv)) continue;
    // NOTE (Finding 5b — record-only, not fixed in 1.7): verify only checks that
    // dir-merge paths still exist; file-block and config-keys presence is not
    // re-asserted here. Accepted as a deliberately-soft verify (doctor territory,
    // Task 3.3) — the transaction already committed, so this is advisory only.
    if (item.surface === 'dir-merge' && !(await lexists(item.path))) {
      warnings.push(`agentenv: verify — owned path missing after apply: ${item.path}`);
    }
  }
  return warnings;
}
