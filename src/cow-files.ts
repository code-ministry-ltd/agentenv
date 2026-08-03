import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { GlobalProjection } from './global-projection.js';

/** Rename the live copy so open descriptors keep addressing the retained inode. */
export async function retainGlobalCowBytes(projection: GlobalProjection): Promise<void> {
  if (!projection.surfacePath || !projection.retainedPath) {
    throw new Error(`projection '${projection.id}' lacks retained paths`);
  }
  await mkdir(dirname(projection.retainedPath), { recursive: true });
  // Never remove an existing retained target. It may be the sole surviving inode
  // after a killed handoff; callers recover from identities instead.
  await rename(projection.surfacePath, projection.retainedPath);
}

/** Mirror a quiescent retained COW tree into its identity-mapped canonical item. */
export async function mirrorCowToCanonical(source: string, canonical: string): Promise<void> {
  const sourceStats = await lstat(source);
  if (sourceStats.isSymbolicLink()) {
    throw new Error('retained projection contains a symlink and is not losslessly reversible');
  }
  if (sourceStats.isDirectory()) {
    const canonicalStats = await lstat(canonical).catch(() => null);
    if (!canonicalStats?.isDirectory()) {
      await rm(canonical, { recursive: true, force: true });
      await copyDirectory(source, canonical);
      return;
    }
    await mirrorDirectory(source, canonical);
    return;
  }
  if (!sourceStats.isFile()) throw new Error('retained projection has an unsupported path type');
  const canonicalStats = await lstat(canonical).catch(() => null);
  if (canonicalStats && !canonicalStats.isFile()) {
    await rm(canonical, { recursive: true, force: true });
  }
  await mkdir(dirname(canonical), { recursive: true });
  if (canonicalStats?.isFile()) await writeFile(canonical, await readFile(source));
  else await copyFile(source, canonical);
}

async function copyDirectory(source: string, canonical: string): Promise<void> {
  await mkdir(canonical, { recursive: true });
  for (const entry of await readdir(source)) {
    await mirrorCowToCanonical(join(source, entry), join(canonical, entry));
  }
}

async function mirrorDirectory(source: string, canonical: string): Promise<void> {
  const sourceNames = new Set(await readdir(source));
  for (const name of await readdir(canonical)) {
    if (!sourceNames.has(name)) await rm(join(canonical, name), { recursive: true, force: true });
  }
  for (const name of sourceNames) {
    await mirrorCowToCanonical(join(source, name), join(canonical, name));
  }
}
