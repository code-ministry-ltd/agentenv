import { lstat, readdir, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { storeToken, type Adapter } from './adapter.js';
import type { RawMappingV2 } from './adapter-v2.js';
import type { Paths } from './paths.js';

/** One file contributed by a raw mapping, named relative to the mapping root. */
export interface RawFile {
  relativePath: string;
  sourcePath: string;
}

export interface ListRawFilesOptions {
  /** Derived views intentionally contain links back to canonical/user files. */
  allowExternalSymlinks?: boolean;
}

/** The canonical store root for one adapter raw mapping in one environment. */
export function rawMappingStoreRoot(
  paths: Paths,
  adapter: Adapter,
  env: string,
  mapping: RawMappingV2,
): string {
  return join(
    paths.envDir(env),
    'files',
    storeToken(adapter),
    mapping.storeRelativePath,
  );
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function assertSafeRelative(value: string): void {
  if (
    value === '' ||
    value === '.' ||
    value === '..' ||
    isAbsolute(value) ||
    value.split(/[\\/]/).some((segment) => segment === '..')
  ) {
    throw new Error(`unsafe raw mapping path '${value}'`);
  }
}

/**
 * Enumerate regular files recursively without following directory symlinks.
 *
 * Canonical raw trees reject links that resolve outside their own root. This is
 * the filesystem half of the adapter contract's lexical traversal check: a
 * seemingly harmless `agents/reviewer.toml` must not smuggle `/etc/passwd` (or
 * another user's file) into a harness through a symlink.
 */
export async function listRawFiles(
  root: string,
  options: ListRawFilesOptions = {},
): Promise<RawFile[]> {
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  if (!rootStat.isDirectory()) throw new Error(`raw mapping root is not a directory: ${root}`);

  const lexicalRoot = resolve(root);
  const resolvedRoot = await realpath(root);
  const out: RawFile[] = [];

  const visit = async (dir: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const sourcePath = join(dir, entry.name);
      const relativePath = relative(lexicalRoot, sourcePath);
      assertSafeRelative(relativePath);
      if (!isContained(lexicalRoot, resolve(sourcePath))) {
        throw new Error(`raw mapping path escapes its root: ${sourcePath}`);
      }
      if (entry.isDirectory()) {
        await visit(sourcePath);
        continue;
      }
      if (entry.isFile()) {
        out.push({ relativePath, sourcePath });
        continue;
      }
      if (entry.isSymbolicLink()) {
        if (!options.allowExternalSymlinks) {
          const target = await realpath(resolve(dirname(sourcePath), await readlink(sourcePath)));
          if (!isContained(resolvedRoot, target)) {
            throw new Error(`raw mapping symlink escapes its root: ${sourcePath}`);
          }
        }
        // A symlink is one opaque raw leaf. In particular, never recurse through
        // a directory symlink and accidentally enumerate outside the mapping.
        out.push({ relativePath, sourcePath });
        continue;
      }
      throw new Error(`raw mapping contains an unsupported filesystem entry: ${sourcePath}`);
    }
  };

  await visit(lexicalRoot);
  return out;
}
