import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CommandPlan } from '../command-plan.js';
import { CommandPathPreconditionError } from '../command-wal.js';
import { parseEnvConfig, scaffoldEnvYaml } from '../env-config.js';
import { readGlobalStack } from '../engine.js';
import {
  capturePathIdentity,
  capturePathLocationIdentity,
  identitiesEqual,
  type PathIdentity,
} from '../path-identity.js';
import { assertNoFollowContainment } from '../path-containment.js';
import type { Paths } from '../paths.js';
import { readSessionRegistry } from '../session/registry.js';
import { readState } from '../state.js';
import { STORE_README, validateEnvName } from '../store.js';
import { withLock } from '../lock.js';
import {
  StagedCommandExpectedIdentityError,
  StagedCommandPreconditionError,
  type StagedCommandEntry,
} from '../staged-command.js';
import type {
  EnvironmentDeleteRuntime,
  EnvironmentLifecycleRuntime,
} from './environment-lifecycle-runtime.js';

/** Deterministic race/failure seams used at durable publication boundaries. */
export interface EnvironmentLifecycleFaults {
  afterSourceCopy?: () => Promise<void>;
  afterStage?: () => Promise<void>;
  afterApply?: (operationId: string) => Promise<void>;
  afterPersist?: (plan: CommandPlan) => Promise<void>;
}

interface EnvironmentLifecycleInput {
  paths: Paths;
  name: string;
  runtime: EnvironmentLifecycleRuntime;
  faults?: EnvironmentLifecycleFaults;
}

export interface CreateEnvironmentInput extends EnvironmentLifecycleInput {
  description?: string;
}

export interface CloneEnvironmentInput extends EnvironmentLifecycleInput {
  source: string;
}

export interface EnvironmentActivity {
  session: boolean;
  globalStack: boolean;
  materialised: boolean;
}

export type EnvironmentDeleteInspection =
  | {
      status: 'ready';
      name: string;
      targetIdentity: PathIdentity;
      containerIdentity: PathIdentity;
    }
  | { status: 'invalid'; field: 'name'; message: string }
  | { status: 'not-found'; name: string }
  | { status: 'active'; name: string; activity: EnvironmentActivity }
  | { status: 'failure'; message: string };

export interface DeleteEnvironmentInput {
  paths: Paths;
  name: string;
  runtime: EnvironmentDeleteRuntime;
  expectedTargetIdentity?: PathIdentity;
  expectedContainerIdentity?: PathIdentity;
  faults?: Pick<EnvironmentLifecycleFaults, 'afterStage' | 'afterApply' | 'afterPersist'>;
}

export type EnvironmentDeleteResult =
  | {
      status: 'deleted' | 'git-pending';
      operation: 'delete';
      name: string;
      transactionId: string;
      publication: 'complete' | 'git-pending';
    }
  | Exclude<EnvironmentDeleteInspection, { status: 'ready' }>
  | { status: 'stale'; field: 'target' | 'container'; name: string; message: string }
  | { status: 'pending-recovery'; transactionId: string }
  | { status: 'drift-blocked'; secretBearing: boolean }
  | { status: 'failure'; message: string };

export type EnvironmentLifecycleResult =
  | {
      status: 'created';
      operation: 'create' | 'clone';
      name: string;
      source?: string;
      transactionId: string;
      publication: 'complete';
    }
  | {
      status: 'git-pending';
      operation: 'create' | 'clone';
      name: string;
      source?: string;
      transactionId: string;
      publication: 'git-pending';
    }
  | {
      status: 'invalid';
      field: 'name' | 'source';
      message: string;
    }
  | { status: 'exists'; name: string }
  | { status: 'source-not-found'; source: string }
  | {
      status: 'stale';
      field: 'source' | 'destination';
      name: string;
      message: string;
    }
  | { status: 'pending-recovery'; transactionId: string }
  | { status: 'failure'; message: string };

class StaleEnvironmentError extends Error {
  constructor(
    readonly field: 'source' | 'destination',
    readonly environmentName: string,
    message: string,
  ) {
    super(message);
    this.name = 'StaleEnvironmentError';
  }
}

class EnvironmentActiveDuringDeletionError extends Error {
  constructor(readonly activity: EnvironmentActivity) {
    super('environment became active during deletion');
    this.name = 'EnvironmentActiveDuringDeletionError';
  }
}

export async function environmentActivity(
  paths: Paths,
  name: string,
): Promise<EnvironmentActivity> {
  const [registry, manifest] = await Promise.all([
    readSessionRegistry(paths),
    readState(paths),
  ]);
  return {
    session: registry.bindings.some((binding) => binding.envs.includes(name)),
    globalStack: readGlobalStack(manifest).includes(name),
    materialised: manifest.items.some((item) => item.ownerEnv === name),
  };
}

export async function inspectEnvironmentDeletion(input: {
  paths: Paths;
  name: string;
}): Promise<EnvironmentDeleteInspection> {
  const nameError = validateEnvName(input.name);
  if (nameError) return { status: 'invalid', field: 'name', message: nameError };
  try {
    const containerIdentity = await captureEnvironmentContainerIdentity(input.paths);
    await assertNoFollowContainment(
      input.paths.environments,
      input.paths.envDir(input.name),
      { includeCandidate: true, label: 'environment deletion target' },
    );
    const targetIdentity = await capturePathIdentity(input.paths.envDir(input.name));
    if (targetIdentity.kind === 'absent') return { status: 'not-found', name: input.name };
    if (targetIdentity.kind !== 'directory') {
      return {
        status: 'failure',
        message: `environment '${input.name}' must be a physical directory`,
      };
    }
    const activity = await environmentActivity(input.paths, input.name);
    if (activity.session || activity.globalStack || activity.materialised) {
      return { status: 'active', name: input.name, activity };
    }
    return {
      status: 'ready',
      name: input.name,
      targetIdentity,
      containerIdentity,
    };
  } catch (error) {
    return { status: 'failure', message: (error as Error).message };
  }
}

export async function deleteEnvironment(
  input: DeleteEnvironmentInput,
): Promise<EnvironmentDeleteResult> {
  const inspected = await inspectEnvironmentDeletion({ paths: input.paths, name: input.name });
  if (inspected.status !== 'ready') return inspected;
  const expectedTargetIdentity = input.expectedTargetIdentity ?? inspected.targetIdentity;
  const expectedContainerIdentity = input.expectedContainerIdentity ?? inspected.containerIdentity;
  if (!identitiesEqual(expectedTargetIdentity, inspected.targetIdentity)) {
    return {
      status: 'stale',
      field: 'target',
      name: input.name,
      message: `environment '${input.name}' changed since planning`,
    };
  }
  if (!identitiesEqual(expectedContainerIdentity, inspected.containerIdentity)) {
    return {
      status: 'stale',
      field: 'container',
      name: input.name,
      message: 'environment container changed before deletion',
    };
  }

  const open = await input.runtime.open();
  if (open.status !== 'ready') return open;
  const afterOpen = await inspectEnvironmentDeletion({ paths: input.paths, name: input.name });
  if (afterOpen.status !== 'ready') {
    await input.runtime.close();
    return afterOpen;
  }
  if (!identitiesEqual(expectedTargetIdentity, afterOpen.targetIdentity)) {
    await input.runtime.close();
    return {
      status: 'stale',
      field: 'target',
      name: input.name,
      message: `environment '${input.name}' changed since planning`,
    };
  }
  if (!identitiesEqual(expectedContainerIdentity, afterOpen.containerIdentity)) {
    await input.runtime.close();
    return {
      status: 'stale',
      field: 'container',
      name: input.name,
      message: 'environment container changed before deletion',
    };
  }

  const transactionId = `remove-${input.name}-${randomUUID()}`;
  const stagingRoot = join(input.paths.live, 'commands', transactionId);
  const absent = join(stagingRoot, 'absent');
  try {
    await mkdir(stagingRoot, { recursive: true });
    await input.faults?.afterStage?.();
    const gitSteps = [{
      id: 'remove-environment',
      message: `agentenv: remove env ${input.name}`,
      paths: [input.paths.envDir(input.name)],
    }];
    const publication = await input.runtime.publish({
      paths: input.paths,
      transactionId,
      kind: 'environment-remove',
      stagingRoot,
      allowedRoots: [input.paths.store],
      entries: [{
        id: 'environment',
        target: input.paths.envDir(input.name),
        staged: absent,
        expectedPreIdentity: expectedTargetIdentity,
      }],
      preconditions: [{
        id: 'environment-container',
        path: input.paths.environments,
        expectedIdentity: expectedContainerIdentity,
      }],
      gitSteps,
      effectGuard: async (operationId, effect) => {
        if (operationId !== 'environment') {
          await effect();
          return;
        }
        await withLock(input.paths, async () => {
          const activity = await environmentActivity(input.paths, input.name);
          if (activity.session || activity.globalStack || activity.materialised) {
            throw new EnvironmentActiveDuringDeletionError(activity);
          }
          await effect();
        });
      },
      ...(input.faults?.afterApply ? { afterApply: input.faults.afterApply } : {}),
      ...(input.faults?.afterPersist ? { afterPersist: input.faults.afterPersist } : {}),
    });
    if (publication.status === 'git-pending') {
      return {
        status: 'git-pending',
        operation: 'delete',
        name: input.name,
        transactionId,
        publication: 'git-pending',
      };
    }
    await input.runtime.close();
    return {
      status: 'deleted',
      operation: 'delete',
      name: input.name,
      transactionId,
      publication: 'complete',
    };
  } catch (error) {
    if (!(await readState(input.paths)).commands.some(
      (command) => command.transactionId === transactionId,
    )) {
      await rm(stagingRoot, { recursive: true, force: true });
    }
    await input.runtime.close();
    if (error instanceof EnvironmentActiveDuringDeletionError) {
      return {
        status: 'active',
        name: input.name,
        activity: error.activity,
      };
    }
    if (error instanceof StagedCommandExpectedIdentityError) {
      return {
        status: 'stale',
        field: 'target',
        name: input.name,
        message: `environment '${input.name}' changed since planning`,
      };
    }
    const preconditionId = error instanceof StagedCommandPreconditionError
      ? error.preconditionId
      : error instanceof CommandPathPreconditionError
        ? error.operationId
        : undefined;
    if (preconditionId === 'environment-container') {
      return {
        status: 'stale',
        field: 'container',
        name: input.name,
        message: 'environment container changed before deletion',
      };
    }
    return { status: 'failure', message: (error as Error).message };
  }
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}

async function hasPathIdentity(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function captureEnvironmentContainerIdentity(paths: Paths): Promise<PathIdentity> {
  await assertNoFollowContainment(paths.store, paths.environments, {
    includeCandidate: true,
    label: 'environment container',
  });
  return capturePathLocationIdentity(paths.environments);
}

async function validateCloneTree(
  root: string,
  sourceName: string,
): Promise<PathIdentity> {
  const rootIdentity = await capturePathIdentity(root);
  if (rootIdentity.kind !== 'directory') {
    throw new Error(
      `source environment '${sourceName}' must be a physical directory, not ${rootIdentity.kind}`,
    );
  }

  const yamlIdentity = await capturePathIdentity(join(root, 'env.yaml'));
  if (yamlIdentity.kind !== 'file') {
    throw new Error(`source environment '${sourceName}' env.yaml must be a regular file`);
  }

  const physicalRoot = resolve(root);
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await readlink(path);
        if (isAbsolute(target)) {
          throw new Error(
            `source environment '${sourceName}' contains an absolute symlink: ${path}`,
          );
        }
        if (!isContained(physicalRoot, resolve(dirname(path), target))) {
          throw new Error(
            `source environment '${sourceName}' contains an out-of-tree symlink: ${path}`,
          );
        }
      } else if (entry.isDirectory()) {
        await walk(path);
      } else if (!entry.isFile()) {
        throw new Error(
          `source environment '${sourceName}' contains an unsupported filesystem entry: ${path}`,
        );
      }
    }
  };
  await walk(root);

  const afterValidation = await capturePathIdentity(root);
  if (!identitiesEqual(rootIdentity, afterValidation)) {
    throw new StaleEnvironmentError(
      'source',
      sourceName,
      `source environment '${sourceName}' changed while being copied`,
    );
  }
  return rootIdentity;
}

function invalid(
  field: 'name' | 'source',
  message: string,
): EnvironmentLifecycleResult {
  return { status: 'invalid', field, message };
}

export async function createEnvironment(
  input: CreateEnvironmentInput,
): Promise<EnvironmentLifecycleResult> {
  return publishEnvironment({
    ...input,
    operation: 'create',
    description: input.description ?? '',
  });
}

export async function cloneEnvironment(
  input: CloneEnvironmentInput,
): Promise<EnvironmentLifecycleResult> {
  return publishEnvironment({
    ...input,
    operation: 'clone',
    description: '',
  });
}

interface PublishEnvironmentInput extends EnvironmentLifecycleInput {
  operation: 'create' | 'clone';
  description: string;
  source?: string;
}

async function publishEnvironment(
  input: PublishEnvironmentInput,
): Promise<EnvironmentLifecycleResult> {
  const { paths, name, runtime } = input;
  const nameError = validateEnvName(name);
  if (nameError) return invalid('name', nameError);

  try {
    await captureEnvironmentContainerIdentity(paths);
  } catch (error) {
    return { status: 'failure', message: (error as Error).message };
  }

  if (await hasPathIdentity(paths.envDir(name))) {
    return { status: 'exists', name };
  }

  const source = input.operation === 'clone' ? input.source : undefined;
  if (input.operation === 'clone') {
    if (source === undefined) return invalid('source', 'source environment name is required');
    const sourceError = validateEnvName(source);
    if (sourceError) return invalid('source', sourceError);
    try {
      const sourceIdentity = await capturePathIdentity(paths.envDir(source));
      if (sourceIdentity.kind === 'absent') {
        return { status: 'source-not-found', source };
      }
      await validateCloneTree(paths.envDir(source), source);
    } catch (error) {
      if (error instanceof StaleEnvironmentError) {
        return {
          status: 'stale',
          field: error.field,
          name: error.environmentName,
          message: error.message,
        };
      }
      return { status: 'failure', message: (error as Error).message };
    }
  }

  const retained = (await readState(paths)).commands[0];
  if (retained) {
    return {
      status: 'pending-recovery',
      transactionId: retained.transactionId,
    };
  }

  const open = await runtime.open();
  if (open.status === 'pending-recovery') {
    return open;
  }
  if (await hasPathIdentity(paths.envDir(name))) {
    await runtime.close();
    return { status: 'exists', name };
  }
  let environmentContainerIdentity: PathIdentity;
  try {
    environmentContainerIdentity = await captureEnvironmentContainerIdentity(paths);
  } catch (error) {
    await runtime.close();
    return { status: 'failure', message: (error as Error).message };
  }
  const targetIdentity: PathIdentity = { kind: 'absent' };

  const transactionId = `create-${name}-${randomUUID()}`;
  const stagingRoot = join(paths.live, 'commands', transactionId);
  const stagedEnvironment = join(stagingRoot, 'environment');
  let sourceIdentity: PathIdentity | undefined;
  try {
    if (source !== undefined) {
      const sourcePath = paths.envDir(source);
      const sourceBefore = await validateCloneTree(sourcePath, source);
      sourceIdentity = sourceBefore;
      await cp(sourcePath, stagedEnvironment, {
        recursive: true,
        verbatimSymlinks: true,
        preserveTimestamps: true,
      });
      await validateCloneTree(stagedEnvironment, source);
      await input.faults?.afterSourceCopy?.();
      const sourceAfter = await capturePathIdentity(sourcePath);
      if (!identitiesEqual(sourceBefore, sourceAfter)) {
        throw new StaleEnvironmentError(
          'source',
          source,
          `source environment '${source}' changed while being copied`,
        );
      }
    } else {
      await mkdir(stagedEnvironment, { recursive: true });
      await writeFile(
        join(stagedEnvironment, 'env.yaml'),
        scaffoldEnvYaml({ description: input.description }),
        'utf8',
      );
    }

    const stagedYaml = join(stagedEnvironment, 'env.yaml');
    parseEnvConfig(await readFile(stagedYaml, 'utf8'), stagedYaml);

    const entries: StagedCommandEntry[] = [{
      id: 'environment',
      target: paths.envDir(name),
      staged: stagedEnvironment,
      expectedPreIdentity: targetIdentity,
    }];
    if (!(await hasPathIdentity(paths.storeReadme))) {
      const stagedReadme = join(stagingRoot, 'README.md');
      await writeFile(stagedReadme, STORE_README, 'utf8');
      entries.push({
        id: 'store-readme',
        target: paths.storeReadme,
        staged: stagedReadme,
        expectedPreIdentity: { kind: 'absent' },
      });
    }

    await input.faults?.afterStage?.();
    if (
      source !== undefined &&
      sourceIdentity !== undefined &&
      !identitiesEqual(sourceIdentity, await capturePathIdentity(paths.envDir(source)))
    ) {
      throw new StaleEnvironmentError(
        'source',
        source,
        `source environment '${source}' changed while being copied`,
      );
    }
    if (!identitiesEqual(targetIdentity, await capturePathIdentity(paths.envDir(name)))) {
      throw new StaleEnvironmentError(
        'destination',
        name,
        `staged command target changed since planning: ${paths.envDir(name)}`,
      );
    }

    const message = source !== undefined
      ? `agentenv: create env ${name} (from ${source})`
      : `agentenv: create env ${name}`;
    const gitSteps = [{
      id: 'create-environment',
      message,
      paths: entries.map((entry) => entry.target),
    }];
    const publication = await runtime.publish({
      paths,
      transactionId,
      kind: 'environment-create',
      stagingRoot,
      allowedRoots: [paths.store],
      entries,
      preconditions: [
        ...(source !== undefined && sourceIdentity !== undefined
          ? [{
              id: 'source-environment',
              path: paths.envDir(source),
              expectedIdentity: sourceIdentity,
            }]
          : []),
        {
          id: 'environment-container',
          path: paths.environments,
          expectedIdentity: environmentContainerIdentity,
        },
      ],
      gitSteps,
      ...(input.faults?.afterApply ? { afterApply: input.faults.afterApply } : {}),
      ...(input.faults?.afterPersist ? { afterPersist: input.faults.afterPersist } : {}),
    });
    const completed = {
      operation: input.operation,
      name,
      ...(source !== undefined ? { source } : {}),
      transactionId,
    } as const;
    if (publication.status === 'git-pending') {
      return { ...completed, status: 'git-pending', publication: 'git-pending' };
    }
    await runtime.close();
    return { ...completed, status: 'created', publication: 'complete' };
  } catch (error) {
    if (!(await readState(paths)).commands.some(
      (command) => command.transactionId === transactionId,
    )) {
      await rm(stagingRoot, { recursive: true, force: true });
    }
    await runtime.close();
    if (error instanceof StagedCommandExpectedIdentityError && error.entryId === 'environment') {
      return {
        status: 'stale',
        field: 'destination',
        name,
        message: `staged command target changed before apply: ${error.path}`,
      };
    }
    const stalePreconditionId = error instanceof StagedCommandPreconditionError
      ? error.preconditionId
      : error instanceof CommandPathPreconditionError
        ? error.operationId
        : undefined;
    if (stalePreconditionId === 'environment-container') {
      return {
        status: 'stale',
        field: 'destination',
        name,
        message: `environment container changed before publication: ${paths.environments}`,
      };
    }
    if (
      error instanceof StaleEnvironmentError ||
      (stalePreconditionId === 'source-environment' && source !== undefined)
    ) {
      const stale = error instanceof StaleEnvironmentError
        ? error
        : new StaleEnvironmentError(
            'source',
            source!,
            `source environment '${source}' changed while being copied`,
          );
      return {
        status: 'stale',
        field: stale.field,
        name: stale.environmentName,
        message: stale.message,
      };
    }
    return { status: 'failure', message: (error as Error).message };
  }
}
