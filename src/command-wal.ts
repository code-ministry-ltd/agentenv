import {
  advanceCommand,
  advanceOperation,
  type CommandPlan,
  type PlannedOperation,
} from './command-plan.js';
import { withLock } from './lock.js';
import {
  decidePreCommitRecovery,
  type PathIdentity,
  type PreCommitRecoveryDecision,
} from './path-identity.js';
import type { Paths } from './paths.js';
import { readState, writeState, type QuarantineRecord, type StateManifest } from './state.js';

export interface CommandEffect {
  observeIdentity(): Promise<PathIdentity>;
  apply(): Promise<void>;
  undo(): Promise<void>;
  /** Move an observed third identity to retained storage before undo restores pre-state. */
  rescue?(observed: PathIdentity): Promise<QuarantineRecord>;
}

export interface CommandWalRequest {
  paths: Paths;
  plan: CommandPlan;
  effects: ReadonlyMap<string, CommandEffect>;
  /** Required local Git commit/bookkeeping; queued fail-soft push belongs after this callback. */
  gitBookkeeping?: () => Promise<void>;
}

export interface RecoverCommandWalRequest {
  paths: Paths;
  transactionId: string;
  effects: ReadonlyMap<string, CommandEffect>;
  gitBookkeeping?: () => Promise<void>;
}

function replacePlan(manifest: StateManifest, plan: CommandPlan): void {
  const index = manifest.commands.findIndex((candidate) => candidate.transactionId === plan.transactionId);
  if (index < 0) manifest.commands.push(plan);
  else manifest.commands[index] = plan;
}

async function persistPlan(
  paths: Paths,
  manifest: StateManifest,
  plan: CommandPlan,
): Promise<void> {
  replacePlan(manifest, plan);
  await writeState(paths, manifest);
}

async function clearPlan(
  paths: Paths,
  manifest: StateManifest,
  transactionId: string,
): Promise<void> {
  manifest.commands = manifest.commands.filter((plan) => plan.transactionId !== transactionId);
  await writeState(paths, manifest);
}

function requireEffect(
  effects: ReadonlyMap<string, CommandEffect>,
  operation: PlannedOperation,
): CommandEffect {
  const effect = effects.get(operation.id);
  if (!effect) throw new Error(`missing command effect '${operation.id}'`);
  return effect;
}

async function recoveryDecision(
  operation: PlannedOperation,
  effect: CommandEffect,
): Promise<PreCommitRecoveryDecision> {
  if (!operation.preIdentity || !operation.postIdentity) {
    return { action: 'undo-post-state' };
  }
  return decidePreCommitRecovery({
    pre: operation.preIdentity,
    post: operation.postIdentity,
    observed: await effect.observeIdentity(),
  });
}

async function rollBackPlan(
  paths: Paths,
  manifest: StateManifest,
  initial: CommandPlan,
  effects: ReadonlyMap<string, CommandEffect>,
): Promise<CommandPlan> {
  let plan = initial;
  if (plan.phase === 'planned') {
    plan = advanceCommand(plan, 'applying');
    await persistPlan(paths, manifest, plan);
  }
  if (plan.phase === 'applying') {
    plan = advanceCommand(plan, 'rolling-back');
    await persistPlan(paths, manifest, plan);
  }
  if (plan.phase !== 'rolling-back') {
    throw new Error(`cannot roll back command '${plan.transactionId}' while ${plan.phase}`);
  }

  for (let index = plan.operations.length - 1; index >= 0; index--) {
    const operation = plan.operations[index]!;
    if (operation.state === 'pending' || operation.state === 'undone') continue;
    const effect = requireEffect(effects, operation);
    if (operation.state !== 'undoing') {
      plan = advanceOperation(plan, operation.id, 'undoing');
      await persistPlan(paths, manifest, plan);
    }

    const current = plan.operations[index]!;
    const decision = await recoveryDecision(current, effect);
    if (decision.action === 'rescue-third-identity') {
      if (!effect.rescue) {
        throw new Error(`effect '${operation.id}' cannot rescue a third identity`);
      }
      manifest.quarantine.push(await effect.rescue(decision.observed));
      await writeState(paths, manifest);
    }
    if (decision.action !== 'skip-pre-state') await effect.undo();

    plan = advanceOperation(plan, operation.id, 'undone');
    await persistPlan(paths, manifest, plan);
  }

  plan = advanceCommand(plan, 'rolled-back');
  await persistPlan(paths, manifest, plan);
  await clearPlan(paths, manifest, plan.transactionId);
  return plan;
}

async function finishGitPending(
  paths: Paths,
  transactionId: string,
  gitBookkeeping: (() => Promise<void>) | undefined,
): Promise<void> {
  const exists = await withLock(paths, async () => {
    const manifest = await readState(paths);
    const stored = manifest.commands.find((plan) => plan.transactionId === transactionId);
    if (!stored) return false;
    if (stored.gitRequired === true && !gitBookkeeping) {
      throw new Error(`command '${transactionId}' requires Git bookkeeping before completion`);
    }
    return true;
  });
  if (!exists) return;
  await gitBookkeeping?.();
  await withLock(paths, async () => {
    const manifest = await readState(paths);
    const stored = manifest.commands.find((plan) => plan.transactionId === transactionId);
    if (!stored) return;
    const pending = stored.phase === 'committed' ? advanceCommand(stored, 'git-pending') : stored;
    if (pending.phase !== 'git-pending') {
      throw new Error(`command '${transactionId}' is not awaiting Git bookkeeping`);
    }
    const complete = advanceCommand(pending, 'complete');
    replacePlan(manifest, complete);
    await clearPlan(paths, manifest, transactionId);
  });
}

/** Execute one complete inert plan, retaining it durably until Git bookkeeping succeeds. */
export async function executeCommandPlan(req: CommandWalRequest): Promise<void> {
  const requestedPlan: CommandPlan = {
    ...req.plan,
    gitRequired: req.plan.gitRequired || req.gitBookkeeping !== undefined,
  };
  if (requestedPlan.gitRequired && !req.gitBookkeeping) {
    throw new Error(`command '${requestedPlan.transactionId}' requires Git bookkeeping`);
  }
  await withLock(req.paths, async () => {
    const manifest = await readState(req.paths);
    if (manifest.commands.some((plan) => plan.transactionId !== requestedPlan.transactionId)) {
      throw new Error('another whole-command WAL is unfinished — recover it first');
    }

    let plan = requestedPlan;
    await persistPlan(req.paths, manifest, plan);
    try {
      plan = advanceCommand(plan, 'applying');
      await persistPlan(req.paths, manifest, plan);
      for (const operation of plan.operations) {
        const effect = requireEffect(req.effects, operation);
        plan = advanceOperation(plan, operation.id, 'applying');
        await persistPlan(req.paths, manifest, plan);
        await effect.apply();
        plan = advanceOperation(plan, operation.id, 'applied');
        await persistPlan(req.paths, manifest, plan);
      }
      plan = advanceCommand(plan, 'committed');
      await persistPlan(req.paths, manifest, plan);
      plan = advanceCommand(plan, 'git-pending');
      await persistPlan(req.paths, manifest, plan);
    } catch (error) {
      if (plan.commitPoint) throw error;
      try {
        await rollBackPlan(req.paths, manifest, plan, req.effects);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'command failed and rollback remains incomplete',
          { cause: rollbackError },
        );
      }
      throw error;
    }
  });

  await finishGitPending(req.paths, requestedPlan.transactionId, req.gitBookkeeping);
}

/** Resume either pre-commit rollback or post-commit Git bookkeeping in a fresh process. */
export async function recoverCommandPlan(req: RecoverCommandWalRequest): Promise<void> {
  const needsGit = await withLock(req.paths, async () => {
    const manifest = await readState(req.paths);
    let plan = manifest.commands.find((candidate) => candidate.transactionId === req.transactionId);
    if (!plan) return false;
    if (plan.phase === 'complete' || plan.phase === 'rolled-back') {
      await clearPlan(req.paths, manifest, plan.transactionId);
      return false;
    }
    if (plan.commitPoint) {
      if (plan.phase === 'committed') {
        plan = advanceCommand(plan, 'git-pending');
        await persistPlan(req.paths, manifest, plan);
      }
      return true;
    }
    await rollBackPlan(req.paths, manifest, plan, req.effects);
    return false;
  });

  if (needsGit) await finishGitPending(req.paths, req.transactionId, req.gitBookkeeping);
}
