import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { chmod, lstat, mkdir, open, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseFrontmatter, validateSkillDir, validateSkillName } from '../content-items.js';
import type { CommandPlan } from '../command-plan.js';
import { CommandPathPreconditionError } from '../command-wal.js';
import {
  capturePathIdentity,
  capturePathLocationIdentity,
  identitiesEqual,
  type PathIdentity,
} from '../path-identity.js';
import type { Paths } from '../paths.js';
import { readState } from '../state.js';
import {
  StagedCommandExpectedIdentityError,
  StagedCommandPreconditionError,
} from '../staged-command.js';
import { validateEnvName } from '../store.js';
import type {
  ContentName,
  EnvironmentName,
  Revision,
  SkillDocument,
} from '../ui/contract.js';
import type { ContentTransferRuntime } from './content-transfer-runtime.js';

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

export interface SkillDocumentValidationIssue {
  field: 'frontmatter' | 'name';
  code: 'invalid-frontmatter' | 'missing-name' | 'invalid-name' | 'name-mismatch';
  message: string;
  line?: number;
}

export interface SaveSkillDocumentFaults {
  afterStage?: () => Promise<void>;
  afterApply?: (operationId: string) => Promise<void>;
  afterPersist?: (plan: CommandPlan) => Promise<void>;
}

export interface SaveSkillDocumentInput {
  paths: Paths;
  environment: unknown;
  skill: unknown;
  text: unknown;
  expectedRevision: unknown;
  runtime: ContentTransferRuntime;
  faults?: SaveSkillDocumentFaults;
}

export type SaveSkillDocumentInputField = SkillDocumentInputField | 'text' | 'expectedRevision';

export type SaveSkillDocumentResult =
  | {
      status: 'saved';
      publication: 'complete';
      transactionId: string;
      document?: SkillDocument;
      refreshRequired: boolean;
    }
  | {
      status: 'git-pending';
      publication: 'git-pending';
      transactionId: string;
      document?: SkillDocument;
      refreshRequired: boolean;
    }
  | { status: 'invalid'; field: SaveSkillDocumentInputField }
  | { status: 'validation'; issues: readonly SkillDocumentValidationIssue[] }
  | { status: 'not-found' }
  | { status: 'unsafe' }
  | { status: 'stale' }
  | { status: 'pending-recovery'; transactionId: string }
  | { status: 'failure' };

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

function validateEditedSkill(skill: string, text: string): SkillDocumentValidationIssue[] {
  const frontmatter = parseFrontmatter(text);
  if (frontmatter === null) {
    return [{
      field: 'frontmatter',
      code: 'invalid-frontmatter',
      message: 'SKILL.md must start with valid YAML frontmatter.',
      line: 1,
    }];
  }
  if (typeof frontmatter.name !== 'string' || frontmatter.name === '') {
    return [{
      field: 'name',
      code: 'missing-name',
      message: 'Frontmatter must include a name.',
    }];
  }
  const nameLine = text.split(/\r?\n/).findIndex((line) => /^\s*name\s*:/.test(line));
  const location = nameLine < 0 ? {} : { line: nameLine + 1 };
  if (validateSkillName(frontmatter.name) !== null) {
    return [{
      field: 'name',
      code: 'invalid-name',
      message: 'The frontmatter name must be lowercase kebab-case.',
      ...location,
    }];
  }
  if (frontmatter.name !== skill) {
    return [{
      field: 'name',
      code: 'name-mismatch',
      message: 'The frontmatter name must match the skill folder name.',
      ...location,
    }];
  }
  return [];
}

function asSaveReadFailure(result: Exclude<ReadSkillDocumentResult, { status: 'loaded' }>): SaveSkillDocumentResult {
  return result.status === 'invalid'
    ? { status: 'invalid', field: result.field }
    : { status: result.status };
}

function validOpenOutcome(value: unknown):
  | { status: 'ready' }
  | { status: 'pending-recovery'; transactionId: string }
  | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const candidate = value as { status?: unknown; transactionId?: unknown };
  if (candidate.status === 'ready') return { status: 'ready' };
  if (candidate.status === 'pending-recovery' && typeof candidate.transactionId === 'string') {
    return { status: 'pending-recovery', transactionId: candidate.transactionId };
  }
  return undefined;
}

/** Validate and publish exactly one selected SKILL.md through the command WAL. */
export async function saveSkillDocument(
  input: SaveSkillDocumentInput,
): Promise<SaveSkillDocumentResult> {
  if (typeof input.environment !== 'string' || validateEnvName(input.environment) !== null) {
    return { status: 'invalid', field: 'environment' };
  }
  if (typeof input.skill !== 'string' || validateSkillName(input.skill) !== null) {
    return { status: 'invalid', field: 'skill' };
  }
  if (typeof input.text !== 'string') return { status: 'invalid', field: 'text' };
  if (
    typeof input.expectedRevision !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(input.expectedRevision)
  ) {
    return { status: 'invalid', field: 'expectedRevision' };
  }

  const issues = validateEditedSkill(input.skill, input.text);
  if (issues.length > 0) return { status: 'validation', issues };

  try {
    const pending = (await readState(input.paths)).commands[0];
    if (pending) return { status: 'pending-recovery', transactionId: pending.transactionId };
  } catch {
    return { status: 'failure' };
  }

  try {
    const outcome = validOpenOutcome(await input.runtime.open());
    if (outcome === undefined) return { status: 'failure' };
    if (outcome.status === 'pending-recovery') return outcome;
  } catch {
    return { status: 'failure' };
  }

  const transactionId = `save-skill-${randomUUID()}`;
  const stagingRoot = join(input.paths.live, 'commands', transactionId);
  const stagedSkill = join(stagingRoot, input.skill);
  const stagedDocument = join(stagedSkill, 'SKILL.md');
  const environmentPath = input.paths.envDir(input.environment);
  const skillsPath = join(environmentPath, 'skills');
  const skillPath = join(skillsPath, input.skill);
  const documentPath = join(skillPath, 'SKILL.md');
  let retainStaging = false;
  let observedDocument: SkillDocument | undefined;
  let publicationOutcome: 'complete' | 'git-pending' | undefined;
  try {
    const current = await readSkillDocument({
      paths: input.paths,
      environment: input.environment,
      skill: input.skill,
    });
    if (current.status !== 'loaded') return asSaveReadFailure(current);
    if (current.document.revision !== input.expectedRevision) return { status: 'stale' };

    const documentIdentity = await capturePathIdentity(documentPath);
    if (documentIdentity.kind !== 'file') return { status: 'unsafe' };
    const documentStats = await lstat(documentPath, { bigint: true });
    if (!documentStats.isFile() || documentStats.isSymbolicLink()) return { status: 'unsafe' };
    const ancestorPaths = [input.paths.store, input.paths.environments, environmentPath, skillsPath, skillPath];
    const ancestorIdentities: PathIdentity[] = [];
    for (const path of ancestorPaths) {
      const identity = await capturePathLocationIdentity(path);
      if (identity.kind !== 'directory-location') return { status: 'unsafe' };
      ancestorIdentities.push(identity);
    }
    const confirmed = await readSkillDocument({
      paths: input.paths,
      environment: input.environment,
      skill: input.skill,
    });
    if (
      confirmed.status !== 'loaded' ||
      confirmed.document.revision !== current.document.revision ||
      !identitiesEqual(await capturePathIdentity(documentPath), documentIdentity)
    ) {
      return { status: 'stale' };
    }

    await mkdir(stagedSkill, { recursive: true });
    await writeFile(stagedDocument, input.text);
    await chmod(stagedDocument, documentIdentity.mode);
    const stagedValidation = await validateSkillDir(stagedSkill);
    if ('error' in stagedValidation) {
      return {
        status: 'validation',
        issues: [{
          field: 'frontmatter',
          code: 'invalid-frontmatter',
          message: 'SKILL.md does not satisfy the skill document rules.',
        }],
      };
    }
    await input.faults?.afterStage?.();

    const publication = await input.runtime.publish({
      paths: input.paths,
      transactionId,
      kind: 'skill-document-save',
      stagingRoot,
      allowedRoots: [input.paths.store],
      entries: [{
        id: 'skill-document',
        target: documentPath,
        staged: stagedDocument,
        expectedPreIdentity: documentIdentity,
      }],
      preconditions: [
        ...ancestorPaths.slice(1).map((path, index) => ({
          id: `skill-document-ancestor-${index}`,
          path,
          expectedIdentity: ancestorIdentities[index + 1]!,
        })),
        {
          id: 'skill-document-source',
          path: documentPath,
          expectedIdentity: documentIdentity,
          observation: 'stable-file' as const,
          expectedEntry: {
            device: String(documentStats.dev),
            inode: String(documentStats.ino),
          },
        },
      ],
      gitSteps: [{
        id: 'save-skill-document',
        message: `agentenv: edit skill ${input.skill} in ${input.environment}`,
        paths: [documentPath],
      }],
      afterApply: async (operationId) => {
        const post = await readSkillDocument({
          paths: input.paths,
          environment: input.environment,
          skill: input.skill,
        });
        if (post.status !== 'loaded' || post.document.text !== input.text) {
          throw new StagedCommandExpectedIdentityError(operationId, documentPath, 'pre-apply');
        }
        observedDocument = post.document;
        await input.faults?.afterApply?.(operationId);
      },
      ...(input.faults?.afterPersist === undefined
        ? {}
        : { afterPersist: input.faults.afterPersist }),
    });
    if (publication.status !== 'complete' && publication.status !== 'git-pending') {
      return { status: 'failure' };
    }
    publicationOutcome = publication.status;

    const commands = (await readState(input.paths)).commands;
    const retained = commands.find((command) => command.transactionId === transactionId);
    const other = commands.find((command) => command.transactionId !== transactionId);
    if (retained) {
      retainStaging = retained.phase !== 'complete';
      if (retained.phase === 'complete') {
        return {
          status: 'saved', publication: 'complete', transactionId,
          ...(observedDocument ? { document: observedDocument } : {}),
          refreshRequired: observedDocument === undefined,
        };
      }
      if (retained.phase === 'committed' || retained.phase === 'git-pending') {
        return {
          status: 'git-pending', publication: 'git-pending', transactionId,
          ...(observedDocument ? { document: observedDocument } : {}),
          refreshRequired: observedDocument === undefined,
        };
      }
      return { status: 'pending-recovery', transactionId };
    }
    if (other) {
      retainStaging = true;
      return { status: 'pending-recovery', transactionId: other.transactionId };
    }
    if (publication.status === 'git-pending') return { status: 'failure' };
    return {
      status: 'saved', publication: 'complete', transactionId,
      ...(observedDocument ? { document: observedDocument } : {}),
      refreshRequired: observedDocument === undefined,
    };
  } catch (error) {
    try {
      const commands = (await readState(input.paths)).commands;
      const retained = commands.find((command) => command.transactionId === transactionId);
      if (retained?.phase === 'complete') {
        return {
          status: 'saved', publication: 'complete', transactionId,
          ...(observedDocument ? { document: observedDocument } : {}),
          refreshRequired: observedDocument === undefined,
        };
      }
      if (retained?.phase === 'committed' || retained?.phase === 'git-pending') {
        retainStaging = true;
        return {
          status: 'git-pending', publication: 'git-pending', transactionId,
          ...(observedDocument ? { document: observedDocument } : {}),
          refreshRequired: observedDocument === undefined,
        };
      }
      if (retained) {
        retainStaging = true;
        return { status: 'pending-recovery', transactionId };
      }
      const other = commands[0];
      if (other) {
        retainStaging = true;
        return { status: 'pending-recovery', transactionId: other.transactionId };
      }
    } catch {
      if (observedDocument !== undefined && publicationOutcome !== undefined) {
        retainStaging = publicationOutcome === 'git-pending';
        return publicationOutcome === 'git-pending'
          ? {
              status: 'git-pending',
              publication: 'git-pending',
              transactionId,
              document: observedDocument,
              refreshRequired: false,
            }
          : {
              status: 'saved',
              publication: 'complete',
              transactionId,
              document: observedDocument,
              refreshRequired: false,
            };
      }
      return { status: 'failure' };
    }
    if (
      error instanceof StagedCommandExpectedIdentityError ||
      error instanceof StagedCommandPreconditionError ||
      error instanceof CommandPathPreconditionError
    ) {
      return { status: 'stale' };
    }
    return { status: 'failure' };
  } finally {
    if (!retainStaging) await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    await input.runtime.close().catch(() => undefined);
  }
}
