import { rm } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { withLock } from './lock.js';
import { capturePathIdentity } from './path-identity.js';
import type { Paths } from './paths.js';
import { readState, writeState, type StateManifest } from './state.js';
import { collectGeneration, type ViewGeneration } from './view-generation.js';

const DEFAULT_LIMIT = 4;
const DEFAULT_MIN_AGE_MS = 24 * 60 * 60 * 1_000;

export interface LifecycleGcOptions {
  limit?: number;
  minAgeMs?: number;
  now?: () => number;
  /** Fault/race seam invoked while holding the machine lock, before final re-read. */
  beforeRemove?: (generationId: string) => Promise<void>;
}

export interface LifecycleGcResult {
  collectedGenerationIds: string[];
}

function containedBy(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}

function stringPaths(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  return ['path', 'target', 'surfacePath', 'retainedPath', 'canonicalPath', 'worktree']
    .map((field) => record[field])
    .filter((path): path is string => typeof path === 'string');
}

function hasReference(manifest: StateManifest, generationRoot: string): boolean {
  const records: unknown[] = [
    ...manifest.items,
    ...manifest.globalProjections,
    ...manifest.projectionRecords,
    ...manifest.candidates,
  ];
  return records.some((record) =>
    stringPaths(record).some((path) => containedBy(generationRoot, path)),
  );
}

function isOldEnough(
  generation: ViewGeneration,
  now: number,
  minAgeMs: number,
): boolean {
  const settledAt = generation.sweptAt;
  return typeof settledAt === 'number' && now - settledAt >= minAgeMs;
}

function collectible(
  manifest: StateManifest,
  paths: Paths,
  generation: ViewGeneration,
  now: number,
  minAgeMs: number,
): boolean {
  if (manifest.commands.length > 0) return false;
  if (generation.phase !== 'swept') return false;
  if (generation.reservations.length > 0 || generation.leases.length > 0) return false;
  if (!generation.viewRoot || !isOldEnough(generation, now, minAgeMs)) return false;
  const generationRoot = join(paths.live, 'generations', generation.id);
  if (!containedBy(generationRoot, generation.viewRoot)) return false;
  return !hasReference(manifest, generationRoot);
}

/**
 * Collect a bounded number of old, fully swept generation trees. The machine
 * lock is held for selection, immediate state revalidation, removal, and the
 * collected-state write. Any uncertainty leaves the bytes in place.
 */
export async function collectLifecycleGarbage(
  paths: Paths,
  options: LifecycleGcOptions = {},
): Promise<LifecycleGcResult> {
  const limit = Math.max(0, Math.floor(options.limit ?? DEFAULT_LIMIT));
  const minAgeMs = Math.max(0, options.minAgeMs ?? DEFAULT_MIN_AGE_MS);
  const now = (options.now ?? Date.now)();
  const result: LifecycleGcResult = { collectedGenerationIds: [] };
  if (limit === 0) return result;

  return withLock(paths, async () => {
    let manifest = await readState(paths);
    const candidates = manifest.generations
      .filter((generation) => collectible(manifest, paths, generation, now, minAgeMs))
      .map((generation) => generation.id);

    for (const id of candidates) {
      if (result.collectedGenerationIds.length >= limit) break;
      await options.beforeRemove?.(id);

      // Immediate re-read under the machine lock is the authority. This catches
      // a crash-recovery/state handoff that landed between selection and removal.
      manifest = await readState(paths);
      const index = manifest.generations.findIndex((generation) => generation.id === id);
      if (index < 0) continue;
      const generation = manifest.generations[index]!;
      if (!collectible(manifest, paths, generation, now, minAgeMs)) continue;

      const generationRoot = join(paths.live, 'generations', id);
      const identity = await capturePathIdentity(generationRoot);
      if (identity.kind !== 'directory' && identity.kind !== 'absent') continue;
      if (identity.kind === 'directory') {
        await rm(generationRoot, { recursive: true, force: true });
      }
      manifest.generations[index] = collectGeneration(generation);
      await writeState(paths, manifest);
      result.collectedGenerationIds.push(id);
    }
    return result;
  });
}
