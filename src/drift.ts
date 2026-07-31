import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Adapter, ConfigKeysSurface } from './adapter.js';
import {
  syncBack as cfgSyncBack,
  type ConfigKeysItem,
  type JsonValue,
} from './config-keys.js';
import { syncBack as dmSyncBack, type DirMergeItem } from './dir-merge.js';
import { syncBack as fbSyncBack, type FileBlockItem } from './file-block.js';
import { writeFileAtomic } from './fs-atomic.js';
import { beginTransaction, recoverState } from './journal.js';
import { withLock } from './lock.js';
import type { Paths } from './paths.js';
import { readState } from './state.js';

/**
 * The per-invocation drift sweep (design D9). At the start of every mutating
 * command (and callable by the shim), it DETECTS and WRITES BACK mid-session
 * edits so nothing is lost between invocations:
 *
 * - **dir-merge copy items** → `dir-merge.syncBack` mirrors the working copy back
 *   to the store (symlink items write through and need no sweep).
 * - **inline file-block sub-blocks** → `file-block.syncBack` writes an edited
 *   region back to its store instruction file, then refreshes the block.
 * - **injected config keys** → `config-keys.syncBack` reconciles the manifest hash
 *   with the current file value and restores secret placeholders (D6). When the
 *   owning adapter implements the OPTIONAL `syncBackConfigKeys` reverse hook, the
 *   placeholder-restored `canonicalValue` is ALSO written back to the env's
 *   canonical store (e.g. `mcp/servers.yaml`), completing spec criterion 4. An
 *   adapter that omits the hook degrades to non-lossy hash reconciliation, which
 *   still keeps the edit and unblocks `drop`.
 * - **session-generated instruction files on disk** (D15) → an edited inline
 *   sub-block in any `live/<session>/<harness>/<instr>` view (including dead
 *   sessions') is written back to its store file, so a change made moments before
 *   a terminal closed survives.
 *
 * DETECTION + WRITE-BACK ONLY. See the {@link driftSweep} 2.1 hook point:
 * committing the swept store changes + queuing a push is Task 2.1 (no git here).
 */

export interface DriftSweepRequest {
  paths: Paths;
  /** Adapters whose session views are swept (for the D15 session pass). */
  adapters: readonly Adapter[];
  env: NodeJS.ProcessEnv;
  onWarn?: (message: string) => void;
}

export interface DriftSweepResult {
  /** dir-merge copy items mirrored back to the store. */
  dirMergeSynced: number;
  /** file-block store-instruction sources rewritten from real-file drift. */
  fileBlockDrifted: string[];
  /** config-keys whose manifest hash was reconciled to a drifted file value. */
  configKeysDrifted: number;
  /** session-generated instruction sub-blocks written back to the store. */
  sessionInstructionsSynced: number;
  /**
   * Every store path this sweep changed. TASK 2.1 HOOK POINT: this is the exact
   * set an `agentenv: sync drift` commit + queued push should cover. 1.7 performs
   * NO git — it only surfaces the paths so 2.1 can wire commit/push on top.
   */
  storePathsChanged: string[];
}

/**
 * Run the drift sweep. Recovery-first (a pending journal from a prior crash is
 * rolled back before the config-keys transaction opens). Every write-back is
 * itself transactional/atomic through the mechanisms; this composes them.
 */
export async function driftSweep(req: DriftSweepRequest): Promise<DriftSweepResult> {
  const { paths } = req;
  const onWarn = req.onWarn ?? ((m: string) => console.warn(m));
  const result: DriftSweepResult = {
    dirMergeSynced: 0,
    fileBlockDrifted: [],
    configKeysDrifted: 0,
    sessionInstructionsSynced: 0,
    storePathsChanged: [],
  };

  await withLock(paths, () => recoverState(paths));
  const manifest = await readState(paths);

  // A) dir-merge copy items → store (lock-free; a no-op for symlink items).
  for (const item of manifest.items) {
    if (item.surface !== 'dir-merge') continue;
    const dm = item as DirMergeItem;
    if (dm.action !== 'copy') continue;
    await dmSyncBack(paths, dm);
    result.dirMergeSynced += 1;
    result.storePathsChanged.push(dm.target);
  }

  // B) file-block inline sub-blocks → store instruction files (self-locking).
  const seenFileBlocks = new Set<string>();
  for (const item of manifest.items) {
    if (item.surface !== 'file-block') continue;
    const fb = item as FileBlockItem;
    const id = `${fb.path} ${fb.ownerEnv}`;
    if (seenFileBlocks.has(id)) continue;
    seenFileBlocks.add(id);
    try {
      const sync = await fbSyncBack(paths, { target: fb.path, env: fb.ownerEnv });
      for (const source of sync.drifted) {
        result.fileBlockDrifted.push(source);
        const sub = fb.subBlocks.find((s) => s.source === source);
        if (sub) result.storePathsChanged.push(sub.storePath);
      }
    } catch (err) {
      onWarn(`agentenv: drift sweep skipped ${fb.path} (${(err as Error).message})`);
    }
  }

  // C) config-keys → reconcile the manifest hash with drifted file values, under
  // one transaction. When the owning adapter implements the optional reverse hook,
  // the placeholder-restored value is ALSO written back to the env's canonical store
  // (spec criterion 4); an adapter without the hook keeps today's non-lossy hash
  // reconciliation.
  const configItems = manifest.items.filter((i): i is ConfigKeysItem => i.surface === 'config-keys');
  if (configItems.length > 0) {
    await withLock(paths, async () => {
      const tx = await beginTransaction(paths);
      try {
        for (const item of configItems) {
          const sync = await cfgSyncBack(paths, tx, item);
          if (!sync.drifted) continue;
          result.configKeysDrifted += 1;
          await writeBackConfigDrift(req, item, sync.canonicalValue, result, onWarn);
        }
        await tx.commit();
      } catch (err) {
        await tx.rollback();
        throw err;
      }
    });
  }

  // D) session-generated instruction files on disk (D15) → store instruction files.
  await sweepSessionInstructions(req, result, onWarn);

  // TASK 2.1 HOOK POINT: `result.storePathsChanged` names every store file this
  // sweep touched. Task 2.1 commits them as `agentenv: sync drift` and queues a
  // push here — before the pull/materialise the invocation goes on to do. 1.7
  // performs no git.

  return result;
}

// ---------------------------------------------------------------------------
// C') config-keys reverse write-back (spec criterion 4) — optional adapter hook
// ---------------------------------------------------------------------------

/**
 * When the adapter owning a drifted config-keys item implements the optional
 * {@link Adapter.syncBackConfigKeys} reverse hook, reverse-compile the drifted
 * (placeholder-restored) value into the env's canonical store and write the returned
 * mutation(s) atomically (spec criterion 4). Best-effort: a hook or store-write
 * failure is warned, never fatal — the manifest hash was already reconciled by
 * {@link cfgSyncBack}, so the edit stays non-lossy regardless. An adapter without
 * the hook (or a non-drift/absent value) is a no-op.
 */
async function writeBackConfigDrift(
  req: DriftSweepRequest,
  item: ConfigKeysItem,
  canonicalValue: JsonValue | undefined,
  result: DriftSweepResult,
  onWarn: (m: string) => void,
): Promise<void> {
  if (canonicalValue === undefined) return;
  const match = findConfigSurface(req.adapters, req.env, item);
  if (!match || !match.adapter.syncBackConfigKeys) return;
  const envContentDir = req.paths.envDir(item.ownerEnv);
  try {
    const mutations = await match.adapter.syncBackConfigKeys(
      match.surface,
      { style: item.mode, keyPath: item.keyPath, canonicalValue },
      { envContentDir, projectRoot: null },
    );
    for (const mutation of mutations) {
      const abs = join(envContentDir, mutation.storeRelativePath);
      await writeFileAtomic(abs, mutation.content);
      result.storePathsChanged.push(abs);
    }
  } catch (err) {
    onWarn(
      `agentenv: config-keys write-back for env '${item.ownerEnv}' failed (${(err as Error).message})`,
    );
  }
}

/**
 * Find the adapter + config-keys surface whose real target file is `item.path`, so
 * the reverse hook and its {@link ConfigKeysSurface} can be resolved for a manifest
 * item (which records only the file path). Matches the same real-root + relative-path
 * mapping the engine used to inject the key.
 */
function findConfigSurface(
  adapters: readonly Adapter[],
  env: NodeJS.ProcessEnv,
  item: ConfigKeysItem,
): { adapter: Adapter; surface: ConfigKeysSurface } | null {
  for (const adapter of adapters) {
    const realRoot = adapter.realConfigRoot(env);
    for (const surface of adapter.surfaces) {
      if (surface.mechanism !== 'config-keys') continue;
      if (join(realRoot, surface.rootRelativePath) === item.path) {
        return { adapter, surface };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// D) session-view instruction drift (D15) — best-effort, conservative
// ---------------------------------------------------------------------------

/** One inline sub-block located in a generated instruction file. */
interface SubBlockHit {
  env: string;
  source: string;
  body: string;
}

const OPEN_RE = /^<!-- >>> agentenv:([^\s>]+) >>> managed[^\n]*-->$/;
const CLOSE_RE = /^<!-- <<< agentenv:([^\s<]+) <<< -->$/;

/**
 * Extract every `open(label) … close(label)` inline sub-block from generated
 * file text, line-based to mirror the composer's rendering (`open\n<body>\nclose`).
 * The label is `<env>/<source>`; env names contain no `/`, so the split is on the
 * first `/`. A malformed/unpaired marker run is skipped (conservative).
 */
function scanSubBlocks(text: string): SubBlockHit[] {
  const lines = text.split('\n');
  const hits: SubBlockHit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = OPEN_RE.exec(lines[i] ?? '');
    if (!open) continue;
    const label = open[1] ?? '';
    let j = i + 1;
    for (; j < lines.length; j++) {
      const close = CLOSE_RE.exec(lines[j] ?? '');
      if (close && close[1] === label) break;
    }
    if (j >= lines.length) continue; // no matching close — skip
    const slash = label.indexOf('/');
    if (slash <= 0 || slash === label.length - 1) continue;
    hits.push({
      env: label.slice(0, slash),
      source: label.slice(slash + 1),
      body: lines.slice(i + 1, j).join('\n'),
    });
    i = j;
  }
  return hits;
}

async function sweepSessionInstructions(
  req: DriftSweepRequest,
  result: DriftSweepResult,
  onWarn: (m: string) => void,
): Promise<void> {
  const { paths, adapters } = req;
  // The set of file-block instruction files each adapter generates, keyed by
  // adapter id → { relPath, layering }. Only INLINE surfaces carry content to
  // write back; import surfaces hold an include line, not editable content.
  let sessions: string[];
  try {
    sessions = await readdir(paths.live);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // no session views yet
    throw err;
  }

  for (const session of sessions) {
    for (const adapter of adapters) {
      const viewRoot = join(paths.live, session, adapter.id);
      for (const surface of adapter.surfaces) {
        if (surface.mechanism !== 'file-block' || !surface.supported || surface.layering !== 'inline') {
          continue;
        }
        const genPath = join(viewRoot, surface.rootRelativePath);
        let text: string;
        try {
          text = await readFile(genPath, 'utf8');
        } catch {
          continue; // no generated file for this view/surface
        }
        for (const hit of scanSubBlocks(text)) {
          const storePath = join(paths.envDir(hit.env), 'instructions', hit.source);
          let storeBody: string;
          try {
            storeBody = await readFile(storePath, 'utf8');
          } catch {
            continue; // never CREATE a store file from a session view — write-back only
          }
          if (hit.body === storeBody) continue;
          try {
            await writeFileAtomic(storePath, hit.body);
            result.sessionInstructionsSynced += 1;
            result.storePathsChanged.push(storePath);
          } catch (err) {
            onWarn(`agentenv: could not write session drift back to ${storePath} (${(err as Error).message})`);
          }
        }
      }
    }
  }
}
