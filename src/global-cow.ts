import { join } from 'node:path';
import { chmod, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import {
  beginProjectionReconciliation,
  completeProjectionReconciliation,
  createGlobalProjection,
  failProjectionReconciliation,
  observeProjection,
  publishProjection,
  retireProjection,
  type GlobalProjection,
} from './global-projection.js';
import { mirrorCowToCanonical } from './cow-files.js';
import { retainGlobalCowBytes } from './cow-files.js';
import {
  reconcileRetainedFileBlockProjection,
  type RetainedCanonicalWrite,
  type RetainedFileBlockProvenance,
} from './file-block.js';
import {
  reconcileRetainedConfigKeysProjection,
  type RetainedConfigCanonicalWrite,
} from './config-keys-reverse.js';
import type { RetainedConfigKeysProvenance } from './config-keys.js';
import type { Adapter } from './adapter.js';
import { scanTextForSecrets } from './git.js';
import { withLock } from './lock.js';
import { capturePathIdentity, identitiesEqual } from './path-identity.js';
import type { Paths } from './paths.js';
import { readState, writeState } from './state.js';
import { publishStagedBundle, type StagedBundleEntry } from './filesystem-bundle.js';

export interface BeginGlobalCowRequest {
  id: string;
  surfacePath: string;
  canonicalPath: string;
  ownerEnv: string;
  transform?: 'identity' | 'command-skill' | 'file-block' | 'config-keys';
  createdAt: number;
}

export function globalCowRetainedPath(paths: Paths, id: string): string {
  return join(paths.live, 'global-projections', id, 'content');
}

async function updateProjection(
  paths: Paths,
  id: string,
  update: (projection: GlobalProjection) => GlobalProjection,
): Promise<GlobalProjection> {
  return withLock(paths, async () => {
    const manifest = await readState(paths);
    const index = manifest.globalProjections.findIndex((projection) => projection.id === id);
    if (index === -1) throw new Error(`unknown global projection '${id}'`);
    const next = update(manifest.globalProjections[index]!);
    manifest.globalProjections[index] = next;
    await writeState(paths, manifest);
    return next;
  });
}

/** Persist projection intent before its live COW copy is created. */
export async function beginGlobalCowProjection(
  paths: Paths,
  req: BeginGlobalCowRequest,
): Promise<GlobalProjection> {
  const canonicalBaseline = await capturePathIdentity(req.canonicalPath);
  return withLock(paths, async () => {
    const manifest = await readState(paths);
    if (manifest.globalProjections.some((projection) => projection.id === req.id)) {
      throw new Error(`duplicate global projection '${req.id}'`);
    }
    const projection = createGlobalProjection(req.id, canonicalBaseline, {
      surfacePath: req.surfacePath,
      retainedPath: globalCowRetainedPath(paths, req.id),
      canonicalPath: req.canonicalPath,
      canonicalBaseline,
      ownerEnv: req.ownerEnv,
      transform: req.transform ?? 'identity',
      createdAt: req.createdAt,
    });
    manifest.globalProjections.push(projection);
    await writeState(paths, manifest);
    return projection;
  });
}

/** Publish after the copy exists, recording its exact rendered baseline. */
export async function finishGlobalCowPublication(
  paths: Paths,
  id: string,
  surfacePath: string,
  provenance?: {
    fileBlock?: RetainedFileBlockProvenance;
    configKeys?: RetainedConfigKeysProvenance;
  },
): Promise<GlobalProjection> {
  const baseline = await capturePathIdentity(surfacePath);
  return updateProjection(paths, id, (projection) =>
    publishProjection({
      ...projection,
      baseline,
      observed: baseline,
      ...(provenance?.fileBlock ? { fileBlockProvenance: provenance.fileBlock } : {}),
      ...(provenance?.configKeys ? { configKeysProvenance: provenance.configKeys } : {}),
    }),
  );
}

export async function abandonBuildingGlobalCow(paths: Paths, id: string): Promise<void> {
  await withLock(paths, async () => {
    const manifest = await readState(paths);
    manifest.globalProjections = manifest.globalProjections.filter(
      (projection) => projection.id !== id || projection.phase !== 'building',
    );
    await writeState(paths, manifest);
  });
}

export async function markGlobalCowRetired(
  paths: Paths,
  id: string,
  now: number,
): Promise<GlobalProjection> {
  const current = await withLock(paths, async () => {
    const manifest = await readState(paths);
    return manifest.globalProjections.find((projection) => projection.id === id);
  });
  if (!current?.retainedPath) throw new Error(`unknown retained projection '${id}'`);
  const observed = await capturePathIdentity(current.retainedPath);
  return updateProjection(paths, id, (projection) => ({
    ...observeProjection(retireProjection(projection), observed),
    retiredAt: now,
  }));
}

/**
 * Detach an active projection without invalidating already-open descriptors, then
 * seed a fresh live path from the retained bytes for safe dematerialisation or
 * replacement. The old inode remains addressable through `retainedPath`.
 */
export async function retireActiveGlobalCowSurface(
  paths: Paths,
  surfacePath: string,
  now: number,
): Promise<GlobalProjection | null> {
  return withLock(paths, async () => {
    const manifest = await readState(paths);
    const index = manifest.globalProjections.findIndex(
      (projection) => projection.surfacePath === surfacePath && projection.phase === 'active',
    );
    if (index === -1) return null;
    const projection = manifest.globalProjections[index]!;
    await retainGlobalCowBytes(projection);
    await mirrorCowToCanonical(projection.retainedPath!, surfacePath);
    const observed = await capturePathIdentity(projection.retainedPath!);
    const retired = {
      ...observeProjection(retireProjection(projection), observed),
      retiredAt: now,
    };
    manifest.globalProjections[index] = retired;
    await writeState(paths, manifest);
    return retired;
  });
}

export interface ReconcileGlobalCowRequest {
  ids: readonly string[];
  /** Callers assert every unsupervised writer for these ids is closed. */
  quiescent: boolean;
  adapters?: readonly Adapter[];
  /** Fault-injection seam for canonical WAL tests. */
  afterCanonicalApply?: (entry: StagedBundleEntry) => Promise<void>;
}

export interface ReconcileGlobalCowResult {
  reconciled: number;
  quarantined: number;
}

/** Count findings without ever returning or logging retained values. */
async function suspectedSecretCount(path: string): Promise<number> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) {
    throw new Error('retained projection contains an unresolved symlink');
  }
  if (stats.isFile()) {
    try {
      return scanTextForSecrets(await readFile(path, 'utf8')).length;
    } catch (error) {
      if (error instanceof Error && error.message.includes('unresolved symlink')) throw error;
      return 0;
    }
  }
  if (!stats.isDirectory()) return 0;
  let count = 0;
  for (const entry of await readdir(path)) count += await suspectedSecretCount(join(path, entry));
  return count;
}

async function publishCanonicalWrites(
  paths: Paths,
  projectionId: string,
  writes: readonly (RetainedCanonicalWrite | RetainedConfigCanonicalWrite)[],
  afterApply?: (entry: StagedBundleEntry) => Promise<void>,
): Promise<void> {
  if (writes.length === 0) return;
  const transactionId = `projection-${projectionId}`;
  const stagingRoot = join(paths.live, 'commands', transactionId);
  await mkdir(stagingRoot, { recursive: true });
  const entries: StagedBundleEntry[] = [];
  for (const [index, write] of writes.entries()) {
    const staged = join(stagingRoot, `canonical-${index}`);
    await writeFile(staged, write.text, 'utf8');
    if (write.mode !== undefined) await chmod(staged, write.mode);
    entries.push({ id: `canonical-${index}`, target: write.path, staged });
  }
  await publishStagedBundle({
    paths,
    transactionId,
    stagingRoot,
    entries,
    ...(afterApply ? { afterApply } : {}),
  });
}

/** Explicit, three-way reverse projection for retained global writer copies. */
export async function reconcileRetiredGlobalCows(
  paths: Paths,
  req: ReconcileGlobalCowRequest,
): Promise<ReconcileGlobalCowResult> {
  if (!req.quiescent) {
    throw new Error('global COW reconciliation requires an explicit quiescent assertion');
  }
  const result: ReconcileGlobalCowResult = { reconciled: 0, quarantined: 0 };
  for (const id of req.ids) {
    const manifest = await readState(paths);
    const current = manifest.globalProjections.find((projection) => projection.id === id);
    if (!current || current.phase !== 'retired') continue;
    if (!current.retainedPath || !current.canonicalPath || !current.canonicalBaseline) {
      await updateProjection(paths, id, (projection) => ({
        ...projection,
        phase: 'quarantined',
        failure: 'projection provenance is incomplete',
      }));
      result.quarantined += 1;
      continue;
    }

    const observed = await capturePathIdentity(current.retainedPath);
    const canonicalNow = await capturePathIdentity(current.canonicalPath);
    await updateProjection(paths, id, (projection) =>
      beginProjectionReconciliation(observeProjection(projection, observed)),
    );
    try {
      let canonicalWrites: Array<RetainedCanonicalWrite | RetainedConfigCanonicalWrite> = [];
      if (!identitiesEqual(observed, current.baseline)) {
        const source = current.transform === 'command-skill'
          ? join(current.retainedPath, 'SKILL.md')
          : current.retainedPath;
        const secretCount =
          current.transform === 'config-keys' ? 0 : await suspectedSecretCount(source);
        if (secretCount > 0) {
          throw new Error(
            `retained projection has ${secretCount} suspected secret finding(s); canonical write blocked`,
          );
        }
        if (current.transform === 'file-block') {
          if (!current.fileBlockProvenance) {
            throw new Error('retained file-block projection provenance is incomplete');
          }
          canonicalWrites = await reconcileRetainedFileBlockProjection(
            source,
            current.fileBlockProvenance,
          );
        } else {
          if (!identitiesEqual(canonicalNow, current.canonicalBaseline)) {
            throw new Error('canonical changed concurrently with retained projection');
          }
          if (current.transform === 'config-keys') {
            if (!current.configKeysProvenance) {
              throw new Error('retained config-keys projection provenance is incomplete');
            }
            if (!req.adapters) throw new Error('config-key reconciliation requires adapters');
            canonicalWrites = await reconcileRetainedConfigKeysProjection(
              paths,
              source,
              current.configKeysProvenance,
              req.adapters,
            );
          } else {
            await mirrorCowToCanonical(source, current.canonicalPath);
          }
        }
      }
      await publishCanonicalWrites(paths, id, canonicalWrites, req.afterCanonicalApply);
      const revision = JSON.stringify(await capturePathIdentity(current.canonicalPath));
      await updateProjection(paths, id, (projection) =>
        completeProjectionReconciliation(projection, revision),
      );
      result.reconciled += 1;
    } catch (err) {
      await updateProjection(paths, id, (projection) =>
        failProjectionReconciliation(projection, (err as Error).message),
      );
      result.quarantined += 1;
    }
  }
  return result;
}
