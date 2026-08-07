import { lstat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}

async function existingDirectory(path: string, label: string): Promise<boolean> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`${label} has a symlinked ancestor: ${path}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`${label} has a non-directory ancestor: ${path}`);
  }
  return true;
}

/**
 * Validate containment component-by-component with lstat, never realpath-following
 * a symlink between the trusted root and the path being accessed.
 */
export async function assertNoFollowContainment(
  root: string,
  candidate: string,
  options: { includeCandidate?: boolean; label: string },
): Promise<void> {
  const physicalRoot = resolve(root);
  const boundary = resolve(options.includeCandidate ? candidate : dirname(candidate));
  if (!isContained(physicalRoot, boundary)) {
    throw new Error(`${options.label} is outside its allowed physical root: ${candidate}`);
  }
  if (!(await existingDirectory(physicalRoot, options.label))) return;

  let current = physicalRoot;
  const rel = relative(physicalRoot, boundary);
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (!(await existingDirectory(current, options.label))) return;
  }
}
