import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { BackupRef } from './backups.js';
import { backup, restore } from './backups.js';
import { createCommandPlan, type CommandPlan, type PlannedOperation } from './command-plan.js';
import {
  executeCommandPlan,
  recoverCommandPlan,
  type CommandEffect,
} from './command-wal.js';
import {
  capturePathIdentity,
  identitiesEqual,
  type PathIdentity,
} from './path-identity.js';
import type { Paths } from './paths.js';
import { readState, type QuarantineRecord } from './state.js';

export interface StagedBundleEntry {
  id: string;
  target: string;
  staged: string;
}

export interface PublishStagedBundleRequest {
  paths: Paths;
  transactionId: string;
  stagingRoot: string;
  entries: readonly StagedBundleEntry[];
  /** Fault-injection/observation seam; production callers leave it unset. */
  afterApply?: (entry: StagedBundleEntry) => Promise<void>;
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep);
}

function validateRequest(req: PublishStagedBundleRequest): void {
  if (!/^[A-Za-z0-9._-]+$/.test(req.transactionId)) {
    throw new Error('filesystem bundle transaction id must be one safe path segment');
  }
  if (resolve(req.stagingRoot) !== resolve(join(req.paths.live, 'commands', req.transactionId))) {
    throw new Error('filesystem bundle staging root does not match its transaction id');
  }
  if (req.entries.length === 0) throw new Error('filesystem bundle requires at least one entry');
  const ids = new Set<string>();
  const targets = new Set<string>();
  for (const entry of req.entries) {
    if (!/^[A-Za-z0-9._-]+$/.test(entry.id) || ids.has(entry.id)) {
      throw new Error(`filesystem bundle entry id is invalid or duplicated: '${entry.id}'`);
    }
    if (!isContained(resolve(req.paths.store), resolve(entry.target))) {
      throw new Error(`filesystem bundle target escapes the canonical store: ${entry.target}`);
    }
    if (!isContained(resolve(req.stagingRoot), resolve(entry.staged))) {
      throw new Error(`filesystem bundle staged path escapes its staging root: ${entry.staged}`);
    }
    if (targets.has(resolve(entry.target))) {
      throw new Error(`filesystem bundle target is duplicated: ${entry.target}`);
    }
    ids.add(entry.id);
    targets.add(resolve(entry.target));
  }
}

function parseUndoRef(operation: PlannedOperation): BackupRef {
  if (!operation.undoRef) throw new Error(`operation '${operation.id}' lacks an undo ref`);
  const parsed = JSON.parse(operation.undoRef) as BackupRef;
  if (!parsed || typeof parsed !== 'object' || !('kind' in parsed)) {
    throw new Error(`operation '${operation.id}' has an invalid undo ref`);
  }
  return parsed;
}

async function retainThirdIdentity(
  paths: Paths,
  plan: CommandPlan,
  operation: PlannedOperation,
  observed: PathIdentity,
): Promise<QuarantineRecord> {
  if (!operation.path) throw new Error(`operation '${operation.id}' lacks a target path`);
  const id = `command-${plan.transactionId}-${operation.id}`;
  const retainedPath = join(paths.live, 'quarantine', id, 'content');
  const retained = await capturePathIdentity(retainedPath);
  if (retained.kind === 'absent') {
    await mkdir(dirname(retainedPath), { recursive: true });
    if (observed.kind === 'absent') {
      await writeFile(retainedPath, 'ABSENT third identity\n', 'utf8');
    } else {
      await rename(operation.path, retainedPath);
    }
  }
  return {
    schemaVersion: 2,
    id,
    kind: 'whole-command-third-identity',
    path: operation.path,
    retainedPath,
    reason: `operation '${operation.id}' observed a third path identity during rollback`,
    createdAt: Date.now(),
    resolved: false,
  };
}

function recoveryEffect(paths: Paths, plan: CommandPlan, operation: PlannedOperation): CommandEffect {
  if (!operation.path) throw new Error(`operation '${operation.id}' lacks a target path`);
  const undoRef = parseUndoRef(operation);
  return {
    observeIdentity: () => capturePathIdentity(operation.path!),
    apply: async () => {
      throw new Error('recovery effects cannot be applied forward');
    },
    undo: () => restore(paths, undoRef, operation.path!),
    rescue: (observed) => retainThirdIdentity(paths, plan, operation, observed),
  };
}

function recoveryEffects(paths: Paths, plan: CommandPlan): Map<string, CommandEffect> {
  return new Map(
    plan.operations.map((operation) => [operation.id, recoveryEffect(paths, plan, operation)]),
  );
}

/** Resume any pre-commit rollback (or clear a committed record) from an earlier process. */
export async function recoverPendingFilesystemBundles(paths: Paths): Promise<void> {
  const pending = (await readState(paths)).commands.filter(
    (plan) => plan.kind === 'filesystem-bundle',
  );
  for (const plan of pending) {
    await recoverCommandPlan({
      paths,
      transactionId: plan.transactionId,
      effects: recoveryEffects(paths, plan),
    });
    await rm(join(paths.live, 'commands', plan.transactionId), { recursive: true, force: true });
  }
}

/** Publish a complete staged bundle under one durable, identity-checked command plan. */
export async function publishStagedBundle(req: PublishStagedBundleRequest): Promise<void> {
  validateRequest(req);
  await recoverPendingFilesystemBundles(req.paths);

  const planned: Array<{
    entry: StagedBundleEntry;
    pre: PathIdentity;
    post: PathIdentity;
    undo: BackupRef;
  }> = [];
  for (const entry of req.entries) {
    const preBeforeBackup = await capturePathIdentity(entry.target);
    const undo = await backup(req.paths, entry.target);
    const pre = await capturePathIdentity(entry.target);
    if (!identitiesEqual(preBeforeBackup, pre)) {
      throw new Error(`filesystem bundle target changed while planning: ${entry.target}`);
    }
    planned.push({ entry, pre, post: await capturePathIdentity(entry.staged), undo });
  }

  const plan = createCommandPlan({
    transactionId: req.transactionId,
    kind: 'filesystem-bundle',
    operations: planned.map(({ entry, pre, post, undo }) => ({
      id: entry.id,
      kind: 'replace-path',
      path: entry.target,
      preIdentity: pre,
      postIdentity: post,
      undoRef: JSON.stringify(undo),
    })),
  });

  const effects = new Map<string, CommandEffect>();
  for (const [index, item] of planned.entries()) {
    const operation = plan.operations[index]!;
    const base = recoveryEffect(req.paths, plan, operation);
    effects.set(operation.id, {
      ...base,
      apply: async () => {
        const current = await capturePathIdentity(item.entry.target);
        if (!identitiesEqual(current, item.pre)) {
          throw new Error(`filesystem bundle target changed before apply: ${item.entry.target}`);
        }
        await mkdir(dirname(item.entry.target), { recursive: true });
        await rm(item.entry.target, { recursive: true, force: true });
        await rename(item.entry.staged, item.entry.target);
        await req.afterApply?.(item.entry);
      },
    });
  }

  try {
    await executeCommandPlan({ paths: req.paths, plan, effects });
  } finally {
    await rm(req.stagingRoot, { recursive: true, force: true });
  }
}
