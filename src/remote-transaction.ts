import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createCommandPlan, type CommandPlan, type PlannedOperation } from './command-plan.js';
import { executeCommandPlan, recoverCommandPlan, type CommandEffect } from './command-wal.js';
import {
  deletePreparedRemoteRef,
  getRemoteUrl,
  pushRevisionUrl,
  removeRemote,
  resetHardTo,
  setRemoteUrl,
  type GitRunner,
} from './git.js';
import { capturePathIdentity } from './path-identity.js';
import type { Paths } from './paths.js';
import { readState } from './state.js';

type RemoteUndo =
  | {
      schemaVersion: 1;
      type: 'push';
      marker: string;
      preparedRef?: string;
    }
  | {
      schemaVersion: 1;
      type: 'url';
      marker: string;
      oldUrl: string | null;
    }
  | {
      schemaVersion: 1;
      type: 'head';
      marker: string;
      oldHead: string;
    };

export interface RemoteReplacementRequest {
  paths: Paths;
  env: NodeJS.ProcessEnv;
  newUrl: string;
  oldUrl: string | null;
  oldHead: string;
  newHead: string;
  /** Related/empty replacement publishes this revision before local cutover. */
  pushRevision?: string;
  preparedRef?: string;
  gitRun?: GitRunner;
  /** Fault-injection/diagnostic seam. */
  afterPersist?: (plan: CommandPlan) => Promise<void>;
}

function parseUndo(operation: PlannedOperation): RemoteUndo {
  if (!operation.undoRef) throw new Error(`remote operation '${operation.id}' lacks undo metadata`);
  const value = JSON.parse(operation.undoRef) as RemoteUndo;
  if (!value || value.schemaVersion !== 1 || !['push', 'url', 'head'].includes(value.type)) {
    throw new Error(`remote operation '${operation.id}' has invalid undo metadata`);
  }
  return value;
}

async function restoreUrl(
  paths: Paths,
  env: NodeJS.ProcessEnv,
  oldUrl: string | null,
  run?: GitRunner,
): Promise<void> {
  if (oldUrl) await setRemoteUrl(paths, env, oldUrl, run);
  else await removeRemote(paths, env, run);
}

function recoveryEffect(
  paths: Paths,
  env: NodeJS.ProcessEnv,
  operation: PlannedOperation,
  run?: GitRunner,
): CommandEffect {
  const undo = parseUndo(operation);
  return {
    observeIdentity: () => capturePathIdentity(undo.marker),
    apply: async () => {
      throw new Error('remote recovery effects cannot run forward');
    },
    undo: async () => {
      if (undo.type === 'url') await restoreUrl(paths, env, undo.oldUrl, run);
      if (undo.type === 'head') {
        const reset = await resetHardTo(paths, env, undo.oldHead, run);
        if (reset.code !== 0) throw new Error('could not restore local HEAD during remote rollback');
      }
      if (undo.type === 'push' && undo.preparedRef) {
        await deletePreparedRemoteRef(paths, env, undo.preparedRef, run);
      }
      await rm(undo.marker, { recursive: true, force: true });
    },
  };
}

function recoveryEffects(
  paths: Paths,
  env: NodeJS.ProcessEnv,
  plan: CommandPlan,
  run?: GitRunner,
): Map<string, CommandEffect> {
  return new Map(
    plan.operations.map((operation) => [operation.id, recoveryEffect(paths, env, operation, run)]),
  );
}

/** Roll back a killed pre-commit remote cutover before any ordinary invocation can push. */
export async function recoverPendingRemoteReplacements(
  paths: Paths,
  env: NodeJS.ProcessEnv,
  run?: GitRunner,
): Promise<void> {
  const pending = (await readState(paths)).commands.filter((plan) => plan.kind === 'remote-replacement');
  for (const plan of pending) {
    await recoverCommandPlan({
      paths,
      transactionId: plan.transactionId,
      effects: recoveryEffects(paths, env, plan, run),
    });
    await rm(join(paths.live, 'commands', plan.transactionId), { recursive: true, force: true });
  }
}

/** Publish candidate push, origin config, and canonical HEAD through one durable plan. */
export async function executeRemoteReplacement(req: RemoteReplacementRequest): Promise<void> {
  await recoverPendingRemoteReplacements(req.paths, req.env, req.gitRun);
  const unrelated = (await readState(req.paths)).commands[0];
  if (unrelated) throw new Error(`unfinished command '${unrelated.transactionId}' must be resolved first`);

  const transactionId = `remote-${randomUUID()}`;
  const root = join(req.paths.live, 'commands', transactionId);
  const seeds = join(root, 'seeds');
  const markers = join(root, 'markers');
  await mkdir(seeds, { recursive: true });

  const operations: PlannedOperation[] = [];
  const effects = new Map<string, CommandEffect>();
  const addOperation = async (
    id: string,
    undo: RemoteUndo,
    effect: () => Promise<void>,
  ): Promise<void> => {
    const seed = join(seeds, id);
    await writeFile(seed, `${id}\n`, 'utf8');
    const postIdentity = await capturePathIdentity(seed);
    const operation: PlannedOperation = {
      id,
      kind: `remote-${id}`,
      path: undo.marker,
      preIdentity: { kind: 'absent' },
      postIdentity,
      undoRef: JSON.stringify(undo),
      state: 'pending',
    };
    operations.push(operation);
    const base = recoveryEffect(req.paths, req.env, operation, req.gitRun);
    effects.set(id, {
      ...base,
      apply: async () => {
        await mkdir(dirname(undo.marker), { recursive: true });
        await rename(seed, undo.marker);
        await effect();
      },
    });
  };

  if (req.pushRevision) {
    const marker = join(markers, 'push');
    await addOperation(
      'push',
      {
        schemaVersion: 1,
        type: 'push',
        marker,
        ...(req.preparedRef ? { preparedRef: req.preparedRef } : {}),
      },
      async () => {
        const pushed = await pushRevisionUrl(
          req.paths,
          req.env,
          req.newUrl,
          req.pushRevision!,
          req.gitRun ? { run: req.gitRun } : {},
        );
        if (pushed.status !== 'ok' && pushed.status !== 'nothing') {
          throw new Error(`candidate push failed (${pushed.detail ?? pushed.status})`);
        }
      },
    );
  }

  const urlMarker = join(markers, 'url');
  await addOperation(
    'url',
    { schemaVersion: 1, type: 'url', marker: urlMarker, oldUrl: req.oldUrl },
    () => setRemoteUrl(req.paths, req.env, req.newUrl, req.gitRun),
  );
  const headMarker = join(markers, 'head');
  await addOperation(
    'head',
    { schemaVersion: 1, type: 'head', marker: headMarker, oldHead: req.oldHead },
    async () => {
      const reset = await resetHardTo(req.paths, req.env, req.newHead, req.gitRun);
      if (reset.code !== 0) throw new Error('could not publish prepared remote history locally');
    },
  );

  const plan = createCommandPlan({
    transactionId,
    kind: 'remote-replacement',
    operations,
  });
  try {
    await executeCommandPlan({
      paths: req.paths,
      plan,
      effects,
      ...(req.afterPersist ? { afterPersist: req.afterPersist } : {}),
    });
  } finally {
    if (!(await readState(req.paths)).commands.some((candidate) => candidate.transactionId === transactionId)) {
      await rm(root, { recursive: true, force: true });
    }
  }

  if (req.preparedRef) await deletePreparedRemoteRef(req.paths, req.env, req.preparedRef, req.gitRun);
  const configured = await getRemoteUrl(req.paths, req.env, req.gitRun);
  if (configured !== req.newUrl) throw new Error('remote replacement completed without the requested origin');
}
