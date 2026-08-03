import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import {
  addRemote,
  defaultGitRunner,
  type GitRunner,
  isPushQueued,
  pullRebase,
  pushStore,
  readPushQueue,
  redactRemoteUrl,
} from '../src/git.js';
import { resolvePaths } from '../src/paths.js';
import { makeFixtureRepo, makeTempHome, type FixtureRepo, type TempHome } from './helpers.js';

const homes: TempHome[] = [];
const repos: FixtureRepo[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
  for (const r of repos.splice(0)) r.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function gitHome(): TempHome {
  const th = makeTempHome({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' });
  homes.push(th);
  return th;
}

/** A path for a bare remote, plus its file:// URL. `init` controls whether it exists. */
function bareRemotePath(init: boolean): { dir: string; url: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agentenv-remote-'));
  dirs.push(dir);
  const bare = join(dir, 'store.git');
  if (init) {
    execFileSync('git', ['init', '--bare', '-b', 'main', bare], { encoding: 'utf8' });
  }
  return { dir: bare, url: pathToFileURL(bare).href };
}

function subjects(dir: string): string[] {
  return execFileSync('git', ['log', '--format=%s'], { cwd: dir, encoding: 'utf8' })
    .split('\n')
    .filter((l) => l.trim() !== '');
}

/** Wrap the real runner to count `git push` invocations. */
function countingRunner(): { run: GitRunner; pushes: () => number } {
  let pushes = 0;
  const run: GitRunner = (args, opts) => {
    if (args[0] === 'push') pushes += 1;
    return defaultGitRunner(args, opts);
  };
  return { run, pushes: () => pushes };
}

describe('sync: remote connect (empty-remote / first connect, D14)', () => {
  it('connects an empty remote and pushes local history', async () => {
    const th = gitHome();
    const remote = bareRemotePath(true);
    await run(['init'], { env: th.env });

    const res = await run(['remote', remote.url], { env: th.env });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Connected remote');
    // The remote received the baseline commit.
    expect(subjects(remote.dir)).toContain('agentenv: initialise store');
  });

  it('is an idempotent no-op for the same URL, and safely replaces a different empty remote (2.3)', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    const remote = bareRemotePath(true);
    await run(['init'], { env: th.env });
    await run(['remote', remote.url], { env: th.env });

    const same = await run(['remote', remote.url + '/'], { env: th.env });
    expect(same.code).toBe(0);
    expect(same.stdout).toContain('no change');

    // A DIFFERENT empty remote is now safely adopted (Task 2.3): push local history,
    // then flip the configured URL to it.
    const other = bareRemotePath(true);
    const different = await run(['remote', other.url], { env: th.env });
    expect(different.code).toBe(0);
    expect(
      execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: paths.store, encoding: 'utf8' }).trim(),
    ).toBe(other.url);
    expect(subjects(other.dir)).toContain('agentenv: initialise store');
  });

  it('never logs credentials embedded in a URL', async () => {
    const th = gitHome();
    await run(['init'], { env: th.env });
    // Unreachable https URL with a secret — connect queues the push; the secret is redacted.
    const res = await run(['remote', 'https://user:supersecret@example.invalid/store.git'], {
      env: th.env,
    });
    expect(res.stdout + (res.stderr ?? '')).not.toContain('supersecret');
  });
});

describe('sync: one fail-soft push per invocation (D9)', () => {
  it('three add-skill mutations in one invocation → three commits + exactly ONE push', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    const remote = bareRemotePath(true);
    await run(['init'], { env: th.env });
    await run(['remote', remote.url], { env: th.env });
    await run(['create', 'writing'], { env: th.env });

    const repo = makeFixtureRepo();
    repos.push(repo);
    repo.writeSkill('skills/alpha');
    repo.writeSkill('skills/beta');
    repo.writeSkill('skills/gamma');
    repo.commit('init');

    const counter = countingRunner();
    const before = subjects(paths.store).length;
    const res = await run(['add', 'skills', 'writing', repo.fileUrl('skills'), '--all'], {
      env: th.env,
      gitRun: counter.run,
    });
    expect(res.code).toBe(0);
    expect(subjects(paths.store).length - before).toBe(3); // three commits
    expect(counter.pushes()).toBe(1); // exactly one push for the whole invocation
    // All three reached the remote via that single push.
    const remoteSubjects = subjects(remote.dir);
    for (const name of ['alpha', 'beta', 'gamma']) {
      expect(remoteSubjects).toContain(`agentenv: add skill ${name} → writing`);
    }
  });

  it('a session `use` commits nothing of its own', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    await run(['init'], { env: th.env });
    await run(['create', 'writing'], { env: th.env });
    const before = subjects(paths.store);

    const res = await run(['use', 'writing'], { env: { ...th.env, AGENTENV_SESSION: 'sess-1' }, cwd: th.home });
    expect(res.code).toBe(0);
    expect(subjects(paths.store)).toEqual(before); // no new commit
  });
});

describe('sync: push failure queues + flushes on the next reachable invocation (D9, criterion 11)', () => {
  it('queues an unreachable push, then flushes it once the remote comes up', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    await run(['init'], { env: th.env });

    // Connect a remote whose bare repo does NOT exist yet — the initial push is queued.
    const remote = bareRemotePath(false);
    const connect = await run(['remote', remote.url], { env: th.env });
    expect(connect.code).toBe(0);

    await run(['create', 'writing'], { env: th.env });
    expect(await isPushQueued(paths)).toBe(true);
    expect(existsSync(remote.dir)).toBe(false);

    // Bring the remote up, then make another mutation: its end-of-invocation push flushes the queue.
    execFileSync('git', ['init', '--bare', '-b', 'main', remote.dir], { encoding: 'utf8' });
    const res = await run(['create', 'other'], { env: th.env });
    expect(res.code).toBe(0);
    expect(await isPushQueued(paths)).toBe(false);

    const remoteSubjects = subjects(remote.dir);
    expect(remoteSubjects).toContain('agentenv: create env writing');
    expect(remoteSubjects).toContain('agentenv: create env other');
  });

  it('a read-only invocation services the queued persistence lifecycle', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    await run(['init'], { env: th.env });
    const remote = bareRemotePath(false);
    await run(['remote', remote.url], { env: th.env });
    await run(['create', 'writing'], { env: th.env });
    expect(await isPushQueued(paths)).toBe(true);

    execFileSync('git', ['init', '--bare', '-b', 'main', remote.dir], { encoding: 'utf8' });
    const listed = await run(['list'], { env: th.env });

    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain('writing');
    expect(await isPushQueued(paths)).toBe(false);
    expect(subjects(remote.dir)).toContain('agentenv: create env writing');
  });
});

describe('sync: git stderr shown to the user is credential-redacted (F5)', () => {
  it('redactRemoteUrl redacts a credentialed URL embedded in a git error line', () => {
    const line = "fatal: unable to access 'https://user:s3kr3t@host.invalid/store.git/': error 403";
    const redacted = redactRemoteUrl(line);
    expect(redacted).not.toContain('s3kr3t');
    expect(redacted).toContain('user:***@');
  });

  it('a push failure detail (and the queued lastError) never carries a credential', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    await run(['init'], { env: th.env });
    await addRemote(paths, th.env, 'https://user:s3kr3t@host.invalid/store.git');

    // git today strips creds, but be defensive: a runner whose push stderr leaks a
    // credentialed URL must still be redacted before it reaches a notice or the queue.
    const leakyPush: GitRunner = (args, opts) =>
      args[0] === 'push'
        ? Promise.resolve({
            code: 1,
            stdout: '',
            stderr: "fatal: unable to access 'https://user:s3kr3t@host.invalid/store.git/': error 403",
            timedOut: false,
          })
        : defaultGitRunner(args, opts);

    const res = await pushStore(paths, th.env, { run: leakyPush });
    expect(res.status).toBe('queued');
    expect(res.detail ?? '').not.toContain('s3kr3t');
    expect(res.detail ?? '').toContain('***');
    // The persisted retry queue must not leak it either.
    const queue = await readPushQueue(paths);
    expect(queue.lastError ?? '').not.toContain('s3kr3t');
  });

  it('a pull error detail never carries a credential', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    await run(['init'], { env: th.env });
    await run(['create', 'writing'], { env: th.env }); // gives HEAD so pull is attempted
    await addRemote(paths, th.env, 'https://user:s3kr3t@host.invalid/store.git');

    const leakyPull: GitRunner = (args, opts) =>
      args[0] === 'pull'
        ? Promise.resolve({
            code: 1,
            stdout: '',
            stderr: "fatal: unable to access 'https://user:s3kr3t@host.invalid/store.git/': error 403",
            timedOut: false,
          })
        : defaultGitRunner(args, opts);

    const res = await pullRebase(paths, th.env, { run: leakyPull });
    expect(res.detail ?? '').not.toContain('s3kr3t');
  });
});

describe('sync: offline invocation is silent, fast, and never fatal (criterion 11)', () => {
  it('with no remote configured, a mutation commits locally and changes nothing else', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    await run(['init'], { env: th.env });

    const res = await run(['create', 'writing'], { env: th.env });
    expect(res.code).toBe(0);
    expect(res.stderr ?? '').toBe(''); // silent — no sync notices
    expect(subjects(paths.store)[0]).toBe('agentenv: create env writing');
    expect(await isPushQueued(paths)).toBe(false); // nothing queued when there is no remote
  });

  it('with an unreachable remote, a mutation still succeeds (never fatal) and queues the push', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    await run(['init'], { env: th.env });
    const remote = bareRemotePath(false); // never initialised → unreachable
    await run(['remote', remote.url], { env: th.env });

    const res = await run(['create', 'writing'], { env: th.env });
    expect(res.code).toBe(0);
    expect(subjects(paths.store)[0]).toBe('agentenv: create env writing');
    expect(await isPushQueued(paths)).toBe(true);
  });
});
