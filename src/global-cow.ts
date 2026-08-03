import { join } from 'node:path';
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
import { withLock } from './lock.js';
import { capturePathIdentity, identitiesEqual } from './path-identity.js';
import type { Paths } from './paths.js';
import { readState, writeState } from './state.js';

export interface BeginGlobalCowRequest {
  id: string;
  surfacePath: string;
  canonicalPath: string;
  ownerEnv: string;
  transform?: 'identity' | 'command-skill';
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
): Promise<GlobalProjection> {
  const baseline = await capturePathIdentity(surfacePath);
  return updateProjection(paths, id, (projection) =>
    publishProjection({ ...projection, baseline, observed: baseline }),
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

export interface ReconcileGlobalCowRequest {
  ids: readonly string[];
  /** Callers assert every unsupervised writer for these ids is closed. */
  quiescent: boolean;
}

export interface ReconcileGlobalCowResult {
  reconciled: number;
  quarantined: number;
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
      if (
        !identitiesEqual(observed, current.baseline) &&
        !identitiesEqual(canonicalNow, current.canonicalBaseline)
      ) {
        throw new Error('canonical changed concurrently with retained projection');
      }
      if (!identitiesEqual(observed, current.baseline)) {
        const source = current.transform === 'command-skill'
          ? join(current.retainedPath, 'SKILL.md')
          : current.retainedPath;
        await mirrorCowToCanonical(source, current.canonicalPath);
      }
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
