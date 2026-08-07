import { identitiesEqual, type PathIdentity } from './path-identity.js';

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

/** The only durable operation variant whose recovery never invokes undo. */
export interface ReadPathPreconditionOperationInput extends PlannedOperationInput {
  kind: 'read-path-precondition';
  path: string;
  preIdentity: PathIdentity;
  postIdentity: PathIdentity;
  undoRef: string;
}

export interface PathPreconditionUndo {
  schemaVersion: 1;
  type: 'path-precondition';
  expectedIdentity: PathIdentity;
}

export interface PlannedOperation extends PlannedOperationInput {
  state: OperationState;
}

/** One idempotent path-scoped Git commit required after the local commit point. */
export interface PlannedGitStep {
  id: string;
  message: string;
  paths: string[];
  /** Durable recovery progress; a completed step is never replayed. */
  status?: 'pending' | 'complete';
  /** Exact commit created for this step (absent for a no-op/non-repo step). */
  commitId?: string;
}

export interface CommandPlan {
  schemaVersion: 2;
  transactionId: string;
  kind: string;
  /** True when the committed filesystem effects cannot complete without Git bookkeeping. */
  gitRequired: boolean;
  /** Exact local commit subject for generic retryable content mutations. */
  gitMessage?: string;
  /** Ordered path-scoped commits; Git/worktree state makes completed steps idempotent. */
  gitSteps?: PlannedGitStep[];
  phase: CommandPhase;
  commitPoint: boolean;
  operations: PlannedOperation[];
}

export interface CreateCommandPlanInput {
  transactionId: string;
  kind: string;
  gitRequired?: boolean;
  gitMessage?: string;
  gitSteps?: readonly PlannedGitStep[];
  operations: PlannedOperationInput[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidPathIdentity(value: unknown): value is PathIdentity {
  if (!isObject(value)) return false;
  if (value.kind === 'absent') return true;
  if (value.kind === 'symlink') return typeof value.target === 'string';
  if (value.kind === 'directory-location') {
    return (
      typeof value.device === 'string' &&
      value.device !== '' &&
      typeof value.inode === 'string' &&
      value.inode !== '' &&
      Number.isSafeInteger(value.mode) &&
      (value.mode as number) >= 0
    );
  }
  return (
    (value.kind === 'file' || value.kind === 'directory') &&
    typeof value.digest === 'string' &&
    value.digest !== '' &&
    Number.isSafeInteger(value.mode) &&
    (value.mode as number) >= 0
  );
}

function parseUndoRecord(undoRef: unknown): Record<string, unknown> | null {
  if (typeof undoRef !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(undoRef);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Validate the durable discriminator that is allowed to suppress rollback. */
export function plannedOperationInvariantError(
  operation: Record<string, unknown>,
): string | null {
  if ('readOnly' in operation) {
    return `operation '${String(operation.id)}' cannot use the retired readOnly flag`;
  }

  const undo = parseUndoRecord(operation.undoRef);
  const pathPreconditionUndo = undo?.type === 'path-precondition';
  if (operation.kind !== 'read-path-precondition') {
    return pathPreconditionUndo
      ? `operation '${String(operation.id)}' has path-precondition undo metadata but is not a read-path-precondition`
      : null;
  }

  if (typeof operation.path !== 'string' || operation.path === '') {
    return `read-path-precondition operation '${String(operation.id)}' requires a non-empty path`;
  }
  if (!isValidPathIdentity(operation.preIdentity)) {
    return `read-path-precondition operation '${String(operation.id)}' requires a valid preIdentity`;
  }
  if (!isValidPathIdentity(operation.postIdentity)) {
    return `read-path-precondition operation '${String(operation.id)}' requires a valid postIdentity`;
  }
  if (!identitiesEqual(operation.preIdentity, operation.postIdentity)) {
    return `read-path-precondition operation '${String(operation.id)}' requires identical preIdentity and postIdentity`;
  }
  if (
    !pathPreconditionUndo ||
    undo.schemaVersion !== 1 ||
    !isValidPathIdentity(undo.expectedIdentity)
  ) {
    return `read-path-precondition operation '${String(operation.id)}' requires valid path-precondition undo metadata`;
  }
  if (!identitiesEqual(operation.preIdentity, undo.expectedIdentity)) {
    return `read-path-precondition operation '${String(operation.id)}' undo metadata expectedIdentity must match its path identity`;
  }
  return null;
}

export function assertPlannedOperationInvariant(operation: PlannedOperationInput): void {
  const invalid = plannedOperationInvariantError(operation as unknown as Record<string, unknown>);
  if (invalid) throw new Error(invalid);
}

/** True only for the fully validated durable read-only operation variant. */
export function isReadPathPreconditionOperation(
  operation: PlannedOperationInput,
): operation is ReadPathPreconditionOperationInput {
  assertPlannedOperationInvariant(operation);
  return operation.kind === 'read-path-precondition';
}

/** Create a complete inert plan before the first effect is applied. */
export function createCommandPlan(input: CreateCommandPlanInput): CommandPlan {
  if (!input.transactionId) throw new Error('transactionId is required');
  const ids = new Set<string>();
  for (const operation of input.operations) {
    if (!operation.id || ids.has(operation.id)) {
      throw new Error(`operation ids must be non-empty and unique: '${operation.id}'`);
    }
    assertPlannedOperationInvariant(operation);
    ids.add(operation.id);
  }
  const gitStepIds = new Set<string>();
  for (const step of input.gitSteps ?? []) {
    if (!step.id || gitStepIds.has(step.id)) {
      throw new Error(`Git step ids must be non-empty and unique: '${step.id}'`);
    }
    if (!step.message.trim()) throw new Error(`Git step '${step.id}' requires a commit message`);
    if (step.paths.length === 0 || step.paths.some((path) => !path)) {
      throw new Error(`Git step '${step.id}' requires at least one non-empty path`);
    }
    gitStepIds.add(step.id);
  }
  return {
    schemaVersion: 2,
    transactionId: input.transactionId,
    kind: input.kind,
    gitRequired: input.gitRequired ?? false,
    ...(input.gitMessage ? { gitMessage: input.gitMessage } : {}),
    ...(input.gitSteps ? {
      gitSteps: input.gitSteps.map((step) => ({
        ...step,
        paths: [...step.paths],
        status: step.status ?? 'pending',
      })),
    } : {}),
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
