import { createHash } from 'node:crypto';
import { access, readFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './fs-atomic.js';
import type { Paths } from './paths.js';

/**
 * A reference to a file's pre-mutation bytes, stored in the state manifest so a
 * mutation can be undone (design: "back up any user file before its first
 * mutation").
 *
 * - `content` — the bytes were copied into the content-addressed store under
 *   `hash`; undo restores them.
 * - `absent` — the path did not exist before the mutation (a CREATE has no
 *   prior bytes); undo therefore *deletes* the path. Modelling "didn't exist"
 *   as a first-class ref keeps undo uniform: it is always `restore(ref, path)`.
 */
export type BackupRef = { kind: 'content'; hash: string } | { kind: 'absent' };

/** The on-disk location of the bytes for a content hash. */
function backupPath(paths: Paths, hash: string): string {
  return join(paths.backups, hash);
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy the current bytes at `absPath` into the content-addressed backup store,
 * keyed by their sha256, and return a {@link BackupRef} pointing at them.
 * Identical content is stored once (the key is the hash, so a re-backup of
 * unchanged bytes is a no-op). When `absPath` does not exist, no bytes are
 * stored and an `absent` ref is returned so the caller records "undo = delete".
 * Backups live under `paths.backups` and are never synced.
 */
export async function backup(paths: Paths, absPath: string): Promise<BackupRef> {
  let data: Buffer;
  try {
    data = await readFile(absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'absent' };
    }
    throw err;
  }
  const hash = createHash('sha256').update(data).digest('hex');
  const dest = backupPath(paths, hash);
  if (!(await exists(dest))) {
    await writeFileAtomic(dest, data);
  }
  return { kind: 'content', hash };
}

/**
 * Return `destPath` to the state captured by `ref`. For a `content` ref the
 * backed-up bytes are written back atomically; for an `absent` ref the path is
 * removed (its pre-mutation state was "did not exist"). Restoring is idempotent,
 * so it is safe to call during crash recovery whether or not the mutation it
 * reverses actually completed.
 */
export async function restore(paths: Paths, ref: BackupRef, destPath: string): Promise<void> {
  if (ref.kind === 'absent') {
    await rm(destPath, { recursive: true, force: true });
    return;
  }
  const data = await readFile(backupPath(paths, ref.hash));
  await writeFileAtomic(destPath, data);
}
