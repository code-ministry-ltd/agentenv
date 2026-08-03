/** Durable states for one effect in a whole-command write-ahead plan. */
export type OperationState = 'pending' | 'applying' | 'applied' | 'undoing' | 'undone';

/** Durable command phases. `committed` is the irreversible command-level commit point. */
export type CommandPhase =
  | 'planned'
  | 'applying'
  | 'committed'
  | 'git-pending'
  | 'complete'
  | 'rolling-back'
  | 'rolled-back';

export interface PlannedOperationInput {
  id: string;
  kind: string;
  path?: string;
  preIdentity?: PathIdentity;
  postIdentity?: PathIdentity;
  undoRef?: string;
}

export interface PlannedOperation extends PlannedOperationInput {
  state: OperationState;
}

export interface CommandPlan {
  schemaVersion: 2;
  transactionId: string;
  kind: string;
  /** True when the committed filesystem effects cannot complete without Git bookkeeping. */
  gitRequired: boolean;
  phase: CommandPhase;
  commitPoint: boolean;
  operations: PlannedOperation[];
}

export interface CreateCommandPlanInput {
  transactionId: string;
  kind: string;
  gitRequired?: boolean;
  operations: PlannedOperationInput[];
}

/** Create a complete inert plan before the first effect is applied. */
export function createCommandPlan(input: CreateCommandPlanInput): CommandPlan {
  if (!input.transactionId) throw new Error('transactionId is required');
  const ids = new Set<string>();
  for (const operation of input.operations) {
    if (!operation.id || ids.has(operation.id)) {
      throw new Error(`operation ids must be non-empty and unique: '${operation.id}'`);
    }
    ids.add(operation.id);
  }
  return {
    schemaVersion: 2,
    transactionId: input.transactionId,
    kind: input.kind,
    gitRequired: input.gitRequired ?? false,
    phase: 'planned',
    commitPoint: false,
    operations: input.operations.map((operation) => ({ ...operation, state: 'pending' })),
  };
}

/** Advance the command automaton by exactly one valid durable transition. */
export function advanceCommand(plan: CommandPlan, next: CommandPhase): CommandPlan {
  const allowed: Record<CommandPhase, readonly CommandPhase[]> = {
    planned: ['applying'],
    applying: ['committed', 'rolling-back'],
    committed: ['git-pending'],
    'git-pending': ['complete'],
    complete: [],
    'rolling-back': ['rolled-back'],
    'rolled-back': [],
  };
  if (!allowed[plan.phase].includes(next)) {
    const reason = plan.commitPoint ? ' after the command commit point' : '';
    throw new Error(`invalid command transition ${plan.phase} -> ${next}${reason}`);
  }
  if (next === 'committed' && plan.operations.some((operation) => operation.state !== 'applied')) {
    throw new Error('cannot commit until all operations are applied');
  }
  if (
    next === 'rolled-back' &&
    plan.operations.some((operation) => operation.state !== 'pending' && operation.state !== 'undone')
  ) {
    throw new Error('cannot finish rollback until every applied operation is undone');
  }
  return { ...plan, phase: next, commitPoint: plan.commitPoint || next === 'committed' };
}

/** Advance one operation without permitting skipped or backward states. */
export function advanceOperation(
  plan: CommandPlan,
  operationId: string,
  next: OperationState,
): CommandPlan {
  const index = plan.operations.findIndex((operation) => operation.id === operationId);
  if (index < 0) throw new Error(`unknown operation '${operationId}'`);
  const current = plan.operations[index]!;
  const allowed: Record<OperationState, readonly OperationState[]> = {
    pending: ['applying'],
    applying: ['applied', 'undoing'],
    applied: ['undoing'],
    undoing: ['undone'],
    undone: [],
  };
  if (!allowed[current.state].includes(next)) {
    throw new Error(`invalid operation transition ${current.state} -> ${next}`);
  }
  const forward = next === 'applying' || next === 'applied';
  if (forward && plan.phase !== 'applying') throw new Error('forward operation requires applying command');
  if (!forward && plan.phase !== 'rolling-back') throw new Error('undo requires rolling-back command');
  const operations = [...plan.operations];
  operations[index] = { ...current, state: next };
  return { ...plan, operations };
}
import type { PathIdentity } from './path-identity.js';
