import { dirname, join } from 'node:path';
import { mkdir, rename, rm } from 'node:fs/promises';
import {
  createGlobalProjection,
  observeProjection,
  publishProjection,
  retireProjection,
  type GlobalProjection,
} from './global-projection.js';
import { withLock } from './lock.js';
import { capturePathIdentity } from './path-identity.js';
import type { Paths } from './paths.js';
import { readState, writeState } from './state.js';

export interface BeginGlobalCowRequest {
  id: string;
  surfacePath: string;
  canonicalPath: string;
  ownerEnv: string;
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

/**
 * Move the live copy—not copy its bytes—so already-open descriptors continue to
 * address the retained inode after the real surface is restored.
 */
export async function retainGlobalCowBytes(projection: GlobalProjection): Promise<void> {
  if (!projection.surfacePath || !projection.retainedPath) {
    throw new Error(`projection '${projection.id}' lacks retained paths`);
  }
  await mkdir(dirname(projection.retainedPath), { recursive: true });
  await rm(projection.retainedPath, { recursive: true, force: true });
  await rename(projection.surfacePath, projection.retainedPath);
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
