import { describe, expect, it } from 'vitest';
import { createCommandPlan } from '../src/command-plan.js';
import {
  executeCommandPlan,
  recoverCommandPlan,
  type CommandEffect,
} from '../src/command-wal.js';
import type { PathIdentity } from '../src/path-identity.js';
import { resolvePaths } from '../src/paths.js';
import { readState, type QuarantineRecord } from '../src/state.js';
import { makeTempHome } from './helpers.js';

const absent: PathIdentity = { kind: 'absent' };
const present = (digest: string): PathIdentity => ({ kind: 'file', digest, mode: 0o600 });

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
});
