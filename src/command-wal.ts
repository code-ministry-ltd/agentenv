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
  /** Test/diagnostic seam invoked after each durable plan transition. */
  afterPersist?: (plan: CommandPlan) => Promise<void>;
}

export interface RecoverCommandWalRequest {
  paths: Paths;
  transactionId: string;
  effects: ReadonlyMap<string, CommandEffect>;
  gitBookkeeping?: () => Promise<void>;
  /** Test/diagnostic seam invoked after each durable plan transition. */
  afterPersist?: (plan: CommandPlan) => Promise<void>;
}

function replacePlan(manifest: StateManifest, plan: CommandPlan): void {
  const index = manifest.commands.findIndex((candidate) => candidate.transactionId === plan.transactionId);
  if (index < 0) manifest.commands.push(plan);
  else manifest.commands[index] = plan;
}

async function persistPlanLocked(
  paths: Paths,
  manifest: StateManifest,
  plan: CommandPlan,
): Promise<void> {
  replacePlan(manifest, plan);
  await writeState(paths, manifest);
}

async function persistPlan(
  paths: Paths,
  plan: CommandPlan,
  afterPersist?: (plan: CommandPlan) => Promise<void>,
): Promise<void> {
  await withLock(paths, async () => {
    const manifest = await readState(paths);
    await persistPlanLocked(paths, manifest, plan);
  });
  await afterPersist?.(plan);
}

async function clearPlanLocked(
  paths: Paths,
  manifest: StateManifest,
  transactionId: string,
): Promise<void> {
  manifest.commands = manifest.commands.filter((plan) => plan.transactionId !== transactionId);
  await writeState(paths, manifest);
}

async function clearPlan(paths: Paths, transactionId: string): Promise<void> {
  await withLock(paths, async () => {
    const manifest = await readState(paths);
    await clearPlanLocked(paths, manifest, transactionId);
  });
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
  initial: CommandPlan,
  effects: ReadonlyMap<string, CommandEffect>,
  afterPersist?: (plan: CommandPlan) => Promise<void>,
): Promise<CommandPlan> {
  let plan = initial;
  if (plan.phase === 'planned') {
    plan = advanceCommand(plan, 'applying');
    await persistPlan(paths, plan, afterPersist);
  }
  if (plan.phase === 'applying') {
    plan = advanceCommand(plan, 'rolling-back');
    await persistPlan(paths, plan, afterPersist);
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
      await persistPlan(paths, plan, afterPersist);
    }

    const current = plan.operations[index]!;
    const decision = await recoveryDecision(current, effect);
    if (decision.action === 'rescue-third-identity') {
      if (!effect.rescue) {
        throw new Error(`effect '${operation.id}' cannot rescue a third identity`);
      }
      const record = await effect.rescue(decision.observed);
      await withLock(paths, async () => {
        const manifest = await readState(paths);
        manifest.quarantine.push(record);
        await writeState(paths, manifest);
      });
    }
    if (decision.action !== 'skip-pre-state') await effect.undo();

    plan = advanceOperation(plan, operation.id, 'undone');
    await persistPlan(paths, plan, afterPersist);
  }

  plan = advanceCommand(plan, 'rolled-back');
  await persistPlan(paths, plan, afterPersist);
  await clearPlan(paths, plan.transactionId);
  return plan;
}

async function finishGitPending(
  paths: Paths,
  transactionId: string,
  gitBookkeeping: (() => Promise<void>) | undefined,
  afterPersist?: (plan: CommandPlan) => Promise<void>,
): Promise<void> {
  const pendingTransition = await withLock(paths, async () => {
    const manifest = await readState(paths);
    const stored = manifest.commands.find((plan) => plan.transactionId === transactionId);
    if (!stored) return null;
    if (stored.gitRequired === true && !gitBookkeeping) {
      throw new Error(`command '${transactionId}' requires Git bookkeeping before completion`);
    }
    const pending = stored.phase === 'committed' ? advanceCommand(stored, 'git-pending') : stored;
    if (pending.phase !== 'git-pending') {
      throw new Error(`command '${transactionId}' is not awaiting Git bookkeeping`);
    }
    if (pending !== stored) await persistPlanLocked(paths, manifest, pending);
    return pending === stored ? undefined : pending;
  });
  if (pendingTransition === null) return;
  if (pendingTransition) await afterPersist?.(pendingTransition);

  await gitBookkeeping?.();
  const complete = await withLock(paths, async () => {
    const manifest = await readState(paths);
    const stored = manifest.commands.find((plan) => plan.transactionId === transactionId);
    if (!stored) return null;
    if (stored.phase !== 'git-pending') {
      throw new Error(`command '${transactionId}' is not awaiting Git bookkeeping`);
    }
    const completed = advanceCommand(stored, 'complete');
    await persistPlanLocked(paths, manifest, completed);
    return completed;
  });
  if (!complete) return;
  await afterPersist?.(complete);
  await clearPlan(paths, transactionId);
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
    await persistPlanLocked(req.paths, manifest, requestedPlan);
  });
  await req.afterPersist?.(requestedPlan);

  let plan = requestedPlan;
  try {
    plan = advanceCommand(plan, 'applying');
    await persistPlan(req.paths, plan, req.afterPersist);
    for (const operation of plan.operations) {
      const effect = requireEffect(req.effects, operation);
      plan = advanceOperation(plan, operation.id, 'applying');
      await persistPlan(req.paths, plan, req.afterPersist);
      await effect.apply();
      plan = advanceOperation(plan, operation.id, 'applied');
      await persistPlan(req.paths, plan, req.afterPersist);
    }
    plan = advanceCommand(plan, 'committed');
    await persistPlan(req.paths, plan, req.afterPersist);
    plan = advanceCommand(plan, 'git-pending');
    await persistPlan(req.paths, plan, req.afterPersist);
  } catch (error) {
    if (plan.commitPoint) throw error;
    try {
      await rollBackPlan(req.paths, plan, req.effects, req.afterPersist);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'command failed and rollback remains incomplete',
        { cause: rollbackError },
      );
    }
    throw error;
  }

  await finishGitPending(req.paths, requestedPlan.transactionId, req.gitBookkeeping, req.afterPersist);
}

/** Resume either pre-commit rollback or post-commit Git bookkeeping in a fresh process. */
export async function recoverCommandPlan(req: RecoverCommandWalRequest): Promise<void> {
  const plan = await withLock(req.paths, async () => {
    const manifest = await readState(req.paths);
    const stored = manifest.commands.find((candidate) => candidate.transactionId === req.transactionId);
    if (!stored) return null;
    if (stored.phase === 'complete' || stored.phase === 'rolled-back') {
      await clearPlanLocked(req.paths, manifest, stored.transactionId);
      return null;
    }
    return stored;
  });
  if (!plan) return;

  if (plan.commitPoint) {
    await finishGitPending(req.paths, req.transactionId, req.gitBookkeeping, req.afterPersist);
    return;
  }
  await rollBackPlan(req.paths, plan, req.effects, req.afterPersist);
}
