/** A no-follow identity captured at a destructive filesystem boundary. */
export type PathIdentity =
  | { kind: 'absent' }
  | { kind: 'file'; digest: string; mode: number }
  | { kind: 'directory'; digest: string; mode: number }
  | { kind: 'symlink'; target: string };

export type PreCommitRecoveryDecision =
  | { action: 'skip-pre-state' }
  | { action: 'undo-post-state' }
  | { action: 'rescue-third-identity'; observed: PathIdentity };

/** Compare complete typed identities; matching bytes with a different type or mode is different. */
export function identitiesEqual(left: PathIdentity, right: PathIdentity): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case 'absent':
      return true;
    case 'symlink':
      return right.kind === 'symlink' && left.target === right.target;
    case 'file':
      return right.kind === 'file' && left.digest === right.digest && left.mode === right.mode;
    case 'directory':
      return (
        right.kind === 'directory' && left.digest === right.digest && left.mode === right.mode
      );
  }
}

/** Capture a complete no-follow identity for destructive/reconciliation checks. */
export async function capturePathIdentity(path: string): Promise<PathIdentity> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    throw err;
  }
  if (stats.isSymbolicLink()) return { kind: 'symlink', target: await readlink(path) };
  const mode = stats.mode & 0o7777;
  if (stats.isFile()) {
    return {
      kind: 'file',
      digest: createHash('sha256').update(await readFile(path)).digest('hex'),
      mode,
    };
  }
  if (stats.isDirectory()) {
    const hash = createHash('sha256');
    const walk = async (directory: string, prefix: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const child = join(directory, entry.name);
        const childStats = await lstat(child);
        hash.update(relative).update('\0').update(String(childStats.mode & 0o7777)).update('\0');
        if (childStats.isSymbolicLink()) {
          hash.update('l\0').update(await readlink(child)).update('\0');
        } else if (childStats.isDirectory()) {
          hash.update('d\0');
          await walk(child, relative);
        } else if (childStats.isFile()) {
          hash.update('f\0').update(await readFile(child)).update('\0');
        }
      }
    };
    await walk(path, '');
    return { kind: 'directory', digest: hash.digest('hex'), mode };
  }
  throw new Error(`unsupported path type at ${path}`);
}

/**
 * Decide recovery before the command commit point without clobbering an identity
 * the interrupted operation did not create.
 */
export function decidePreCommitRecovery(input: {
  pre: PathIdentity;
  post: PathIdentity;
  observed: PathIdentity;
}): PreCommitRecoveryDecision {
  if (identitiesEqual(input.observed, input.pre)) return { action: 'skip-pre-state' };
  if (identitiesEqual(input.observed, input.post)) return { action: 'undo-post-state' };
  return { action: 'rescue-third-identity', observed: input.observed };
}
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
