import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * Write a file atomically and durably: stage the bytes in a sibling temp file,
 * `fsync` them, then rename it into place. `rename(2)` is atomic within a
 * filesystem, so a crash mid-write can only leave debris (the temp file), never
 * a half-written destination — the invariant the write-ahead journal (task 1.2)
 * and content-addressed backups depend on. The `fsync` on the temp file flushes
 * its bytes before the rename, so the durable file is never truncated/partial
 * after a power loss (not merely a process crash). A best-effort `fsync` of the
 * parent directory afterwards persists the rename itself; it is skipped where
 * the platform cannot fsync a directory (e.g. Windows), which costs power-loss
 * durability of the directory entry but never process-crash consistency. The
 * parent directory is created if missing.
 */
export async function writeFileAtomic(
  path: string,
  data: Buffer | string,
  options: { mode?: number } = {},
): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  try {
    const handle = await open(tmp, 'w', options.mode);
    try {
      await handle.writeFile(data);
      await handle.sync(); // fsync: flush the bytes to disk before the rename
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  // Best-effort: fsync the directory so the rename (the new entry) survives a
  // power loss too. Unsupported on some platforms; a failure here does not
  // affect process-crash consistency, so it is safe to ignore.
  try {
    const dirHandle = await open(dir, 'r');
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    // directory fsync not permitted/supported — acceptable.
  }
}
