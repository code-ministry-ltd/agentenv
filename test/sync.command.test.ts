import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { resolvePaths } from '../src/paths.js';
import { makeTempHome, type TempHome } from './helpers.js';

/**
 * `agentenv sync` — the manual sync command (Task 2.2, slice 1: clean-state sync).
 * Hermetic: a temp AGENTENV_HOME and a `file://` bare-repo remote; NO network.
 */

const homes: TempHome[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function gitHome(): TempHome {
  const th = makeTempHome({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' });
  homes.push(th);
  return th;
}

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'other',
  GIT_AUTHOR_EMAIL: 'other@machine.invalid',
  GIT_COMMITTER_NAME: 'other',
  GIT_COMMITTER_EMAIL: 'other@machine.invalid',
};

function quietGit(args: string[], cwd?: string): void {
  execFileSync('git', args, { ...(cwd ? { cwd } : {}), env: GIT_ENV, stdio: 'ignore' });
}

/** Create + init a bare remote; return its file:// URL. */
function makeBareRemote(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentenv-remote-'));
  dirs.push(dir);
  const bare = join(dir, 'store.git');
  quietGit(['init', '--bare', '-b', 'main', bare]);
  return pathToFileURL(bare).href;
}

/** Simulate ANOTHER machine: clone the remote, mutate, commit, push. */
function otherMachinePushes(remoteUrl: string, mutate: (storeRoot: string) => void, message: string): void {
  const wd = mkdtempSync(join(tmpdir(), 'agentenv-other-'));
  dirs.push(wd);
  const clone = join(wd, 'clone');
  quietGit(['clone', remoteUrl, clone]);
  mutate(clone);
  quietGit(['add', '-A'], clone);
  quietGit(['commit', '-m', message, '--no-verify'], clone);
  quietGit(['push', 'origin', 'main'], clone);
}

function subjects(store: string): string[] {
  return execFileSync('git', ['log', '--format=%s'], { cwd: store, encoding: 'utf8' })
    .split('\n')
    .filter((l) => l.trim() !== '');
}

describe('sync: manual clean-state sync (D9, Task 2.2)', () => {
  it('with no remote configured, commits local drift and reports a local-only sync', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    await run(['init'], { env: th.env });
    await run(['create', 'writing'], { env: th.env });

    const res = await run(['sync'], { env: th.env });
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/no remote is configured/i);
    // The create commit is present in local history.
    expect(subjects(paths.store)).toContain('agentenv: create env writing');
  });

  it('pulls a non-conflicting remote change and reports it', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    await run(['init'], { env: th.env });
    await run(['create', 'writing'], { env: th.env });
    const remote = makeBareRemote();
    await run(['remote', remote], { env: th.env });

    // Another machine adds a brand-new (non-conflicting) env.
    otherMachinePushes(
      remote,
      (root) => {
        const dir = join(root, 'environments', 'coding');
        execFileSync('mkdir', ['-p', dir]);
        writeFileSync(join(dir, 'env.yaml'), 'version: "1.0"\ndescription: coding env\n');
      },
      'agentenv: create env coding',
    );

    const res = await run(['sync'], { env: th.env });
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/Pulled remote changes/i);
    // The pulled env is now present in the local working tree.
    expect(subjects(paths.store)).toContain('agentenv: create env coding');
    expect(readFileSync(join(paths.environments, 'coding', 'env.yaml'), 'utf8')).toContain('coding env');
  });

  it('pushes local commits to the remote and reports the push', async () => {
    const th = gitHome();
    const remote = makeBareRemote();
    await run(['init'], { env: th.env });
    await run(['remote', remote], { env: th.env });
    await run(['create', 'writing'], { env: th.env }); // commits + pushes already

    // A fresh local mutation, then an explicit manual sync flushes it to the remote.
    await run(['create', 'coding'], { env: th.env });
    const res = await run(['sync'], { env: th.env });
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/Nothing to push|Pushed local changes/i);

    const bareDir = new URL(remote).pathname;
    const remoteSubjects = execFileSync('git', ['log', '--format=%s', 'main'], { cwd: bareDir, encoding: 'utf8' });
    expect(remoteSubjects).toContain('agentenv: create env coding');
  });

  it('rejects an unknown flag and mutually-exclusive --resolve --abort', async () => {
    const th = gitHome();
    await run(['init'], { env: th.env });

    const bad = await run(['sync', '--nope'], { env: th.env });
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/unknown option/i);

    const both = await run(['sync', '--resolve', '--abort'], { env: th.env });
    expect(both.code).toBe(1);
    expect(both.stderr).toMatch(/mutually exclusive/i);
  });
});
