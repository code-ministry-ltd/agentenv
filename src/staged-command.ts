import { cp, lstat, mkdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { backup, restore, type BackupRef } from './backups.js';
import {
  createCommandPlan,
  type CommandPlan,
  type PlannedGitStep,
  type PlannedOperation,
} from './command-plan.js';
import { executeCommandPlan, recoverCommandPlan, type CommandEffect } from './command-wal.js';
import { selectSameFilesystemRetainedPath } from './global-cow.js';
import { withLock } from './lock.js';
import { capturePathIdentity, identitiesEqual, type PathIdentity } from './path-identity.js';
import type { Paths } from './paths.js';
import { readState, writeState, type QuarantineRecord, type StateManifest } from './state.js';

export interface StagedCommandEntry {
  id: string;
  target: string;
  staged: string;
  /** Identity observed during discovery, before prompts or private editing. */
  expectedPreIdentity?: PathIdentity;
}

export interface PublishStagedCommandRequest {
  paths: Paths;
  transactionId: string;
  kind: string;
  stagingRoot: string;
  allowedRoots: readonly string[];
  entries: readonly StagedCommandEntry[];
  /** Complete replacement values for selected non-WAL state domains. */
  statePatch?: Readonly<Record<string, unknown>>;
  gitBookkeeping?: () => Promise<void>;
  gitMessage?: string;
  gitSteps?: readonly PlannedGitStep[];
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
    };

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

function validateRequest(req: PublishStagedCommandRequest): void {
  if (!/^[A-Za-z0-9._-]+$/.test(req.transactionId)) {
    throw new Error('staged command transaction id must be one safe path segment');
  }
  if (!req.kind.trim()) throw new Error('staged command kind is required');
  if (resolve(req.stagingRoot) !== resolve(join(req.paths.live, 'commands', req.transactionId))) {
    throw new Error('staged command root does not match its transaction id');
  }
  const ids = new Set<string>();
  const targets = new Set<string>();
  for (const entry of req.entries) {
    if (!/^[A-Za-z0-9._-]+$/.test(entry.id) || ids.has(entry.id)) {
      throw new Error(`staged command entry id is invalid or duplicated: '${entry.id}'`);
    }
    if (!isAbsolute(entry.target) || !req.allowedRoots.some((root) => isContained(resolve(root), resolve(entry.target)))) {
      throw new Error(`staged command target is outside its allowed roots: ${entry.target}`);
    }
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
  if (!undo || undo.schemaVersion !== 1 || !['replace-path', 'state-patch'].includes(undo.type)) {
    throw new Error(`staged operation '${operation.id}' has invalid undo metadata`);
  }
  return undo;
}

function stateDomains(manifest: StateManifest, keys: readonly string[]): StatePatch {
  return Object.fromEntries(keys.map((key) => [key, clone(manifest[key])]));
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
  return {
    observeIdentity: () => capturePathIdentity(operation.path!),
    apply: async () => {
      throw new Error('staged recovery effects cannot run forward');
    },
    rescue: (observed) => retainThirdIdentity(paths, plan, operation, observed),
    undo: async () => {
      if (undo.type === 'replace-path') {
        await restore(paths, undo.backup, operation.path!);
        return;
      }
      await patchState(paths, undo.before);
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
      await rm(join(paths.live, 'commands', plan.transactionId), { recursive: true, force: true });
    }
  }
}

export async function publishStagedCommand(req: PublishStagedCommandRequest): Promise<void> {
  validateRequest(req);
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
      throw new Error(`staged command target changed since planning: ${entry.target}`);
    }
    const undo = await backup(req.paths, entry.target);
    const pre = await capturePathIdentity(entry.target);
    if (!identitiesEqual(beforeBackup, pre)) {
      throw new Error(`staged command target changed while planning: ${entry.target}`);
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

  const operations = planned.map(({ entry, pre, post, undo }) => ({
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
  }));
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
  for (const [index, item] of planned.entries()) {
    const operation = plan.operations[index]!;
    const base = effects.get(operation.id)!;
    effects.set(operation.id, {
      ...base,
      apply: async () => {
        if (!identitiesEqual(await capturePathIdentity(item.entry.target), item.pre)) {
          throw new Error(`staged command target changed before apply: ${item.entry.target}`);
        }
        await rm(item.entry.target, { recursive: true, force: true });
        if (item.post.kind !== 'absent') await copyPath(item.entry.staged, item.entry.target);
        await req.afterApply?.(operation.id);
      },
    });
  }
  if (stateKeys.length > 0) {
    const operation = plan.operations.at(-1)!;
    const base = effects.get(operation.id)!;
    effects.set(operation.id, {
      ...base,
      apply: async () => {
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
      ...(req.afterPersist ? { afterPersist: req.afterPersist } : {}),
    });
  } finally {
    const retained = (await readState(req.paths)).commands.some(
      (candidate) => candidate.transactionId === req.transactionId,
    );
    if (!retained) await rm(req.stagingRoot, { recursive: true, force: true });
  }
}
