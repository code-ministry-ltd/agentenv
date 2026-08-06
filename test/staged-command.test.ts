import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  publishStagedCommand,
  recoverPendingStagedCommands,
} from '../src/staged-command.js';
import { resolvePaths } from '../src/paths.js';
import { emptyManifest, readState, writeState } from '../src/state.js';
import { makeTempHome, type TempHome } from './helpers.js';

const homes: TempHome[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) home.cleanup();
});

describe('staged whole-command publication', () => {
  it('persists the complete path and state plan before the first actual effect', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const externalRoot = join(home.home, 'harness');
    const target = join(externalRoot, 'config.json');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'old\n');
    const manifest = emptyManifest();
    (manifest as { inventory?: string[] }).inventory = ['old'];
    await writeState(paths, manifest);

    const stagingRoot = join(paths.live, 'commands', 'planned-command');
    const staged = join(stagingRoot, 'config.json');
    mkdirSync(stagingRoot, { recursive: true });
    writeFileSync(staged, 'new\n');
    let sawPlanned = false;

    await publishStagedCommand({
      paths,
      transactionId: 'planned-command',
      kind: 'test-maintenance',
      stagingRoot,
      allowedRoots: [externalRoot],
      entries: [{ id: 'config', target, staged }],
      statePatch: { inventory: ['new'] },
      afterPersist: async (plan) => {
        if (plan.phase !== 'planned') return;
        sawPlanned = true;
        expect(plan.operations.map((operation) => operation.id)).toEqual(['config', 'state']);
        expect(readFileSync(target, 'utf8')).toBe('old\n');
        expect((await readState(paths)).inventory).toEqual(['old']);
      },
    });

    expect(sawPlanned).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('new\n');
    expect((await readState(paths)).inventory).toEqual(['new']);
    expect((await readState(paths)).commands).toEqual([]);
  });

  it('rolls every path and state domain back when a later effect fails', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const externalRoot = join(home.home, 'harness');
    const first = join(paths.store, 'environments', 'work', 'env.yaml');
    const second = join(externalRoot, 'config.json');
    mkdirSync(dirname(first), { recursive: true });
    mkdirSync(dirname(second), { recursive: true });
    writeFileSync(first, 'first-old\n');
    writeFileSync(second, 'second-old\n');
    const manifest = emptyManifest();
    (manifest as { inventory?: string[] }).inventory = ['old'];
    await writeState(paths, manifest);

    const stagingRoot = join(paths.live, 'commands', 'rollback-command');
    const firstStaged = join(stagingRoot, 'first');
    const secondStaged = join(stagingRoot, 'second');
    mkdirSync(stagingRoot, { recursive: true });
    writeFileSync(firstStaged, 'first-new\n');
    writeFileSync(secondStaged, 'second-new\n');

    await expect(
      publishStagedCommand({
        paths,
        transactionId: 'rollback-command',
        kind: 'test-maintenance',
        stagingRoot,
        allowedRoots: [paths.store, externalRoot],
        entries: [
          { id: 'first', target: first, staged: firstStaged },
          { id: 'second', target: second, staged: secondStaged },
        ],
        statePatch: { inventory: ['new'] },
        afterApply: async (id) => {
          if (id === 'state') throw new Error('injected state publication failure');
        },
      }),
    ).rejects.toThrow(/injected state publication failure/);

    expect(readFileSync(first, 'utf8')).toBe('first-old\n');
    expect(readFileSync(second, 'utf8')).toBe('second-old\n');
    expect((await readState(paths)).inventory).toEqual(['old']);
    expect((await readState(paths)).commands).toEqual([]);
  });

  it('reconstructs committed recovery from durable metadata after Git fails', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const target = join(paths.store, 'environments', 'work', 'env.yaml');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'old\n');
    await writeState(paths, emptyManifest());
    const stagingRoot = join(paths.live, 'commands', 'git-pending-command');
    const staged = join(stagingRoot, 'env.yaml');
    mkdirSync(stagingRoot, { recursive: true });
    writeFileSync(staged, 'new\n');

    await expect(
      publishStagedCommand({
        paths,
        transactionId: 'git-pending-command',
        kind: 'environment-edit',
        stagingRoot,
        allowedRoots: [paths.store],
        entries: [{ id: 'env', target, staged }],
        gitBookkeeping: async () => {
          throw new Error('injected Git failure');
        },
        gitSteps: [{
          id: 'edit-work',
          message: 'agentenv: edit env work',
          paths: [target],
        }],
      }),
    ).rejects.toThrow(/injected Git failure/);
    expect(readFileSync(target, 'utf8')).toBe('new\n');
    expect(existsSync(stagingRoot)).toBe(true);
    expect((await readState(paths)).commands[0]).toMatchObject({
      gitSteps: [{ id: 'edit-work', message: 'agentenv: edit env work', paths: [target] }],
    });

    let retried = 0;
    await recoverPendingStagedCommands(paths, async () => {
      retried += 1;
    }, 'git-pending-command');
    expect(retried).toBe(1);
    expect(readFileSync(target, 'utf8')).toBe('new\n');
    expect(existsSync(stagingRoot)).toBe(false);
    expect((await readState(paths)).commands).toEqual([]);
  });

  it('retains a third identity before restoring the planned pre-state', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const root = join(home.home, 'surface');
    const first = join(root, 'first');
    const second = join(root, 'second');
    mkdirSync(root, { recursive: true });
    writeFileSync(first, 'first-old\n');
    writeFileSync(second, 'second-old\n');
    await writeState(paths, emptyManifest());
    const stagingRoot = join(paths.live, 'commands', 'third-command');
    mkdirSync(stagingRoot, { recursive: true });
    writeFileSync(join(stagingRoot, 'first'), 'first-new\n');
    writeFileSync(join(stagingRoot, 'second'), 'second-new\n');

    await expect(
      publishStagedCommand({
        paths,
        transactionId: 'third-command',
        kind: 'test-maintenance',
        stagingRoot,
        allowedRoots: [root],
        entries: [
          { id: 'first', target: first, staged: join(stagingRoot, 'first') },
          { id: 'second', target: second, staged: join(stagingRoot, 'second') },
        ],
        afterApply: async (id) => {
          if (id === 'first') writeFileSync(first, 'third-party\n');
          if (id === 'second') throw new Error('fail after second');
        },
      }),
    ).rejects.toThrow(/fail after second/);

    expect(readFileSync(first, 'utf8')).toBe('first-old\n');
    expect(readFileSync(second, 'utf8')).toBe('second-old\n');
    const quarantine = (await readState(paths)).quarantine;
    expect(quarantine).toHaveLength(1);
    expect(readFileSync(quarantine[0]!.retainedPath, 'utf8')).toBe('third-party\n');
  });

  it('does not overwrite a state domain that changes after planning', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const target = join(home.home, 'surface', 'config');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'old\n');
    const manifest = emptyManifest();
    (manifest as { inventory?: string[] }).inventory = ['old'];
    await writeState(paths, manifest);
    const stagingRoot = join(paths.live, 'commands', 'state-race');
    const staged = join(stagingRoot, 'config');
    mkdirSync(stagingRoot, { recursive: true });
    writeFileSync(staged, 'new\n');

    await expect(publishStagedCommand({
      paths,
      transactionId: 'state-race',
      kind: 'test-maintenance',
      stagingRoot,
      allowedRoots: [join(home.home, 'surface')],
      entries: [{ id: 'config', target, staged }],
      statePatch: { inventory: ['planned'] },
      afterApply: async (id) => {
        if (id !== 'config') return;
        const changed = await readState(paths);
        (changed as { inventory?: string[] }).inventory = ['external'];
        await writeState(paths, changed);
      },
    })).rejects.toThrow(/state changed before apply/i);

    expect(readFileSync(target, 'utf8')).toBe('old\n');
    expect((await readState(paths)).inventory).toEqual(['external']);
    expect((await readState(paths)).commands).toEqual([]);
  });

  it('retains a third state-domain identity before restoring pre-state', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const manifest = emptyManifest();
    (manifest as { inventory?: string[] }).inventory = ['old'];
    await writeState(paths, manifest);
    const stagingRoot = join(paths.live, 'commands', 'state-third');
    mkdirSync(stagingRoot, { recursive: true });

    await expect(publishStagedCommand({
      paths,
      transactionId: 'state-third',
      kind: 'test-maintenance',
      stagingRoot,
      allowedRoots: [paths.store],
      entries: [],
      statePatch: { inventory: ['planned'] },
      afterApply: async (id) => {
        if (id !== 'state') return;
        const changed = await readState(paths);
        (changed as { inventory?: string[] }).inventory = ['external'];
        await writeState(paths, changed);
        throw new Error('fail after external state replacement');
      },
    })).rejects.toThrow(/external state replacement/);

    const after = await readState(paths);
    expect(after.inventory).toEqual(['old']);
    expect(after.commands).toEqual([]);
    expect(after.quarantine).toHaveLength(1);
    expect(JSON.parse(readFileSync(after.quarantine[0]!.retainedPath, 'utf8')))
      .toEqual({ inventory: ['external'] });
  });
});
