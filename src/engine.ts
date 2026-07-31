import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  storeToken,
  type Adapter,
  type ConfigKeysSurface,
  type DirMergeSurface,
  type FileBlockSurface,
} from './adapter.js';
import {
  ConfigKeysError,
  injectArrayElement,
  injectKeyed,
  type ConfigKeysItem,
  type KeyPath,
} from './config-keys.js';
import { materialise as dmMaterialise, type DirMergeMode } from './dir-merge.js';
import { materialise as fbMaterialise, type FileBlockSource } from './file-block.js';
import { beginTransaction, recoverState } from './journal.js';
import { withLock } from './lock.js';
import type { Paths } from './paths.js';
import { readState, writeState, type StateManifest } from './state.js';

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
   * `user-collision` (a non-owned real item/key won), or `compile-error`.
   */
  reason: 'unsupported' | 'shadowed' | 'user-collision' | 'compile-error';
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
    const realRoot = adapter.realConfigRoot(env);
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
      if (surface.mechanism === 'dir-merge') {
        applied += await materialiseDirMerge(req, adapter, surface, realRoot, skips, onWarn);
      } else if (surface.mechanism === 'file-block') {
        applied += await materialiseFileBlock(req, adapter, surface, realRoot);
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
  realRoot: string,
  skips: GlobalSkip[],
  onWarn: (m: string) => void,
): Promise<number> {
  const { paths, envs } = req;
  const targetDir = join(realRoot, surface.rootRelativePath);
  const mode: DirMergeMode = surface.mode ?? 'symlink';
  const claimed = new Set<string>();
  let applied = 0;

  for (const env of [...envs].reverse()) {
    const storeDir = join(paths.envDir(env), surface.storeKind);
    for (const name of await listNames(storeDir)) {
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
      const result = await dmMaterialise(paths, {
        ownerEnv: env,
        sourcePath: join(storeDir, name),
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
  realRoot: string,
): Promise<number> {
  const { paths, envs } = req;
  const target = join(realRoot, surface.rootRelativePath);
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

  interface Planned {
    adapterId: string;
    surface: ConfigKeysSurface;
    file: string;
    env: string;
    injection: import('./adapter.js').ConfigKeysInjection;
  }
  const planned: Planned[] = [];

  for (const adapter of adapters) {
    const realRoot = adapter.realConfigRoot(env);
    for (const surface of adapter.surfaces) {
      if (surface.mechanism !== 'config-keys' || !surface.supported) continue;
      const file = join(realRoot, surface.rootRelativePath);
      const claimedKeys = new Set<string>();
      for (const envName of [...envs].reverse()) {
        let injections;
        try {
          injections = await adapter.compileConfigKeys(surface, {
            envContentDir: paths.envDir(envName),
            projectRoot: null,
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
          planned.push({ adapterId: adapter.id, surface, file, env: envName, injection });
        }
      }
    }
  }

  if (planned.length === 0) return 0;

  return withLock(paths, async () => {
    const tx = await beginTransaction(paths);
    const manifest = await readState(paths); // ownership snapshot for idempotency
    let applied = 0;
    try {
      for (const p of planned) {
        if (p.injection.style === 'keyed') {
          const owner = ownedConfigKey(manifest, p.file, p.injection.keyPath);
          if (owner !== null) continue; // already ours (or a stack env's) — idempotent no-op
          try {
            await injectKeyed(paths, tx, {
              file: p.file,
              format: p.surface.format,
              keyPath: p.injection.keyPath,
              value: p.injection.value,
              ownerEnv: p.env,
              ...(p.injection.secretFields ? { secretFields: p.injection.secretFields } : {}),
            });
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
          await injectArrayElement(paths, tx, {
            file: p.file,
            format: p.surface.format,
            arrayPath: p.injection.arrayPath,
            value: p.injection.value,
            ownerEnv: p.env,
          });
          applied += 1;
        }
      }
      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }
    return applied;
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
    if (item.surface === 'dir-merge' && !(await lexists(item.path))) {
      warnings.push(`agentenv: verify — owned path missing after apply: ${item.path}`);
    }
  }
  return warnings;
}
