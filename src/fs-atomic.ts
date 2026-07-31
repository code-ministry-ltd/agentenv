import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * Write a file atomically: stage the bytes in a sibling temp file, then rename
 * it into place. `rename(2)` is atomic within a filesystem, so a crash mid-write
 * can only leave debris (the temp file), never a half-written destination — the
 * invariant the write-ahead journal (task 1.2) and content-addressed backups
 * depend on. The parent directory is created if missing.
 */
export async function writeFileAtomic(path: string, data: Buffer | string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  try {
    await writeFile(tmp, data);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
