import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { backup, restore, type BackupRef } from './backups.js';
import {
  createCommandPlan,
  type CommandPlan,
  type PathPreconditionUndo,
  type PlannedGitStep,
  type PlannedOperation,
  type PlannedOperationInput,
} from './command-plan.js';
import { executeCommandPlan, recoverCommandPlan, type CommandEffect } from './command-wal.js';
import { selectSameFilesystemRetainedPath } from './global-cow.js';
import { withLock } from './lock.js';
import {
  captureExpectedPathIdentity,
  capturePathIdentity,
  identitiesEqual,
  type PathIdentity,
} from './path-identity.js';
import { assertNoFollowContainment } from './path-containment.js';
import type { Paths } from './paths.js';
import { readState, writeState, type QuarantineRecord, type StateManifest } from './state.js';

export interface StagedCommandEntry {
  id: string;
  target: string;
  staged: string;
  /** Identity observed during discovery, before prompts or private editing. */
  expectedPreIdentity?: PathIdentity;
}

export interface StagedCommandPrecondition {
  id: string;
  path: string;
  expectedIdentity: PathIdentity;
}

export class StagedCommandPreconditionError extends Error {
  constructor(
    readonly preconditionId: string,
    readonly path: string,
  ) {
    super(`staged command precondition changed before apply: ${path}`);
    this.name = 'StagedCommandPreconditionError';
  }
}

export class StagedCommandExpectedIdentityError extends Error {
  constructor(
    readonly entryId: string,
    readonly path: string,
    readonly phase: 'planning' | 'pre-apply',
  ) {
    super(
      phase === 'planning'
        ? `staged command target changed since planning: ${path}`
        : `staged command target changed before apply: ${path}`,
    );
    this.name = 'StagedCommandExpectedIdentityError';
  }
}

export interface PublishStagedCommandRequest {
  paths: Paths;
  transactionId: string;
  kind: string;
  stagingRoot: string;
  allowedRoots: readonly string[];
  entries: readonly StagedCommandEntry[];
  /** Durable, read-only identities that must still hold when publication begins. */
  preconditions?: readonly StagedCommandPrecondition[];
  /** Complete replacement values for selected non-WAL state domains. */
  statePatch?: Readonly<Record<string, unknown>>;
  gitBookkeeping?: () => Promise<void>;
  gitMessage?: string;
  gitSteps?: readonly PlannedGitStep[];
  /** Optional operation-level critical section. The guard must call `effect`
   * exactly once or throw; used when a logical precondition and path mutation
   * must share the machine lock. */
  effectGuard?: (operationId: string, effect: () => Promise<void>) => Promise<void>;
  afterApply?: (operationId: string) => Promise<void>;
  afterPersist?: (plan: CommandPlan) => Promise<void>;
}

type StatePatch = Record<string, unknown>;

type StagedUndo =
  | {
      schemaVersion: 1;
      type: 'replace-path';
      backup: BackupRef;
      preIdentity: PathIdentity;
    }
  | {
      schemaVersion: 1;
      type: 'state-patch';
      marker: string;
      before: StatePatch;
      after: StatePatch;
    }
  | PathPreconditionUndo;

const RESERVED_STATE_KEYS = new Set(['version', 'journal', 'commands']);

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function copyPath(source: string, destination: string): Promise<void> {
  const stats = await lstat(source).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stats) return;
  await mkdir(dirname(destination), { recursive: true });
  if (stats.isSymbolicLink()) {
    await symlink(await readlink(source), destination);
    return;
  }
  await cp(source, destination, {
    recursive: stats.isDirectory(),
    verbatimSymlinks: true,
    preserveTimestamps: true,
  });
}

async function validateRequest(req: PublishStagedCommandRequest): Promise<void> {
  if (!/^[A-Za-z0-9._-]+$/.test(req.transactionId)) {
    throw new Error('staged command transaction id must be one safe path segment');
  }
  if (!req.kind.trim()) throw new Error('staged command kind is required');
  if (resolve(req.stagingRoot) !== resolve(join(req.paths.live, 'commands', req.transactionId))) {
    throw new Error('staged command root does not match its transaction id');
  }
  const ids = new Set<string>();
  const targets = new Set<string>();
  for (const root of req.allowedRoots) {
    if (!isAbsolute(root)) throw new Error(`staged command allowed root must be absolute: ${root}`);
    const anchor = isContained(resolve(req.paths.base), resolve(root)) ? req.paths.base : root;
    await assertNoFollowContainment(anchor, root, {
      includeCandidate: true,
      label: 'staged command allowed physical root',
    });
  }
  for (const precondition of req.preconditions ?? []) {
    if (!/^[A-Za-z0-9._-]+$/.test(precondition.id) || ids.has(precondition.id)) {
      throw new Error(
        `staged command precondition id is invalid or duplicated: '${precondition.id}'`,
      );
    }
    if (
      !isAbsolute(precondition.path) ||
      !req.allowedRoots.some((root) => isContained(resolve(root), resolve(precondition.path)))
    ) {
      throw new Error(`staged command precondition is outside its allowed roots: ${precondition.path}`);
    }
    const allowedRoot = req.allowedRoots.find((root) =>
      isContained(resolve(root), resolve(precondition.path)),
    )!;
    await assertNoFollowContainment(allowedRoot, precondition.path, {
      label: 'staged command precondition',
    });
    ids.add(precondition.id);
  }
  for (const entry of req.entries) {
    if (!/^[A-Za-z0-9._-]+$/.test(entry.id) || ids.has(entry.id)) {
      throw new Error(`staged command entry id is invalid or duplicated: '${entry.id}'`);
    }
    if (!isAbsolute(entry.target) || !req.allowedRoots.some((root) => isContained(resolve(root), resolve(entry.target)))) {
      throw new Error(`staged command target is outside its allowed roots: ${entry.target}`);
    }
    const allowedRoot = req.allowedRoots.find((root) =>
      isContained(resolve(root), resolve(entry.target)),
    )!;
    await assertNoFollowContainment(allowedRoot, entry.target, {
      label: 'staged command target',
    });
    if (!isContained(resolve(req.stagingRoot), resolve(entry.staged))) {
      throw new Error(`staged command input escapes its staging root: ${entry.staged}`);
    }
    if (targets.has(resolve(entry.target))) throw new Error(`staged command target is duplicated: ${entry.target}`);
    ids.add(entry.id);
    targets.add(resolve(entry.target));
  }
  for (const key of Object.keys(req.statePatch ?? {})) {
    if (RESERVED_STATE_KEYS.has(key)) throw new Error(`staged command cannot patch state domain '${key}'`);
  }
}

function parseUndo(operation: PlannedOperation): StagedUndo {
  if (!operation.undoRef) throw new Error(`staged operation '${operation.id}' lacks undo metadata`);
  const undo = JSON.parse(operation.undoRef) as StagedUndo;
  if (
    !undo ||
    undo.schemaVersion !== 1 ||
    !['replace-path', 'state-patch', 'path-precondition'].includes(undo.type)
  ) {
    throw new Error(`staged operation '${operation.id}' has invalid undo metadata`);
  }
  return undo;
}

async function collectUnreferencedUndoBackups(paths: Paths, plan: CommandPlan): Promise<void> {
  const manifestText = JSON.stringify(await readState(paths));
  const names = new Set<string>();
  for (const operation of plan.operations) {
    const undo = parseUndo(operation);
    if (undo.type !== 'replace-path') continue;
    if (undo.backup.kind === 'content') names.add(undo.backup.hash);
    if (undo.backup.kind === 'directory') names.add(undo.backup.id);
  }
  for (const name of names) {
    if (!manifestText.includes(JSON.stringify(name))) {
      await rm(join(paths.backups, name), { recursive: true, force: true });
    }
  }
}

function stateDomains(manifest: StateManifest, keys: readonly string[]): StatePatch {
  return Object.fromEntries(keys.map((key) => [key, clone(manifest[key])]));
}

function statePatchIdentity(patch: StatePatch): PathIdentity {
  return {
    kind: 'file',
    digest: `state-domain:${createHash('sha256').update(JSON.stringify(patch)).digest('hex')}`,
    mode: 0,
  };
}

async function patchState(paths: Paths, patch: StatePatch): Promise<void> {
  await withLock(paths, async () => {
    const manifest = await readState(paths);
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete manifest[key];
      else manifest[key] = clone(value);
    }
    await writeState(paths, manifest);
  });
}

async function retainThirdIdentity(
  paths: Paths,
  plan: CommandPlan,
  operation: PlannedOperation,
  observed: PathIdentity,
): Promise<QuarantineRecord> {
  if (!operation.path) throw new Error(`staged operation '${operation.id}' lacks a target path`);
  const id = `command-${plan.transactionId}-${operation.id}`;
  const preferred = join(paths.live, 'quarantine', id, 'content');
  const retainedPath = observed.kind === 'absent'
    ? preferred
    : await selectSameFilesystemRetainedPath(
        preferred,
        operation.path,
        `.agentenv-quarantine-${id}`,
      );
  if ((await capturePathIdentity(retainedPath)).kind === 'absent') {
    await mkdir(dirname(retainedPath), { recursive: true });
    if (observed.kind === 'absent') await writeFile(retainedPath, 'ABSENT third identity\n', 'utf8');
    else await rename(operation.path, retainedPath);
  }
  return {
    schemaVersion: 2,
    id,
    kind: 'whole-command-third-identity',
    path: operation.path,
    retainedPath,
    reason: `staged operation '${operation.id}' observed an unplanned identity during rollback`,
    createdAt: Date.now(),
    resolved: false,
  };
}

function recoveryEffect(paths: Paths, plan: CommandPlan, operation: PlannedOperation): CommandEffect {
  if (!operation.path) throw new Error(`staged operation '${operation.id}' lacks a target path`);
  const undo = parseUndo(operation);
  if (undo.type === 'path-precondition') {
    return {
      observeIdentity: () => capturePathIdentity(operation.path!),
      apply: async () => {
        throw new Error('staged recovery preconditions cannot run forward');
      },
      undo: async () => {},
    };
  }
  let pendingStateRescue: QuarantineRecord | undefined;
  return {
    observeIdentity: async () => {
      const observed = await capturePathIdentity(operation.path!);
      if (undo.type !== 'state-patch' || observed.kind === 'absent') return observed;
      if (!operation.postIdentity || !identitiesEqual(observed, operation.postIdentity)) return observed;
      const keys = Object.keys(undo.after);
      const current = stateDomains(await readState(paths), keys);
      if (isDeepStrictEqual(current, undo.before) || isDeepStrictEqual(current, undo.after)) {
        return observed;
      }
      return statePatchIdentity(current);
    },
    apply: async () => {
      throw new Error('staged recovery effects cannot run forward');
    },
    rescue: async (observed) => {
      if (
        undo.type === 'state-patch' &&
        observed.kind === 'file' &&
        observed.digest.startsWith('state-domain:')
      ) {
        const id = `command-${plan.transactionId}-${operation.id}-state`;
        const retainedPath = join(paths.live, 'quarantine', id, 'state.json');
        const current = stateDomains(await readState(paths), Object.keys(undo.after));
        if ((await capturePathIdentity(retainedPath)).kind === 'absent') {
          await mkdir(dirname(retainedPath), { recursive: true });
          await writeFile(retainedPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
        }
        pendingStateRescue = {
          schemaVersion: 2,
          id,
          kind: 'whole-command-third-identity',
          path: paths.state,
          retainedPath,
          reason: `staged state operation '${operation.id}' observed an unplanned domain identity during rollback`,
          createdAt: Date.now(),
          resolved: false,
        };
        return pendingStateRescue;
      }
      return retainThirdIdentity(paths, plan, operation, observed);
    },
    undo: async () => {
      if (undo.type === 'replace-path') {
        await restore(paths, undo.backup, operation.path!);
        return;
      }
      const keys = Object.keys(undo.after);
      const current = stateDomains(await readState(paths), keys);
      if (!isDeepStrictEqual(current, undo.before)) {
        if (!isDeepStrictEqual(current, undo.after) && !pendingStateRescue) {
          throw new Error(`staged state operation '${operation.id}' changed without a retained rescue`);
        }
        await patchState(paths, undo.before);
      }
      if (pendingStateRescue && keys.includes('quarantine')) {
        await withLock(paths, async () => {
          const manifest = await readState(paths);
          if (!manifest.quarantine.some((record) => record.id === pendingStateRescue!.id)) {
            manifest.quarantine.push(pendingStateRescue!);
            await writeState(paths, manifest);
          }
        });
      }
      await rm(undo.marker, { recursive: true, force: true });
    },
  };
}

function recoveryEffects(paths: Paths, plan: CommandPlan): Map<string, CommandEffect> {
  return new Map(
    plan.operations.map((operation) => [operation.id, recoveryEffect(paths, plan, operation)]),
  );
}

function isStagedCommand(plan: CommandPlan): boolean {
  return (plan as CommandPlan & { executor?: unknown }).executor === 'staged-command';
}

/** Resume staged-command rollback or post-commit Git work in a fresh process. */
export async function recoverPendingStagedCommands(
  paths: Paths,
  gitBookkeeping?: () => Promise<void>,
  transactionId?: string,
): Promise<void> {
  const pending = (await readState(paths)).commands.filter(
    (plan) =>
      isStagedCommand(plan) &&
      (transactionId === undefined || plan.transactionId === transactionId),
  );
  if (transactionId !== undefined && pending.length === 0) {
    throw new Error(`no pending staged command '${transactionId}'`);
  }
  if (transactionId === undefined && gitBookkeeping && pending.length > 1) {
    throw new Error('transaction id is required to recover more than one staged command');
  }
  for (const plan of pending) {
    await recoverCommandPlan({
      paths,
      transactionId: plan.transactionId,
      effects: recoveryEffects(paths, plan),
      ...(gitBookkeeping ? { gitBookkeeping } : {}),
    });
    if (!(await readState(paths)).commands.some((candidate) => candidate.transactionId === plan.transactionId)) {
      await collectUnreferencedUndoBackups(paths, plan);
      await rm(join(paths.live, 'commands', plan.transactionId), { recursive: true, force: true });
    }
  }
}

export async function publishStagedCommand(req: PublishStagedCommandRequest): Promise<void> {
  await validateRequest(req);
  const pending = (await readState(req.paths)).commands[0];
  if (pending) {
    throw new Error(
      `unfinished command '${pending.transactionId}' must be resolved before '${req.transactionId}'`,
    );
  }

  const planned: Array<{
    entry: StagedCommandEntry;
    pre: PathIdentity;
    post: PathIdentity;
    undo: BackupRef;
  }> = [];
  for (const entry of req.entries) {
    const beforeBackup = await capturePathIdentity(entry.target);
    if (entry.expectedPreIdentity && !identitiesEqual(beforeBackup, entry.expectedPreIdentity)) {
      throw new StagedCommandExpectedIdentityError(entry.id, entry.target, 'planning');
    }
    const undo = await backup(req.paths, entry.target);
    const pre = await capturePathIdentity(entry.target);
    if (!identitiesEqual(beforeBackup, pre)) {
      throw new StagedCommandExpectedIdentityError(entry.id, entry.target, 'planning');
    }
    planned.push({ entry, pre, post: await capturePathIdentity(entry.staged), undo });
  }

  const stateKeys = Object.keys(req.statePatch ?? {});
  const currentManifest = await readState(req.paths);
  const beforeState = stateDomains(currentManifest, stateKeys);
  const afterState = clone(req.statePatch ?? {});
  const markerSeed = join(req.stagingRoot, '.state-seed');
  const marker = join(req.stagingRoot, '.state-applied');
  if (stateKeys.length > 0) await writeFile(markerSeed, 'state applied\n', 'utf8');

  const operations: PlannedOperationInput[] = (req.preconditions ?? []).map((precondition) => ({
    id: precondition.id,
    kind: 'read-path-precondition',
    path: precondition.path,
    preIdentity: precondition.expectedIdentity,
    postIdentity: precondition.expectedIdentity,
    undoRef: JSON.stringify({
      schemaVersion: 1,
      type: 'path-precondition',
      expectedIdentity: precondition.expectedIdentity,
    } satisfies StagedUndo),
  }));
  operations.push(...planned.map(({ entry, pre, post, undo }) => ({
    id: entry.id,
    kind: 'replace-path',
    path: entry.target,
    preIdentity: pre,
    postIdentity: post,
    undoRef: JSON.stringify({
      schemaVersion: 1,
      type: 'replace-path',
      backup: undo,
      preIdentity: pre,
    } satisfies StagedUndo),
  })));
  if (stateKeys.length > 0) {
    operations.push({
      id: 'state',
      kind: 'state-patch',
      path: marker,
      preIdentity: { kind: 'absent' },
      postIdentity: await capturePathIdentity(markerSeed),
      undoRef: JSON.stringify({
        schemaVersion: 1,
        type: 'state-patch',
        marker,
        before: beforeState,
        after: afterState,
      } satisfies StagedUndo),
    });
  }
  if (operations.length === 0 && !req.gitBookkeeping) {
    throw new Error('staged command requires at least one local or Git effect');
  }

  const plan = {
    ...createCommandPlan({
      transactionId: req.transactionId,
      kind: req.kind,
      gitRequired: req.gitBookkeeping !== undefined,
      ...(req.gitMessage ? { gitMessage: req.gitMessage } : {}),
      ...(req.gitSteps ? { gitSteps: req.gitSteps } : {}),
      operations,
    }),
    executor: 'staged-command',
  } as CommandPlan;
  const effects = recoveryEffects(req.paths, plan);
  const plannedPreconditions = plan.operations.filter(
    (operation) => operation.kind === 'read-path-precondition',
  );
  const checkPrecondition = async (operation: PlannedOperation): Promise<void> => {
    if (
      !operation.path ||
      !operation.preIdentity ||
      !identitiesEqual(
        await captureExpectedPathIdentity(operation.path, operation.preIdentity),
        operation.preIdentity,
      )
    ) {
      throw new StagedCommandPreconditionError(operation.id, operation.path ?? '');
    }
  };
  const checkPreconditions = async (): Promise<void> => {
    for (const operation of plannedPreconditions) await checkPrecondition(operation);
  };
  const checkTargets = async (): Promise<void> => {
    for (const item of planned) {
      if (!identitiesEqual(await capturePathIdentity(item.entry.target), item.pre)) {
        throw new StagedCommandExpectedIdentityError(
          item.entry.id,
          item.entry.target,
          'pre-apply',
        );
      }
    }
  };

  let firstMutation = true;
  const beforeMutation = async (): Promise<void> => {
    if (!firstMutation) return;
    await checkPreconditions();
    firstMutation = false;
  };
  for (const item of planned) {
    const operation = plan.operations.find((candidate) => candidate.id === item.entry.id)!;
    const base = effects.get(operation.id)!;
    effects.set(operation.id, {
      ...base,
      apply: async () => {
        await beforeMutation();
        const apply = async (): Promise<void> => {
          if (!identitiesEqual(await capturePathIdentity(item.entry.target), item.pre)) {
            throw new StagedCommandExpectedIdentityError(
              item.entry.id,
              item.entry.target,
              'pre-apply',
            );
          }
          await rm(item.entry.target, { recursive: true, force: true });
          if (item.post.kind !== 'absent') await copyPath(item.entry.staged, item.entry.target);
          await req.afterApply?.(operation.id);
        };
        if (req.effectGuard) await req.effectGuard(operation.id, apply);
        else await apply();
      },
    });
  }
  if (stateKeys.length > 0) {
    const operation = plan.operations.at(-1)!;
    const base = effects.get(operation.id)!;
    effects.set(operation.id, {
      ...base,
      apply: async () => {
        await beforeMutation();
        await withLock(req.paths, async () => {
          const manifest = await readState(req.paths);
          if (!isDeepStrictEqual(stateDomains(manifest, stateKeys), beforeState)) {
            throw new Error('staged command state changed before apply');
          }
          if ((await capturePathIdentity(marker)).kind !== 'absent') {
            throw new Error(`staged command state marker already exists: ${marker}`);
          }
          await rename(markerSeed, marker);
          for (const [key, value] of Object.entries(afterState)) {
            if (value === undefined) delete manifest[key];
            else manifest[key] = clone(value);
          }
          await writeState(req.paths, manifest);
        });
        await req.afterApply?.('state');
      },
    });
  }

  try {
    await executeCommandPlan({
      paths: req.paths,
      plan,
      effects,
      ...(req.gitBookkeeping ? { gitBookkeeping: req.gitBookkeeping } : {}),
      ...(plannedPreconditions.length > 0 || planned.length > 0
        ? {
            beforeEffects: async () => {
              await checkPreconditions();
              await checkTargets();
            },
          }
        : {}),
      ...(req.afterPersist ? { afterPersist: req.afterPersist } : {}),
    });
  } finally {
    const retained = (await readState(req.paths)).commands.some(
      (candidate) => candidate.transactionId === req.transactionId,
    );
    if (!retained) {
      await collectUnreferencedUndoBackups(req.paths, plan);
      await rm(req.stagingRoot, { recursive: true, force: true });
    }
  }
}
