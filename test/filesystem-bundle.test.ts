import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  publishStagedBundle,
  recoverPendingFilesystemBundles,
} from '../src/filesystem-bundle.js';
import { resolvePaths } from '../src/paths.js';
import { readState } from '../src/state.js';
import { makeTempHome, type TempHome } from './helpers.js';

const homes: TempHome[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) home.cleanup();
});

describe('whole-command staged filesystem publication', () => {
  it('rolls content and metadata back together when the second effect fails', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const targetSkill = join(paths.store, 'environments', 'work', 'skills', 'one');
    const targetYaml = join(paths.store, 'environments', 'work', 'env.yaml');
    mkdirSync(targetSkill, { recursive: true });
    writeFileSync(join(targetSkill, 'SKILL.md'), 'old skill\n');
    writeFileSync(targetYaml, 'old metadata\n');

    const stagingRoot = join(paths.live, 'commands', 'test-bundle');
    const stagedSkill = join(stagingRoot, 'skill');
    const stagedYaml = join(stagingRoot, 'env.yaml');
    mkdirSync(stagedSkill, { recursive: true });
    writeFileSync(join(stagedSkill, 'SKILL.md'), 'new skill\n');
    writeFileSync(stagedYaml, 'new metadata\n');

    await expect(
      publishStagedBundle({
        paths,
        transactionId: 'test-bundle',
        stagingRoot,
        entries: [
          { id: 'skill', target: targetSkill, staged: stagedSkill },
          { id: 'metadata', target: targetYaml, staged: stagedYaml },
        ],
        afterApply: async (entry) => {
          if (entry.id === 'metadata') throw new Error('injected metadata publication failure');
        },
      }),
    ).rejects.toThrow(/injected metadata publication failure/);

    expect(readFileSync(join(targetSkill, 'SKILL.md'), 'utf8')).toBe('old skill\n');
    expect(readFileSync(targetYaml, 'utf8')).toBe('old metadata\n');
    expect((await readState(paths)).commands).toEqual([]);
  });

  it('retains committed intent until required Git bookkeeping succeeds', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const target = join(paths.store, 'environments', 'work', 'env.yaml');
    mkdirSync(join(paths.store, 'environments', 'work'), { recursive: true });
    writeFileSync(target, 'old\n');
    const stagingRoot = join(paths.live, 'commands', 'git-pending-bundle');
    const staged = join(stagingRoot, 'env.yaml');
    mkdirSync(stagingRoot, { recursive: true });
    writeFileSync(staged, 'new\n');

    await expect(
      publishStagedBundle({
        paths,
        transactionId: 'git-pending-bundle',
        stagingRoot,
        entries: [{ id: 'env', target, staged }],
        gitBookkeeping: async () => {
          throw new Error('injected Git failure');
        },
      }),
    ).rejects.toThrow(/injected Git failure/);
    expect(readFileSync(target, 'utf8')).toBe('new\n');
    expect((await readState(paths)).commands).toMatchObject([
      { transactionId: 'git-pending-bundle', phase: 'git-pending', commitPoint: true },
    ]);

    let retried = 0;
    await recoverPendingFilesystemBundles(paths, async () => {
      retried += 1;
    });
    expect(retried).toBe(1);
    expect(readFileSync(target, 'utf8')).toBe('new\n');
    expect((await readState(paths)).commands).toEqual([]);
  });

  it('never applies one transaction Git callback to an unrelated pending bundle', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const firstTarget = join(paths.store, 'environments', 'work', 'first.md');
    const secondTarget = join(paths.store, 'environments', 'work', 'second.md');
    mkdirSync(dirname(firstTarget), { recursive: true });
    writeFileSync(firstTarget, 'first-old\n');
    writeFileSync(secondTarget, 'second-old\n');

    const firstRoot = join(paths.live, 'commands', 'first-bundle');
    const firstStaged = join(firstRoot, 'first.md');
    mkdirSync(firstRoot, { recursive: true });
    writeFileSync(firstStaged, 'first-new\n');
    await expect(
      publishStagedBundle({
        paths,
        transactionId: 'first-bundle',
        stagingRoot: firstRoot,
        entries: [{ id: 'first', target: firstTarget, staged: firstStaged }],
        gitBookkeeping: async () => {
          throw new Error('first Git callback failed');
        },
      }),
    ).rejects.toThrow(/first Git callback failed/);

    let wrongCallbackCalls = 0;
    const secondRoot = join(paths.live, 'commands', 'second-bundle');
    const secondStaged = join(secondRoot, 'second.md');
    mkdirSync(secondRoot, { recursive: true });
    writeFileSync(secondStaged, 'second-new\n');
    await expect(
      publishStagedBundle({
        paths,
        transactionId: 'second-bundle',
        stagingRoot: secondRoot,
        entries: [{ id: 'second', target: secondTarget, staged: secondStaged }],
        gitBookkeeping: async () => {
          wrongCallbackCalls += 1;
        },
      }),
    ).rejects.toThrow(/first-bundle|unfinished/i);

    expect(wrongCallbackCalls).toBe(0);
    expect(readFileSync(firstTarget, 'utf8')).toBe('first-new\n');
    expect(readFileSync(secondTarget, 'utf8')).toBe('second-old\n');
    expect((await readState(paths)).commands).toMatchObject([
      { transactionId: 'first-bundle', phase: 'git-pending', gitRequired: true },
    ]);

    let correctCallbackCalls = 0;
    await recoverPendingFilesystemBundles(paths, async () => {
      correctCallbackCalls += 1;
    }, 'first-bundle');
    expect(correctCallbackCalls).toBe(1);
    expect((await readState(paths)).commands).toEqual([]);
  });
});
