import { describe, expect, it } from 'vitest';
import {
  advanceCommand,
  advanceOperation,
  createCommandPlan,
  type CommandPlan,
  type PlannedOperationInput,
} from '../src/command-plan.js';

const absent = { kind: 'absent' } as const;

function pathPreconditionUndo(expectedIdentity = absent): string {
  return JSON.stringify({
    schemaVersion: 1,
    type: 'path-precondition',
    expectedIdentity,
  });
}

function plan(): CommandPlan {
  return createCommandPlan({
    transactionId: 'tx-1',
    kind: 'activate-global',
    operations: [
      { id: 'backup', kind: 'backup-path', path: '/config/a', undoRef: 'absent' },
      { id: 'write', kind: 'write-path', path: '/config/a', undoRef: 'sha256:old' },
    ],
  });
}

describe('whole-command plan automaton', () => {
  it('records durable forward states and commits only after every operation applied', () => {
    let value = advanceCommand(plan(), 'applying');
    value = advanceOperation(value, 'backup', 'applying');
    value = advanceOperation(value, 'backup', 'applied');

    expect(() => advanceCommand(value, 'committed')).toThrow(/all operations.*applied/i);

    value = advanceOperation(value, 'write', 'applying');
    value = advanceOperation(value, 'write', 'applied');
    value = advanceCommand(value, 'committed');

    expect(value.phase).toBe('committed');
    expect(value.commitPoint).toBe(true);
    expect(() => advanceCommand(value, 'rolling-back')).toThrow(/commit point/i);
    value = advanceCommand(value, 'git-pending');
    value = advanceCommand(value, 'complete');
    expect(value.commitPoint).toBe(true);
  });

  it('makes rollback progress explicit and resumable before the commit point', () => {
    let value = advanceCommand(plan(), 'applying');
    value = advanceOperation(value, 'backup', 'applying');
    value = advanceOperation(value, 'backup', 'applied');
    value = advanceCommand(value, 'rolling-back');
    value = advanceOperation(value, 'backup', 'undoing');

    expect(value.phase).toBe('rolling-back');
    expect(value.operations.find((operation) => operation.id === 'backup')?.state).toBe('undoing');

    value = advanceOperation(value, 'backup', 'undone');
    value = advanceCommand(value, 'rolled-back');
    expect(value.phase).toBe('rolled-back');
    expect(value.commitPoint).toBe(false);
  });

  it('rejects skipped or backward operation transitions', () => {
    const value = advanceCommand(plan(), 'applying');
    expect(() => advanceOperation(value, 'write', 'applied')).toThrow(/pending.*applied/i);
    expect(() => advanceOperation(value, 'missing', 'applying')).toThrow(/unknown operation/i);
  });

  it('rejects ambiguous or incomplete durable Git steps', () => {
    expect(() => createCommandPlan({
      transactionId: 'bad-git',
      kind: 'test',
      gitSteps: [
        { id: 'same', message: 'first', paths: ['/store/first'] },
        { id: 'same', message: 'second', paths: ['/store/second'] },
      ],
      operations: [],
    })).toThrow(/Git step ids.*unique/i);
    expect(() => createCommandPlan({
      transactionId: 'bad-paths',
      kind: 'test',
      gitSteps: [{ id: 'empty', message: 'message', paths: [] }],
      operations: [],
    })).toThrow(/Git step.*path/i);
  });

  it.each([
    [
      'a free readOnly flag on a mutating operation',
      {
        id: 'mutator',
        kind: 'replace-path',
        readOnly: true,
        path: '/target',
        preIdentity: absent,
        postIdentity: absent,
        undoRef: 'mutating undo metadata',
      },
      /readOnly/i,
    ],
    [
      'a read precondition without a path',
      {
        id: 'source',
        kind: 'read-path-precondition',
        preIdentity: absent,
        postIdentity: absent,
        undoRef: pathPreconditionUndo(),
      },
      /requires.*path/i,
    ],
    [
      'a read precondition with unequal identities',
      {
        id: 'source',
        kind: 'read-path-precondition',
        path: '/source',
        preIdentity: absent,
        postIdentity: { kind: 'file', digest: 'replacement', mode: 0o600 },
        undoRef: pathPreconditionUndo(),
      },
      /identical preIdentity and postIdentity/i,
    ],
    [
      'a read precondition with malformed identity metadata',
      {
        id: 'source',
        kind: 'read-path-precondition',
        path: '/source',
        preIdentity: { kind: 'file', digest: 42, mode: 0o600 },
        postIdentity: { kind: 'file', digest: 42, mode: 0o600 },
        undoRef: pathPreconditionUndo(),
      },
      /valid preIdentity/i,
    ],
    [
      'a read precondition without matching undo metadata',
      {
        id: 'source',
        kind: 'read-path-precondition',
        path: '/source',
        preIdentity: absent,
        postIdentity: absent,
        undoRef: JSON.stringify({
          schemaVersion: 1,
          type: 'path-precondition',
          expectedIdentity: { kind: 'symlink', target: 'elsewhere' },
        }),
      },
      /undo metadata.*expectedIdentity/i,
    ],
    [
      'path-precondition undo metadata on a mutating operation',
      {
        id: 'mutator',
        kind: 'replace-path',
        path: '/target',
        preIdentity: absent,
        postIdentity: absent,
        undoRef: pathPreconditionUndo(),
      },
      /path-precondition undo metadata.*read-path-precondition/i,
    ],
  ] as const)('rejects %s', (_label, operation, expected) => {
    expect(() => createCommandPlan({
      transactionId: 'invalid-operation',
      kind: 'test',
      operations: [operation as unknown as PlannedOperationInput],
    })).toThrow(expected);
  });
});
