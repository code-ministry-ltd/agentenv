import { existsSync, writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createCommandPlan } from '../src/command-plan.js';
import {
  executeCommandPlan,
  recoverCommandPlan,
  type CommandEffect,
} from '../src/command-wal.js';
import { withLock } from '../src/lock.js';
import type { PathIdentity } from '../src/path-identity.js';
import { resolvePaths } from '../src/paths.js';
import {
  readState,
  STATE_SCHEMA_VERSION_STRING,
  writeState,
  type QuarantineRecord,
} from '../src/state.js';
import { makeTempHome } from './helpers.js';

const absent: PathIdentity = { kind: 'absent' };
const present = (digest: string): PathIdentity => ({ kind: 'file', digest, mode: 0o600 });

function pathPreconditionUndo(expectedIdentity: PathIdentity): string {
  return JSON.stringify({
    schemaVersion: 1,
    type: 'path-precondition',
    expectedIdentity,
  });
}

function plan(ids: string[]) {
  return createCommandPlan({
    transactionId: 'tx-1',
    kind: 'test-command',
    operations: ids.map((id) => ({
      id,
      kind: 'test-effect',
      path: `/${id}`,
      preIdentity: absent,
      postIdentity: present(id),
    })),
  });
}

function effect(
  id: string,
  events: string[],
  state: { value: PathIdentity },
  fail = false,
): CommandEffect {
  return {
    observeIdentity: async () => state.value,
    apply: async () => {
      events.push(`apply:${id}`);
      state.value = present(id);
      if (fail) throw new Error(`failed:${id}`);
    },
    undo: async () => {
      events.push(`undo:${id}`);
      state.value = absent;
    },
  };
}

describe('whole-command WAL executor', () => {
  it('persists the complete plan before effects and clears it only after Git bookkeeping', async () => {
    const th = makeTempHome();
    const paths = resolvePaths(th.env);
    const events: string[] = [];
    const a = { value: absent as PathIdentity };
    const b = { value: absent as PathIdentity };

    await executeCommandPlan({
      paths,
      plan: plan(['a', 'b']),
      effects: new Map([
        ['a', effect('a', events, a)],
        ['b', effect('b', events, b)],
      ]),
      gitBookkeeping: async () => {
        events.push('git');
      },
    });

    expect(events).toEqual(['apply:a', 'apply:b', 'git']);
    expect((await readState(paths)).commands).toEqual([]);
    th.cleanup();
  });

  it('runs effects outside the WAL lock and preserves state they commit under that lock', async () => {
    const th = makeTempHome();
    const paths = resolvePaths(th.env);
    const state = { value: absent as PathIdentity };
    const record: QuarantineRecord = {
      schemaVersion: 2,
      id: 'effect-state',
      kind: 'effect-state',
      path: '/a',
      retainedPath: '/retained/a',
      reason: 'proves nested state mutations survive WAL transitions',
      createdAt: 1,
      resolved: false,
    };
    const nested = effect('a', [], state);
    nested.apply = async () => {
      await withLock(
        paths,
        async () => {
          const manifest = await readState(paths);
          manifest.quarantine.push(record);
          await writeState(paths, manifest);
        },
        { timeoutMs: 50, pollMs: 5 },
      );
      state.value = present('a');
    };

    await executeCommandPlan({
      paths,
      plan: plan(['a']),
      effects: new Map([['a', nested]]),
    });

    expect((await readState(paths)).quarantine).toEqual([record]);
    th.cleanup();
  });

  it('rolls back an uncertain applying effect and prior effects in reverse order', async () => {
    const th = makeTempHome();
    const paths = resolvePaths(th.env);
    const events: string[] = [];
    const a = { value: absent as PathIdentity };
    const b = { value: absent as PathIdentity };

    await expect(
      executeCommandPlan({
        paths,
        plan: plan(['a', 'b']),
        effects: new Map([
          ['a', effect('a', events, a)],
          ['b', effect('b', events, b, true)],
        ]),
      }),
    ).rejects.toThrow(/failed:b/);

    expect(events).toEqual(['apply:a', 'apply:b', 'undo:b', 'undo:a']);
    expect(a.value).toEqual(absent);
    expect(b.value).toEqual(absent);
    expect((await readState(paths)).commands).toEqual([]);
    th.cleanup();
  });

  it('rescues a third identity before restoring pre-state and retains quarantine metadata', async () => {
    const th = makeTempHome();
    const paths = resolvePaths(th.env);
    const events: string[] = [];
    const state = { value: absent as PathIdentity };
    const third = present('user-write');
    const record: QuarantineRecord = {
      schemaVersion: 2,
      id: 'rescue-1',
      kind: 'third-identity',
      path: '/a',
      retainedPath: '/rescue/a',
      reason: 'changed during interrupted effect',
      createdAt: 1,
      resolved: false,
    };
    const risky = effect('a', events, state, true);
    risky.apply = async () => {
      events.push('apply:a');
      state.value = third;
      throw new Error('interrupted');
    };
    risky.rescue = async () => {
      events.push('rescue:a');
      return record;
    };

    await expect(
      executeCommandPlan({ paths, plan: plan(['a']), effects: new Map([['a', risky]]) }),
    ).rejects.toThrow(/interrupted/);

    expect(events).toEqual(['apply:a', 'rescue:a', 'undo:a']);
    expect((await readState(paths)).quarantine).toEqual([record]);
    th.cleanup();
  });

  it('retains a committed git-pending plan and resumes bookkeeping without undo', async () => {
    const th = makeTempHome();
    const paths = resolvePaths(th.env);
    const events: string[] = [];
    const state = { value: absent as PathIdentity };
    const effects = new Map([['a', effect('a', events, state)]]);

    await expect(
      executeCommandPlan({
        paths,
        plan: plan(['a']),
        effects,
        gitBookkeeping: async () => {
          events.push('git:fail');
          throw new Error('git unavailable');
        },
      }),
    ).rejects.toThrow(/git unavailable/);
    expect((await readState(paths)).commands[0]?.phase).toBe('git-pending');

    await expect(
      recoverCommandPlan({
        paths,
        transactionId: 'tx-1',
        effects,
      }),
    ).rejects.toThrow(/requires Git bookkeeping/i);
    expect((await readState(paths)).commands[0]).toMatchObject({
      transactionId: 'tx-1',
      phase: 'git-pending',
      gitRequired: true,
    });

    await recoverCommandPlan({
      paths,
      transactionId: 'tx-1',
      effects,
      gitBookkeeping: async () => {
        events.push('git:retry');
      },
    });
    expect(events).toEqual(['apply:a', 'git:fail', 'git:retry']);
    expect((await readState(paths)).commands).toEqual([]);
    th.cleanup();
  });

  it('never calls a read precondition apply callback and keeps its rollback nonmutating', async () => {
    const th = makeTempHome();
    const paths = resolvePaths(th.env);
    const mutationMarker = `${th.home}/malicious-read-apply`;
    const readApply = vi.fn(async () => {
      writeFileSync(mutationMarker, 'mutated\n');
    });
    const readObserve = vi.fn(async () => absent);
    const readUndo = vi.fn(async () => {
      writeFileSync(mutationMarker, 'undo mutated\n');
    });
    const mutatorState = { value: absent as PathIdentity };
    const failingMutator = effect('mutator', [], mutatorState, true);
    const readPlan = createCommandPlan({
      transactionId: 'read-precondition',
      kind: 'test-command',
      operations: [
        {
          id: 'source',
          kind: 'read-path-precondition',
          path: '/source',
          preIdentity: absent,
          postIdentity: absent,
          undoRef: pathPreconditionUndo(absent),
        },
        {
          id: 'mutator',
          kind: 'test-effect',
          path: '/mutator',
          preIdentity: absent,
          postIdentity: present('mutator'),
        },
      ],
    });

    await expect(executeCommandPlan({
      paths,
      plan: readPlan,
      effects: new Map([
        ['source', {
          observeIdentity: readObserve,
          apply: readApply,
          undo: readUndo,
        }],
        ['mutator', failingMutator],
      ]),
    })).rejects.toThrow(/failed:mutator/);

    expect(readApply).not.toHaveBeenCalled();
    expect(readObserve).not.toHaveBeenCalled();
    expect(readUndo).not.toHaveBeenCalled();
    expect(existsSync(mutationMarker)).toBe(false);
    expect((await readState(paths)).commands).toEqual([]);
    th.cleanup();
  });

  it('compares a read precondition from its durable path without caller callbacks', async () => {
    const th = makeTempHome();
    const paths = resolvePaths(th.env);
    const source = `${th.home}/missing-source`;
    const expected = present('expected-source');
    const observe = vi.fn(async () => expected);
    const apply = vi.fn(async () => {
      writeFileSync(source, 'malicious mutation\n');
    });
    const undo = vi.fn(async () => {
      writeFileSync(source, 'malicious rollback\n');
    });

    await expect(executeCommandPlan({
      paths,
      plan: createCommandPlan({
        transactionId: 'mismatched-read-precondition',
        kind: 'test-command',
        operations: [{
          id: 'source',
          kind: 'read-path-precondition',
          path: source,
          preIdentity: expected,
          postIdentity: expected,
          undoRef: pathPreconditionUndo(expected),
        }],
      }),
      effects: new Map([['source', { observeIdentity: observe, apply, undo }]]),
    })).rejects.toThrow(/path precondition.*changed/i);

    expect(observe).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(undo).not.toHaveBeenCalled();
    expect(existsSync(source)).toBe(false);
    expect((await readState(paths)).commands).toEqual([]);
    th.cleanup();
  });

  it('rejects duplicate durable operation ids before recovery can touch an effect', async () => {
    const th = makeTempHome();
    const paths = resolvePaths(th.env);
    const apply = vi.fn(async () => {});
    const undo = vi.fn(async () => {});
    writeFileSync(paths.state, JSON.stringify({
      version: STATE_SCHEMA_VERSION_STRING,
      items: [],
      commands: [{
        schemaVersion: 2,
        transactionId: 'duplicate-operations',
        kind: 'test-command',
        gitRequired: false,
        phase: 'applying',
        commitPoint: false,
        operations: [
          {
            id: 'duplicate',
            kind: 'replace-path',
            path: '/first',
            preIdentity: absent,
            postIdentity: present('first'),
            state: 'applied',
          },
          {
            id: 'duplicate',
            kind: 'replace-path',
            path: '/second',
            preIdentity: absent,
            postIdentity: present('second'),
            state: 'applied',
          },
        ],
      }],
    }));

    await expect(recoverCommandPlan({
      paths,
      transactionId: 'duplicate-operations',
      effects: new Map([['duplicate', {
        observeIdentity: async () => present('second'),
        apply,
        undo,
      }]]),
    })).rejects.toThrow(/duplicate.*operation id/i);
    expect(apply).not.toHaveBeenCalled();
    expect(undo).not.toHaveBeenCalled();
    th.cleanup();
  });

  it('refuses corrupted mutator rollback suppression during recovery before touching the effect', async () => {
    const th = makeTempHome();
    const paths = resolvePaths(th.env);
    const apply = vi.fn(async () => {});
    const undo = vi.fn(async () => {});
    writeFileSync(paths.state, JSON.stringify({
      version: STATE_SCHEMA_VERSION_STRING,
      items: [],
      commands: [{
        schemaVersion: 2,
        transactionId: 'corrupt-recovery',
        kind: 'test-command',
        gitRequired: false,
        phase: 'applying',
        commitPoint: false,
        operations: [{
          id: 'mutator',
          kind: 'replace-path',
          readOnly: true,
          path: '/target',
          preIdentity: absent,
          postIdentity: present('mutator'),
          undoRef: 'mutating undo metadata',
          state: 'applied',
        }],
      }],
    }));

    await expect(recoverCommandPlan({
      paths,
      transactionId: 'corrupt-recovery',
      effects: new Map([['mutator', {
        observeIdentity: async () => present('mutator'),
        apply,
        undo,
      }]]),
    })).rejects.toThrow(/readOnly/i);
    expect(apply).not.toHaveBeenCalled();
    expect(undo).not.toHaveBeenCalled();
    th.cleanup();
  });
});
