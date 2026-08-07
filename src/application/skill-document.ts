import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { validateSkillName } from '../content-items.js';
import type { Paths } from '../paths.js';
import { validateEnvName } from '../store.js';
import type {
  ContentName,
  EnvironmentName,
  Revision,
  SkillDocument,
} from '../ui/contract.js';

export interface ReadSkillDocumentInput {
  paths: Paths;
  environment: unknown;
  skill: unknown;
}

export type SkillDocumentInputField = 'environment' | 'skill';

export type ReadSkillDocumentResult =
  | { status: 'loaded'; document: SkillDocument }
  | { status: 'invalid'; field: SkillDocumentInputField }
  | { status: 'not-found' }
  | { status: 'unsafe' }
  | { status: 'stale' }
  | { status: 'failure' };

export interface SkillDocumentFileSystem {
  lstat(path: string, options: { bigint: true }): Promise<BigIntStats>;
  open(path: string, flags: number): Promise<FileHandle>;
}

export interface ReadSkillDocumentDependencies {
  fileSystem: SkillDocumentFileSystem;
}

const DEFAULT_DEPENDENCIES: ReadSkillDocumentDependencies = {
  fileSystem: { lstat, open },
};

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}

function stableStatsEqual(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function locationRecord(stats: BigIntStats): Record<string, string> {
  return {
    device: String(stats.dev),
    inode: String(stats.ino),
    mode: String(stats.mode & 0o7777n),
  };
}

function revisionFor(input: {
  environment: string;
  skill: string;
  ancestors: readonly BigIntStats[];
  file: BigIntStats;
  bytes: Buffer;
}): Revision {
  const value = {
    locator: { environment: input.environment, skill: input.skill },
    ancestors: input.ancestors.map(locationRecord),
    file: {
      ...locationRecord(input.file),
      digest: createHash('sha256').update(input.bytes).digest('hex'),
    },
  };
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('base64url') as Revision;
}

type PathReadFailure = 'not-found' | 'unsafe' | 'failure';

function classifyPathError(error: unknown): PathReadFailure {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'not-found';
  if (code === 'ELOOP') return 'unsafe';
  return 'failure';
}

async function readDirectory(
  path: string,
  fileSystem: SkillDocumentFileSystem,
): Promise<BigIntStats | PathReadFailure> {
  let stats: BigIntStats;
  try {
    stats = await fileSystem.lstat(path, { bigint: true });
  } catch (error) {
    return classifyPathError(error);
  }
  return stats.isDirectory() && !stats.isSymbolicLink() ? stats : 'unsafe';
}

/**
 * Load exactly one canonical SKILL.md through a stable, no-follow descriptor.
 * The operation is read-only and never returns a local filesystem path.
 */
export async function readSkillDocument(
  input: ReadSkillDocumentInput,
  dependencies: ReadSkillDocumentDependencies = DEFAULT_DEPENDENCIES,
): Promise<ReadSkillDocumentResult> {
  if (typeof input.environment !== 'string' || validateEnvName(input.environment) !== null) {
    return { status: 'invalid', field: 'environment' };
  }
  if (typeof input.skill !== 'string' || validateSkillName(input.skill) !== null) {
    return { status: 'invalid', field: 'skill' };
  }

  const store = resolve(input.paths.store);
  const environments = resolve(input.paths.environments);
  if (
    !isAbsolute(input.paths.store) ||
    !isAbsolute(input.paths.environments) ||
    !contained(store, environments)
  ) {
    return { status: 'unsafe' };
  }
  const environment = join(environments, input.environment);
  const skills = join(environment, 'skills');
  const skill = join(skills, input.skill);
  const documentPath = join(skill, 'SKILL.md');
  const ancestorPaths = [store, environments, environment, skills, skill] as const;
  if (!ancestorPaths.every((path) => contained(store, path))) return { status: 'unsafe' };

  const beforeAncestors: BigIntStats[] = [];
  for (const path of ancestorPaths) {
    const observed = await readDirectory(path, dependencies.fileSystem);
    if (typeof observed === 'string') return { status: observed };
    beforeAncestors.push(observed);
  }

  let handle: FileHandle;
  try {
    handle = await dependencies.fileSystem.open(
      documentPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    return { status: classifyPathError(error) };
  }

  try {
    const beforeFile = await handle.stat({ bigint: true });
    if (!beforeFile.isFile() || beforeFile.isSymbolicLink()) return { status: 'unsafe' };
    const bytes = await handle.readFile();
    const afterFile = await handle.stat({ bigint: true });
    if (!afterFile.isFile() || !stableStatsEqual(beforeFile, afterFile)) {
      return { status: 'stale' };
    }

    let currentFile: BigIntStats;
    try {
      currentFile = await dependencies.fileSystem.lstat(documentPath, { bigint: true });
    } catch (error) {
      return { status: classifyPathError(error) === 'failure' ? 'failure' : 'stale' };
    }
    if (!currentFile.isFile() || currentFile.isSymbolicLink()) return { status: 'unsafe' };
    if (!stableStatsEqual(currentFile, afterFile)) return { status: 'stale' };

    for (let index = 0; index < ancestorPaths.length; index += 1) {
      let current: BigIntStats;
      try {
        current = await dependencies.fileSystem.lstat(ancestorPaths[index]!, { bigint: true });
      } catch (error) {
        return { status: classifyPathError(error) === 'failure' ? 'failure' : 'stale' };
      }
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        !stableStatsEqual(beforeAncestors[index]!, current)
      ) {
        return { status: 'stale' };
      }
    }

    return {
      status: 'loaded',
      document: {
        environment: input.environment as EnvironmentName,
        skill: input.skill as ContentName,
        text: bytes.toString('utf8'),
        revision: revisionFor({
          environment: input.environment,
          skill: input.skill,
          ancestors: beforeAncestors,
          file: afterFile,
          bytes,
        }),
      },
    };
  } catch {
    return { status: 'failure' };
  } finally {
    await handle.close().catch(() => undefined);
  }
}
