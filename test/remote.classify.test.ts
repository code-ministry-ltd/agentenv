import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { archivesDir, defaultGitRunner, type GitRunner } from '../src/git.js';
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

/**
 * A bare repo that SHARES the local store's history (its baseline commit) and adds a
 * divergent commit on top — the "related" fixture. Cloned from the local store as it
 * stands, then given a commit the local store does not have.
 */
function relatedBare(storeDir: string, divergentFile = 'REMOTE.md', divergentBody = 'remote\n'): { dir: string; url: string } {
  const bare = join(scratch('bare-related'), 'store.git');
  execFileSync('git', ['init', '--bare', '-b', 'main', bare], { encoding: 'utf8' });
  const wc = scratch('wc-related');
  execFileSync('git', ['clone', storeDir, wc], { env: GIT_ENV });
  writeFileSync(join(wc, divergentFile), divergentBody, 'utf8');
  g(wc, 'add', '-A');
  g(wc, 'commit', '-m', 'remote-divergent');
  g(wc, 'push', bare, 'main');
  return { dir: bare, url: pathToFileURL(bare).href };
}

/**
 * A bare repo with a wholly UNRELATED history — its own root commit, NO shared
 * ancestor with the local store — the "unrelated" fixture.
 */
function unrelatedBare(): { dir: string; url: string } {
  const bare = join(scratch('bare-unrelated'), 'store.git');
  execFileSync('git', ['init', '--bare', '-b', 'main', bare], { encoding: 'utf8' });
  const wc = scratch('wc-unrelated');
  execFileSync('git', ['init', '-b', 'main', wc], { env: GIT_ENV });
  writeFileSync(join(wc, 'UNRELATED.md'), 'unrelated\n', 'utf8');
  g(wc, 'add', '-A');
  g(wc, 'commit', '-m', 'unrelated-root');
  g(wc, 'push', bare, 'main');
  return { dir: bare, url: pathToFileURL(bare).href };
}

/** A path where a bare repo WOULD live but does NOT (an unreachable file:// URL). */
function missingBare(): { dir: string; url: string } {
  const dir = join(scratch('bare-missing'), 'store.git');
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

function assertNoUnrelatedMerge(calls: string[][]): void {
  for (const argv of calls) {
    expect(argv).not.toContain('--allow-unrelated-histories');
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

describe('remote 2.3: RELATED candidate → integrate then adopt', () => {
  it('integrates a related history and adopts it: both histories present, no force-push', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    const oldRemote = emptyBare();
    await run(['init'], { env: th.env });
    await run(['remote', oldRemote.url], { env: th.env });

    // A related bare that shares the baseline and adds a divergent commit.
    const related = relatedBare(paths.store);
    // A LOCAL-only commit the related remote does not have → genuine divergence.
    await run(['create', 'writing'], { env: th.env });

    const rec = recordingRunner();
    const res = await run(['remote', related.url], { env: th.env, gitRun: rec.run });
    expect(res.code).toBe(0);
    expect(originUrl(paths.store)).toBe(related.url); // adopted

    // Both histories are present locally AND on the adopted remote.
    const local = subjects(paths.store);
    expect(local).toContain('agentenv: initialise store'); // shared baseline
    expect(local).toContain('remote-divergent'); // remote's commit
    expect(local).toContain('agentenv: create env writing'); // local commit
    expect(subjects(related.dir)).toEqual(local); // remote received the reconciled history

    assertNoForcePush(rec.calls());
    assertNoUnrelatedMerge(rec.calls());
  });

  it('a conflict is aborted: OLD url stays and local content is intact', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    const oldRemote = emptyBare();
    await run(['init'], { env: th.env });
    await run(['remote', oldRemote.url], { env: th.env });

    // Related remote whose divergent commit edits .gitignore.
    const related = relatedBare(paths.store, '.gitignore', 'remote-conflicting-line\n');
    // Local edits the SAME file differently (as uncommitted drift the command flushes).
    writeFileSync(join(paths.store, '.gitignore'), 'local-conflicting-line\n', 'utf8');

    const rec = recordingRunner();
    const res = await run(['remote', related.url], { env: th.env, gitRun: rec.run });
    expect(res.code).not.toBe(0); // refused
    expect(res.stderr).toMatch(/conflict/i);
    expect(originUrl(paths.store)).toBe(oldRemote.url); // OLD url intact

    // The local drift was flushed to a commit and survives (content intact/recoverable).
    expect(execFileSync('git', ['show', 'HEAD:.gitignore'], { cwd: paths.store, encoding: 'utf8' })).toContain(
      'local-conflicting-line',
    );
    assertNoForcePush(rec.calls());
    assertNoUnrelatedMerge(rec.calls());
  });

  it('a fetch failure during classification leaves the OLD remote unchanged', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    const oldRemote = emptyBare();
    await run(['init'], { env: th.env });
    await run(['remote', oldRemote.url], { env: th.env });
    const localBefore = subjects(paths.store);

    const related = relatedBare(paths.store);
    const failFetch: GitRunner = (args, opts) =>
      args[0] === 'fetch'
        ? Promise.resolve({ code: 1, stdout: '', stderr: 'simulated fetch failure', timedOut: false })
        : defaultGitRunner(args, opts);

    const res = await run(['remote', related.url], { env: th.env, gitRun: failFetch });
    expect(res.code).not.toBe(0);
    expect(originUrl(paths.store)).toBe(oldRemote.url); // unchanged
    expect(subjects(paths.store)).toEqual(localBefore); // local intact
  });
});

describe('remote 2.3: UNRELATED candidate → refuse / cancel / archive-and-adopt', () => {
  /** Set up a local store with an old remote, a distinctive local commit, and an
   *  unrelated candidate. Returns the pieces every unrelated test needs. */
  async function setup(): Promise<{
    th: TempHome;
    paths: ReturnType<typeof resolvePaths>;
    oldRemote: { dir: string; url: string };
    unrelated: { dir: string; url: string };
  }> {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    const oldRemote = emptyBare();
    await run(['init'], { env: th.env });
    await run(['remote', oldRemote.url], { env: th.env });
    await run(['create', 'writing'], { env: th.env }); // a distinctive local commit
    const unrelated = unrelatedBare();
    return { th, paths, oldRemote, unrelated };
  }

  it('a non-interactive invocation safely refuses by default (nothing changed)', async () => {
    const { th, paths, oldRemote, unrelated } = await setup();
    const localBefore = subjects(paths.store);

    const res = await run(['remote', unrelated.url], { env: th.env });
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/cancel/i);
    expect(originUrl(paths.store)).toBe(oldRemote.url); // unchanged
    expect(subjects(paths.store)).toEqual(localBefore); // intact
  });

  it('interactive DEFAULT is cancel (nothing changed)', async () => {
    const { th, paths, oldRemote, unrelated } = await setup();
    const localBefore = subjects(paths.store);

    const res = await run(['remote', unrelated.url], {
      env: th.env,
      confirm: async () => false, // the user declines → cancel (the default)
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/cancel/i);
    expect(originUrl(paths.store)).toBe(oldRemote.url); // unchanged
    expect(subjects(paths.store)).toEqual(localBefore); // intact
  });

  it('explicit archive-and-adopt: local archived (recoverable) then unrelated remote adopted', async () => {
    const { th, paths, unrelated } = await setup();
    const localBefore = subjects(paths.store);
    expect(localBefore).toContain('agentenv: create env writing');

    const rec = recordingRunner();
    const res = await run(['remote', unrelated.url], {
      env: th.env,
      gitRun: rec.run,
      confirm: async () => true, // explicit archive-and-adopt
    });
    expect(res.code).toBe(0);

    // The remote was adopted wholesale: url flipped, local history == the remote's.
    expect(originUrl(paths.store)).toBe(unrelated.url);
    expect(subjects(paths.store)).toEqual(['unrelated-root']);
    expect(existsSync(join(paths.store, 'UNRELATED.md'))).toBe(true);

    // The previous local store is RECOVERABLE from the archive (its history survives).
    const archived = archiveDirEntries(paths);
    expect(archived.length).toBe(1);
    expect(subjects(archived[0]!)).toEqual(localBefore); // full original history

    // No force-push, and NO auto-merge of unrelated histories anywhere.
    assertNoForcePush(rec.calls());
    assertNoUnrelatedMerge(rec.calls());
    for (const argv of rec.calls()) expect(argv[0]).not.toBe('merge');
  });

  it('an archive failure leaves the OLD remote configured and local content intact', async () => {
    const { th, paths, oldRemote, unrelated } = await setup();
    const localBefore = subjects(paths.store);

    // Block the archive: a regular FILE where the archives directory must be created.
    writeFileSync(archivesDir(paths), 'not a directory\n', 'utf8');

    const res = await run(['remote', unrelated.url], {
      env: th.env,
      confirm: async () => true, // user opted to archive-and-adopt, but archiving fails
    });
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/archive/i);
    expect(originUrl(paths.store)).toBe(oldRemote.url); // OLD url intact
    expect(subjects(paths.store)).toEqual(localBefore); // local intact
    expect(existsSync(join(paths.store, 'UNRELATED.md'))).toBe(false); // remote NOT adopted
  });
});

describe('remote 2.3: UNREACHABLE candidate + the fault-injection matrix', () => {
  it('an unreachable candidate on REPLACEMENT changes nothing (old remote survives)', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    const oldRemote = emptyBare();
    await run(['init'], { env: th.env });
    await run(['remote', oldRemote.url], { env: th.env });
    const localBefore = subjects(paths.store);

    const gone = missingBare(); // a file:// URL with no repo behind it
    const res = await run(['remote', gone.url], { env: th.env });
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/unreachable/i);
    expect(originUrl(paths.store)).toBe(oldRemote.url); // OLD url intact
    expect(subjects(paths.store)).toEqual(localBefore); // local intact
  });

  it('a probe (ls-remote) failure leaves the OLD remote configured and local intact', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    const oldRemote = emptyBare();
    await run(['init'], { env: th.env });
    await run(['remote', oldRemote.url], { env: th.env });
    const localBefore = subjects(paths.store);

    const candidate = emptyBare();
    const failProbe: GitRunner = (args, opts) =>
      args[0] === 'ls-remote' && args.includes(candidate.url)
        ? Promise.resolve({ code: 1, stdout: '', stderr: 'simulated ls-remote failure', timedOut: false })
        : defaultGitRunner(args, opts);

    const res = await run(['remote', candidate.url], { env: th.env, gitRun: failProbe });
    expect(res.code).not.toBe(0);
    expect(originUrl(paths.store)).toBe(oldRemote.url); // unchanged
    expect(subjects(paths.store)).toEqual(localBefore); // intact
  });

  it('a push failure while integrating a related remote rolls local back (transactional)', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    const oldRemote = emptyBare();
    await run(['init'], { env: th.env });
    await run(['remote', oldRemote.url], { env: th.env });
    const related = relatedBare(paths.store);
    await run(['create', 'writing'], { env: th.env }); // local-only commit
    const localBefore = subjects(paths.store);

    const failPush: GitRunner = (args, opts) =>
      args[0] === 'push' && args.includes(related.url)
        ? Promise.resolve({ code: 1, stdout: '', stderr: 'simulated push failure', timedOut: false })
        : defaultGitRunner(args, opts);

    const res = await run(['remote', related.url], { env: th.env, gitRun: failPush });
    expect(res.code).not.toBe(0);
    expect(originUrl(paths.store)).toBe(oldRemote.url); // OLD url intact
    // The integrate was rolled back exactly: the remote's commit is NOT present locally.
    expect(subjects(paths.store)).toEqual(localBefore);
    expect(subjects(paths.store)).not.toContain('remote-divergent');
  });
});

/** The store archives that exist under ~/.agentenv/archives (each a recoverable copy). */
function archiveDirEntries(paths: ReturnType<typeof resolvePaths>): string[] {
  const dir = archivesDir(paths);
  if (!existsSync(dir)) return [];
  return execFileSync('ls', ['-1', dir], { encoding: 'utf8' })
    .split('\n')
    .filter((n) => n.trim() !== '')
    .map((n) => join(dir, n.trim()));
}
