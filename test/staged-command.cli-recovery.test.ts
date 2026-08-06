import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { resolvePaths } from '../src/paths.js';
import { publishStagedCommand } from '../src/staged-command.js';
import { readState } from '../src/state.js';
import { makeTempHome, type TempHome } from './helpers.js';

const homes: TempHome[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) home.cleanup();
});

describe('staged command central CLI recovery', () => {
  it('finishes persisted scoped Git steps before an ordinary invocation', async () => {
    const home = makeTempHome({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' });
    homes.push(home);
    const paths = resolvePaths(home.env);
    await run(['init'], { env: home.env });
    const target = join(paths.store, 'environments', 'work', 'env.yaml');
    const unrelated = join(paths.store, 'unrelated.md');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'version: "1.0"\ndescription: old\n');
    execFileSync('git', ['add', '-A'], { cwd: paths.store, env: home.env });
    execFileSync('git', [
      '-c', 'user.name=test',
      '-c', 'user.email=test@example.invalid',
      '-c', 'commit.gpgsign=false',
      'commit', '-m', 'fixture',
    ], { cwd: paths.store, env: home.env });
    writeFileSync(unrelated, 'remain dirty\n');
    const stagingRoot = join(paths.live, 'commands', 'recover-edit');
    const staged = join(stagingRoot, 'env.yaml');
    mkdirSync(stagingRoot, { recursive: true });
    writeFileSync(staged, 'version: "1.0"\ndescription: new\n');

    await expect(publishStagedCommand({
      paths,
      transactionId: 'recover-edit',
      kind: 'environment-edit',
      stagingRoot,
      allowedRoots: [paths.store],
      entries: [{ id: 'env', target, staged }],
      gitSteps: [{ id: 'edit', message: 'agentenv: edit env work', paths: [target] }],
      gitBookkeeping: async () => {
        throw new Error('simulated process-ending Git failure');
      },
    })).rejects.toThrow(/Git failure/);

    const result = await run(['shell-init'], { env: home.env });
    expect(result.code, `${result.stdout}${result.stderr ?? ''}`).toBe(0);
    expect((await readState(paths)).commands).toEqual([]);
    expect(existsSync(stagingRoot)).toBe(false);
    expect(execFileSync('git', ['log', '-1', '--format=%s'], {
      cwd: paths.store,
      env: home.env,
      encoding: 'utf8',
    }).trim()).toBe('agentenv: edit env work');
    expect(execFileSync('git', ['status', '--short', '--', 'unrelated.md'], {
      cwd: paths.store,
      env: home.env,
      encoding: 'utf8',
    })).toContain('?? unrelated.md');
  });

  it('finishes the exact persisted Git steps through resolve command --retry', async () => {
    const home = makeTempHome({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' });
    homes.push(home);
    const paths = resolvePaths(home.env);
    await run(['init'], { env: home.env });
    const target = join(paths.store, 'environments', 'work', 'env.yaml');
    const unrelated = join(paths.store, 'unrelated.md');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'version: "1.0"\ndescription: old\n');
    execFileSync('git', ['add', '-A'], { cwd: paths.store, env: home.env });
    execFileSync('git', [
      '-c', 'user.name=test',
      '-c', 'user.email=test@example.invalid',
      '-c', 'commit.gpgsign=false',
      'commit', '-m', 'fixture',
    ], { cwd: paths.store, env: home.env });
    writeFileSync(unrelated, 'remain dirty\n');
    const stagingRoot = join(paths.live, 'commands', 'resolve-edit');
    const staged = join(stagingRoot, 'env.yaml');
    mkdirSync(stagingRoot, { recursive: true });
    writeFileSync(staged, 'version: "1.0"\ndescription: resolved\n');

    await expect(publishStagedCommand({
      paths,
      transactionId: 'resolve-edit',
      kind: 'environment-edit',
      stagingRoot,
      allowedRoots: [paths.store],
      entries: [{ id: 'env', target, staged }],
      gitSteps: [{ id: 'edit', message: 'agentenv: resolve edit work', paths: [target] }],
      gitBookkeeping: async () => {
        throw new Error('simulated process-ending Git failure');
      },
    })).rejects.toThrow(/Git failure/);

    const result = await run(['resolve', 'command', 'resolve-edit', '--retry'], { env: home.env });
    expect(result.code, `${result.stdout}${result.stderr ?? ''}`).toBe(0);
    expect(result.stdout).toContain("Completed retained command 'resolve-edit'");
    expect((await readState(paths)).commands).toEqual([]);
    expect(existsSync(stagingRoot)).toBe(false);
    expect(execFileSync('git', ['log', '-1', '--format=%s'], {
      cwd: paths.store,
      env: home.env,
      encoding: 'utf8',
    }).trim()).toBe('agentenv: resolve edit work');
    expect(execFileSync('git', ['status', '--short', '--', 'unrelated.md'], {
      cwd: paths.store,
      env: home.env,
      encoding: 'utf8',
    })).toContain('?? unrelated.md');
  });
});
