import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { defaultGitRunner, type GitRunner } from '../src/git.js';
import { resolvePaths } from '../src/paths.js';
import { makeTempHome, type TempHome } from './helpers.js';

/**
 * Task 2.3 — safe remote replacement classification (design D14, spec criterion 8).
 *
 * Hermetic: a temp AGENTENV_HOME + `file://` bare-repo fixtures, NO network. Every
 * assertion is a bare exit code / git-log fact.
 */

const homes: TempHome[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A hermetic home with git pinned to no global/system config. */
function gitHome(): TempHome {
  const th = makeTempHome({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' });
  homes.push(th);
  return th;
}

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@agentenv.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@agentenv.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function g(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

/** A scratch dir that is cleaned up after the test. */
function scratch(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `agentenv-${prefix}-`));
  dirs.push(d);
  return d;
}

/** An EMPTY bare repo (init --bare, no commits) + its file:// URL. */
function emptyBare(): { dir: string; url: string } {
  const dir = join(scratch('bare-empty'), 'store.git');
  execFileSync('git', ['init', '--bare', '-b', 'main', dir], { encoding: 'utf8' });
  return { dir, url: pathToFileURL(dir).href };
}

/** Commit subjects of a repo's HEAD history (bare or working). */
function subjects(dir: string): string[] {
  return execFileSync('git', ['log', '--format=%s'], { cwd: dir, encoding: 'utf8' })
    .split('\n')
    .filter((l) => l.trim() !== '');
}

/** The configured origin URL of the local store (or '' when none). */
function originUrl(storeDir: string): string {
  try {
    return g(storeDir, 'remote', 'get-url', 'origin');
  } catch {
    return '';
  }
}

/**
 * Record every `git` argv the command runs, so a test can prove NO force-push and
 * NO unrelated-history auto-merge ever happen.
 */
function recordingRunner(): { run: GitRunner; calls: () => string[][] } {
  const calls: string[][] = [];
  const run: GitRunner = (args, opts) => {
    calls.push([...args]);
    return defaultGitRunner(args, opts);
  };
  return { run, calls: () => calls };
}

function assertNoForcePush(calls: string[][]): void {
  for (const argv of calls) {
    if (argv[0] !== 'push') continue;
    expect(argv).not.toContain('--force');
    expect(argv).not.toContain('-f');
    expect(argv).not.toContain('--force-with-lease');
    for (const a of argv) expect(a.startsWith('+')).toBe(false); // no `+refspec` force
  }
}

describe('remote 2.3: same normalised URL → idempotent no-op + sync', () => {
  it('a re-point at the already-configured URL changes nothing and syncs (exit 0)', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    const remote = emptyBare();
    await run(['init'], { env: th.env });
    await run(['remote', remote.url], { env: th.env });

    const before = originUrl(paths.store);
    const res = await run(['remote', `${remote.url}/`], { env: th.env }); // trailing slash → same
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('no change');
    expect(originUrl(paths.store)).toBe(before); // url unchanged
  });
});

describe('remote 2.3: EMPTY candidate → non-force push, URL flips only after push', () => {
  it('replaces an old remote with an empty one: local history received, url flipped', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    const oldRemote = emptyBare();
    await run(['init'], { env: th.env });
    await run(['remote', oldRemote.url], { env: th.env });
    // Give the local store an extra commit so there is real history to receive.
    await run(['create', 'writing'], { env: th.env });

    const newRemote = emptyBare();
    const rec = recordingRunner();
    const res = await run(['remote', newRemote.url], { env: th.env, gitRun: rec.run });
    expect(res.code).toBe(0);

    // URL flipped to the new (empty) remote.
    expect(originUrl(paths.store)).toBe(newRemote.url);
    // The new remote received the FULL local history via a non-force push.
    expect(subjects(newRemote.dir)).toEqual(subjects(paths.store));
    assertNoForcePush(rec.calls());
  });

  it('a push failure leaves the OLD url configured and the local content intact', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    const oldRemote = emptyBare();
    await run(['init'], { env: th.env });
    await run(['remote', oldRemote.url], { env: th.env });
    const localBefore = subjects(paths.store);

    const newRemote = emptyBare();
    // Fail the push to the candidate (classification ls-remote/fetch still succeed).
    const failPush: GitRunner = (args, opts) =>
      args[0] === 'push' && args.includes(newRemote.url)
        ? Promise.resolve({ code: 1, stdout: '', stderr: 'simulated push failure', timedOut: false })
        : defaultGitRunner(args, opts);

    const res = await run(['remote', newRemote.url], { env: th.env, gitRun: failPush });
    expect(res.code).not.toBe(0);
    expect(originUrl(paths.store)).toBe(oldRemote.url); // OLD url intact
    expect(subjects(paths.store)).toEqual(localBefore); // local content intact
  });
});

describe('remote 2.3: first-connect to an empty remote still works (2.1 behaviour preserved)', () => {
  it('connects an empty remote and pushes local history', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    const remote = emptyBare();
    await run(['init'], { env: th.env });
    const res = await run(['remote', remote.url], { env: th.env });
    expect(res.code).toBe(0);
    expect(originUrl(paths.store)).toBe(remote.url);
    expect(subjects(remote.dir)).toContain('agentenv: initialise store');
  });
});
