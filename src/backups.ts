import { createHash, randomBytes } from 'node:crypto';
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from './fs-atomic.js';
import type { Paths } from './paths.js';

/**
 * A reference to a path's pre-mutation state, stored in the state manifest so a
 * mutation can be undone (design: "back up any user file before its first
 * mutation"). Dispatch is by `lstat`, so a symlink is captured AS a symlink and
 * never followed.
 *
 * - `content` — a regular file; its bytes were copied into the content-addressed
 *   store under `hash`; undo restores them.
 * - `symlink` — a symbolic link; `target` is its (unresolved) link text; undo
 *   recreates the link, even if it dangles — never a regular file.
 * - `directory` — a directory subtree; it was copied verbatim (nested symlinks
 *   preserved) into `backups/<id>`; undo recreates the tree at the path.
 * - `absent` — the path did not exist before the mutation (a CREATE has no
 *   prior state); undo therefore *deletes* the path. Modelling "didn't exist"
 *   as a first-class ref keeps undo uniform: it is always `restore(ref, path)`.
 */
export type BackupRef =
  | { kind: 'content'; hash: string }
  | { kind: 'symlink'; target: string }
  | { kind: 'directory'; id: string }
  | { kind: 'absent' };

/** The on-disk location of the bytes for a content hash. */
function backupPath(paths: Paths, hash: string): string {
  return join(paths.backups, hash);
}

/** The on-disk location of a directory subtree backup. */
function dirBackupPath(paths: Paths, id: string): string {
  return join(paths.backups, id);
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
 * Recursively copy `src` to `dest`, preserving nested symlinks AS symlinks
 * (never dereferenced) and regular-file bytes. Uses `readdir(..., withFileTypes)`
 * so each entry is dispatched by its own lstat-equivalent type. Parent dirs are
 * created as needed. Special files (sockets, fifos, devices) are skipped.
 */
async function copyTree(src: string, dest: string): Promise<void> {
  const sourceMode = (await lstat(src)).mode & 0o7777;
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isSymbolicLink()) {
      await symlink(await readlink(from), to);
    } else if (entry.isDirectory()) {
      await copyTree(from, to);
    } else if (entry.isFile()) {
      await copyFile(from, to);
    }
    // else: a special file we cannot meaningfully back up — skip it.
  }
  await chmod(dest, sourceMode);
}

/**
 * Capture the current state at `absPath` into the backup store and return a
 * {@link BackupRef} that {@link restore} can reverse. Dispatch is by `lstat`, so
 * a symlink is never followed:
 *
 * - regular file → content-addressed by sha256 (identical bytes stored once);
 * - symlink → its link text (works for dangling links too);
 * - directory → a verbatim recursive copy under a generated id;
 * - absent (ENOENT) → an `absent` ref, so the caller records "undo = delete".
 *
 * Backups live under `paths.backups` and are never synced.
 */
export async function backup(paths: Paths, absPath: string): Promise<BackupRef> {
  let stats;
  try {
    stats = await lstat(absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'absent' };
    }
    throw err;
  }

  if (stats.isSymbolicLink()) {
    return { kind: 'symlink', target: await readlink(absPath) };
  }

  if (stats.isDirectory()) {
    const id = `dir-${randomBytes(16).toString('hex')}`;
    await copyTree(absPath, dirBackupPath(paths, id));
    return { kind: 'directory', id };
  }

  if (stats.isFile()) {
    const data = await readFile(absPath);
    const hash = createHash('sha256').update(data).digest('hex');
    const dest = backupPath(paths, hash);
    if (!(await exists(dest))) {
      await writeFileAtomic(dest, data);
    }
    return { kind: 'content', hash };
  }

  throw new Error(`agentenv: cannot back up ${absPath}: unsupported file type`);
}

/**
 * Return `destPath` to the state captured by `ref`, recreating whatever kind it
 * was:
 *
 * - `content` → the backed-up bytes are written back atomically;
 * - `symlink` → the link is recreated (dangling or not), never a regular file;
 * - `directory` → the subtree is recreated (nested symlinks preserved);
 * - `absent` → the path is removed (its pre-mutation state was "did not exist").
 *
 * The destination is cleared first for symlink/directory refs so a type change
 * (e.g. a file that a mutation replaced with a directory) is reversed cleanly.
 * Restoring is idempotent, so it is safe during crash recovery whether or not
 * the mutation it reverses actually completed.
 */
export async function restore(paths: Paths, ref: BackupRef, destPath: string): Promise<void> {
  if (ref.kind === 'absent') {
    await rm(destPath, { recursive: true, force: true });
    return;
  }
  if (ref.kind === 'content') {
    const data = await readFile(backupPath(paths, ref.hash));
    await writeFileAtomic(destPath, data);
    return;
  }
  if (ref.kind === 'symlink') {
    await rm(destPath, { recursive: true, force: true });
    await mkdir(dirname(destPath), { recursive: true });
    await symlink(ref.target, destPath);
    return;
  }
  // directory
  await rm(destPath, { recursive: true, force: true });
  await mkdir(dirname(destPath), { recursive: true });
  await copyTree(dirBackupPath(paths, ref.id), destPath);
}
