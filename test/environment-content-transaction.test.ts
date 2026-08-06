import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { defaultGitRunner, type GitRunner } from '../src/git.js';
import { resolvePaths } from '../src/paths.js';
import { readState } from '../src/state.js';
import { makeTempHome, type TempHome } from './helpers.js';

const homes: TempHome[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) home.cleanup();
});

function gitHome(): TempHome {
  const home = makeTempHome({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' });
  homes.push(home);
  return home;
}

function failingCommits(): GitRunner {
  return (args, opts) => args.includes('commit')
    ? Promise.resolve({
        code: 1,
        stdout: '',
        stderr: "fatal: Unable to create '.git/index.lock': File exists.",
        timedOut: false,
      })
    : defaultGitRunner(args, opts);
}

describe('environment content publication transactions', () => {
  it('edits a private draft and never exposes invalid editor output canonically', async () => {
    const home = gitHome();
    const paths = resolvePaths(home.env);
    await run(['init'], { env: home.env });
    await run(['create', 'writing'], { env: home.env });
    const canonical = paths.envYaml('writing');
    const before = readFileSync(canonical, 'utf8');
    let editorPath = '';

    const result = await run(['edit', 'writing'], {
      env: { ...home.env, EDITOR: 'fixture-editor' },
      launchEditor: async (_command, args) => {
        editorPath = args.at(-1)!;
        writeFileSync(editorPath, 'not: [valid yaml\n');
        return 0;
      },
    });

    expect(result.code).toBe(1);
    expect(editorPath).not.toBe(canonical);
    expect(editorPath).toContain(join(paths.live, 'commands'));
    expect(result.stderr).toContain(editorPath);
    expect(readFileSync(canonical, 'utf8')).toBe(before);
    expect(readFileSync(editorPath, 'utf8')).toBe('not: [valid yaml\n');
  });

  it('refuses to overwrite a canonical edit that changed while the editor was open', async () => {
    const home = gitHome();
    const paths = resolvePaths(home.env);
    await run(['init'], { env: home.env });
    await run(['create', 'writing'], { env: home.env });
    const canonical = paths.envYaml('writing');

    const result = await run(['edit', 'writing'], {
      env: { ...home.env, EDITOR: 'fixture-editor' },
      launchEditor: async (_command, args) => {
        writeFileSync(args.at(-1)!, 'version: "1.0"\ndescription: planned\n');
        writeFileSync(canonical, 'version: "1.0"\ndescription: external\n');
        return 0;
      },
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/changed.*planning|changed.*publish/i);
    expect(readFileSync(canonical, 'utf8')).toContain('external');
    expect((await readState(paths)).commands).toEqual([]);
  });

  it('leaves create committed locally and recoverable when required Git bookkeeping fails', async () => {
    const home = gitHome();
    const paths = resolvePaths(home.env);
    await run(['init'], { env: home.env });

    const result = await run(['create', 'writing'], { env: home.env, gitRun: failingCommits() });
    expect(result.code).toBe(0);
    expect(existsSync(paths.envDir('writing'))).toBe(true);
    expect((await readState(paths)).commands[0]).toMatchObject({
      kind: 'environment-create',
      phase: 'git-pending',
      commitPoint: true,
    });
    expect(result.stderr).toMatch(/retained|pending|commit/i);

    const recovered = await run(['shell-init'], { env: home.env });
    expect(recovered.code).toBe(0);
    expect((await readState(paths)).commands).toEqual([]);
    expect(execFileSync('git', ['log', '-1', '--format=%s'], {
      cwd: paths.store,
      env: home.env,
      encoding: 'utf8',
    }).trim()).toBe('agentenv: create env writing');
  });

  it('leaves rm committed locally and recoverable when required Git bookkeeping fails', async () => {
    const home = gitHome();
    const paths = resolvePaths(home.env);
    await run(['init'], { env: home.env });
    await run(['create', 'writing'], { env: home.env });

    const result = await run(['rm', 'writing'], {
      env: home.env,
      confirm: async () => true,
      gitRun: failingCommits(),
    });
    expect(result.code).toBe(0);
    expect(existsSync(paths.envDir('writing'))).toBe(false);
    expect((await readState(paths)).commands[0]).toMatchObject({
      kind: 'environment-remove',
      phase: 'git-pending',
      commitPoint: true,
    });

    await run(['shell-init'], { env: home.env });
    expect((await readState(paths)).commands).toEqual([]);
    expect(execFileSync('git', ['log', '-1', '--format=%s'], {
      cwd: paths.store,
      env: home.env,
      encoding: 'utf8',
    }).trim()).toBe('agentenv: remove env writing');
  });

  it('does not remove an environment that changes after confirmation begins', async () => {
    const home = gitHome();
    const paths = resolvePaths(home.env);
    await run(['init'], { env: home.env });
    await run(['create', 'writing'], { env: home.env });
    const external = 'version: "1.0"\ndescription: external-after-prompt\n';

    const result = await run(['rm', 'writing'], {
      env: home.env,
      confirm: async () => {
        writeFileSync(paths.envYaml('writing'), external);
        return true;
      },
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/changed since planning/i);
    expect(readFileSync(paths.envYaml('writing'), 'utf8')).toBe(external);
    expect((await readState(paths)).commands).toEqual([]);
  });
});
