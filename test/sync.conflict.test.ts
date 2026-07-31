import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { type ConflictedFile, isConflictPending } from '../src/git.js';
import { type Paths, resolvePaths } from '../src/paths.js';
import { makeTempHome, type TempHome } from './helpers.js';

/**
 * Task 2.2 — a REAL rebase conflict in the store, induced entirely offline: two
 * "machines" edit the same store file against a shared `file://` bare remote. The
 * conflicting pull is aborted (2.1) so the working tree stays usable; the conflict
 * halts SYNC only, never local function. Hermetic: temp AGENTENV_HOME, no network.
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

function writeInto(root: string, rel: string, contents: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, 'utf8');
}

function makeBareRemote(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentenv-remote-'));
  dirs.push(dir);
  const bare = join(dir, 'store.git');
  quietGit(['init', '--bare', '-b', 'main', bare]);
  return pathToFileURL(bare).href;
}

/** Another machine: clone the remote, mutate, commit, push. */
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

/** A local commit made WITHOUT pushing (simulating an offline/queued mutation). */
function localCommit(store: string, mutate: (root: string) => void, message: string): void {
  mutate(store);
  quietGit(['add', '-A'], store);
  quietGit(['commit', '-m', message, '--no-verify'], store);
}

const ENV_LOCAL = 'version: "1.0"\ndescription: local-change\nnotes: edited on this machine\n';
const ENV_REMOTE = 'version: "1.0"\ndescription: remote-change\nnotes: edited on the other machine\n';
const ENV_MERGED = 'version: "1.0"\ndescription: merged-change\nnotes: reconciled by hand\n';
const SKILL = (name: string): string => `---\nname: ${name}\ndescription: the ${name} skill\n---\n# ${name}\n`;

/** Commit subjects on the bare remote's main branch (works on a bare repo). */
function remoteSubjects(remoteUrl: string): string {
  return execFileSync('git', ['log', '--format=%s', 'main'], { cwd: new URL(remoteUrl).pathname, encoding: 'utf8' });
}

/** Every tracked path on the bare remote's main branch. */
function remoteTree(remoteUrl: string): string {
  return execFileSync('git', ['ls-tree', '-r', '--name-only', 'main'], {
    cwd: new URL(remoteUrl).pathname,
    encoding: 'utf8',
  });
}

/**
 * Drive two machines into a genuine rebase conflict on `environments/writing/env.yaml`,
 * each also making a NON-conflicting change (a distinct skill), and stop just before
 * the resolving sync. Returns paths + the remote URL. Leaves local HEAD diverged from
 * the remote, both having rewritten the same file.
 */
async function induceConflict(th: TempHome): Promise<{ paths: Paths; remote: string }> {
  const paths = resolvePaths(th.env);
  await run(['init'], { env: th.env });
  await run(['create', 'writing'], { env: th.env });
  const remote = makeBareRemote();
  await run(['remote', remote], { env: th.env }); // pushes the scaffold base

  // Remote machine: rewrite env.yaml + add a non-conflicting skill.
  otherMachinePushes(
    remote,
    (root) => {
      writeInto(root, 'environments/writing/env.yaml', ENV_REMOTE);
      writeInto(root, 'environments/writing/skills/remote-skill/SKILL.md', SKILL('remote-skill'));
    },
    'agentenv: remote edits writing',
  );

  // This machine: diverge on the SAME file (committed, not pushed) + a distinct skill.
  localCommit(
    paths.store,
    (root) => {
      writeInto(root, 'environments/writing/env.yaml', ENV_LOCAL);
      writeInto(root, 'environments/writing/skills/local-skill/SKILL.md', SKILL('local-skill'));
    },
    'agentenv: local edits writing',
  );

  return { paths, remote };
}

describe('sync: a real rebase conflict halts SYNC only, never local function (D9)', () => {
  it('the conflicting pull is aborted and `sync` reports blocked → `sync --resolve`', async () => {
    const th = gitHome();
    const { paths } = await induceConflict(th);

    const res = await run(['sync'], { env: th.env });
    expect(res.code).toBe(1);
    expect(res.stderr ?? '').toMatch(/blocked/i);
    expect(res.stderr ?? '').toContain('sync --resolve');

    // The rebase was aborted: the working tree is the LOCAL state, still usable.
    expect(readFileSync(join(paths.environments, 'writing', 'env.yaml'), 'utf8')).toContain('local-change');
    expect(existsSync(join(paths.environments, 'writing', 'skills', 'local-skill'))).toBe(true);
    // The remote's diverging change was NOT merged in (pull aborted).
    expect(existsSync(join(paths.environments, 'writing', 'skills', 'remote-skill'))).toBe(false);
    // A machine-local marker records the blocked state (never synced into the store).
    expect(await isConflictPending(paths)).toBe(true);
  });

  it('`status` surfaces the blocked sync and points at `sync --resolve`', async () => {
    const th = gitHome();
    await induceConflict(th);
    await run(['sync'], { env: th.env }); // sets the conflict marker

    const res = await run(['status'], { env: th.env });
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/BLOCKED by a rebase conflict/i);
    expect(res.stdout).toContain('sync --resolve');
  });

  it('use / drop / add / status all keep working (exit 0) from the working tree mid-conflict', async () => {
    const th = gitHome();
    const paths = (await induceConflict(th)).paths;
    await run(['sync'], { env: th.env }); // enter the blocked state

    // status — read-only, exit 0
    expect((await run(['status'], { env: th.env })).code).toBe(0);

    // add — mutates the store working tree, commits locally, push queues (remote ahead)
    const add = await run(['add', 'skill', 'writing', 'freshskill'], { env: th.env });
    expect(add.code).toBe(0);
    expect(existsSync(join(paths.environments, 'writing', 'skills', 'freshskill'))).toBe(true);

    // use — bind this shell (session mode), exit 0
    const sessionEnv = { ...th.env, AGENTENV_SESSION: 'sess-conflict' };
    const use = await run(['use', 'writing'], { env: sessionEnv, cwd: th.home });
    expect(use.code).toBe(0);

    // drop — unbind this shell, exit 0
    const drop = await run(['drop', 'writing'], { env: sessionEnv, cwd: th.home });
    expect(drop.code).toBe(0);

    // Still blocked, still working from the local tree.
    expect(await isConflictPending(paths)).toBe(true);
    expect(readFileSync(join(paths.environments, 'writing', 'env.yaml'), 'utf8')).toContain('local-change');
  });

  it('the blocked sync never force-pushes — the remote keeps only its own history', async () => {
    const th = gitHome();
    const { remote } = await induceConflict(th);
    await run(['sync'], { env: th.env });

    // The remote still has its own edit and never received the local (non-fast-forward) push.
    expect(remoteSubjects(remote)).toContain('agentenv: remote edits writing');
    expect(remoteSubjects(remote)).not.toContain('agentenv: local edits writing');
  });
});

describe('sync --resolve: the guided conflict walkthrough (D9, "never auto-resolve")', () => {
  it('drives the injected resolution, continues the rebase, and lands BOTH sides', async () => {
    const th = gitHome();
    const { paths, remote } = await induceConflict(th);

    // The injected "user resolved the files on disk" step: it MUST write the merged
    // content and return true. agentenv itself never merges.
    const seen: string[] = [];
    const resolveConflicts = async (files: readonly ConflictedFile[]): Promise<boolean> => {
      for (const f of files) {
        seen.push(f.path);
        writeFileSync(f.absPath, ENV_MERGED, 'utf8');
      }
      return true;
    };

    const res = await run(['sync', '--resolve'], { env: th.env, resolveConflicts });
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/resolved the conflict/i);
    // The seam was handed exactly the conflicted store file.
    expect(seen).toContain('environments/writing/env.yaml');

    // BOTH sides landed: the merged file + the local-only skill + the remote-only skill.
    expect(readFileSync(join(paths.environments, 'writing', 'env.yaml'), 'utf8')).toContain('merged-change');
    expect(existsSync(join(paths.environments, 'writing', 'skills', 'local-skill'))).toBe(true);
    expect(existsSync(join(paths.environments, 'writing', 'skills', 'remote-skill'))).toBe(true);

    // The conflict marker is cleared and the reconciled history is on the remote.
    expect(await isConflictPending(paths)).toBe(false);
    expect(remoteSubjects(remote)).toContain('agentenv: local edits writing');
    expect(remoteSubjects(remote)).toContain('agentenv: remote edits writing');
    expect(remoteTree(remote)).toContain('environments/writing/skills/local-skill/SKILL.md');

    // status is no longer blocked.
    expect((await run(['status'], { env: th.env })).stdout).not.toMatch(/BLOCKED by a rebase conflict/i);
  });

  it('never auto-resolves — with the resolver returning false it aborts and keeps local', async () => {
    const th = gitHome();
    const { paths } = await induceConflict(th);

    // The resolver declines (the human chose to cancel) → abort, keep local.
    const resolveConflicts = async (): Promise<boolean> => false;
    const res = await run(['sync', '--resolve'], { env: th.env, resolveConflicts });
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/cancelled/i);

    // Local content is intact; the remote's diverging change was NOT pulled in.
    expect(readFileSync(join(paths.environments, 'writing', 'env.yaml'), 'utf8')).toContain('local-change');
    expect(existsSync(join(paths.environments, 'writing', 'skills', 'local-skill'))).toBe(true);
    expect(existsSync(join(paths.environments, 'writing', 'skills', 'remote-skill'))).toBe(false);
    expect(await isConflictPending(paths)).toBe(false);
  });

  it('re-running --resolve before resolving is a safe no-op — never commits conflict markers', async () => {
    const th = gitHome();
    const { paths } = await induceConflict(th);
    const envFile = join(paths.environments, 'writing', 'env.yaml');

    // Enter the conflict (no resolver) → rebase held, markers written to disk.
    expect((await run(['sync', '--resolve'], { env: th.env })).code).toBe(1);
    expect(readFileSync(envFile, 'utf8')).toContain('<<<<<<<');

    // Re-run WITHOUT resolving: it must NOT stage+commit the marker-laden file. It
    // stays pending and re-lists the file; the markers are still on disk.
    const again = await run(['sync', '--resolve'], { env: th.env });
    expect(again.code).toBe(1);
    expect(again.stderr ?? '').toContain('environments/writing/env.yaml');
    expect(await isConflictPending(paths)).toBe(true);
    expect(readFileSync(envFile, 'utf8')).toContain('<<<<<<<');

    // Now actually resolve → completes cleanly with no markers anywhere.
    writeFileSync(envFile, ENV_MERGED, 'utf8');
    expect((await run(['sync', '--resolve'], { env: th.env })).code).toBe(0);
    expect(readFileSync(envFile, 'utf8')).toContain('merged-change');
    expect(readFileSync(envFile, 'utf8')).not.toContain('<<<<<<<');
  });

  it('with no resolver, the guided two-step (show files → edit on disk → re-run) completes', async () => {
    const th = gitHome();
    const { paths } = await induceConflict(th);

    // Step 1: enter the conflict, list the files, and stop (rebase held).
    const first = await run(['sync', '--resolve'], { env: th.env });
    expect(first.code).toBe(1);
    expect(first.stderr ?? '').toContain('environments/writing/env.yaml');
    expect(await isConflictPending(paths)).toBe(true);

    // The user resolves on disk (plain YAML) — no git commands.
    writeFileSync(join(paths.environments, 'writing', 'env.yaml'), ENV_MERGED, 'utf8');

    // Step 2: re-run → agentenv stages + continues the rebase to completion.
    const second = await run(['sync', '--resolve'], { env: th.env });
    expect(second.code).toBe(0);
    expect(second.stdout).toMatch(/resolved the conflict/i);
    expect(readFileSync(join(paths.environments, 'writing', 'env.yaml'), 'utf8')).toContain('merged-change');
    expect(existsSync(join(paths.environments, 'writing', 'skills', 'remote-skill'))).toBe(true);
    expect(await isConflictPending(paths)).toBe(false);
  });
});

describe('sync --abort: cancel a conflict resolution and keep local (D9)', () => {
  it('aborts an in-progress (manually-entered) rebase and leaves local content intact', async () => {
    const th = gitHome();
    const { paths } = await induceConflict(th);

    // Enter the conflict with no resolver → rebase is held in progress.
    const entered = await run(['sync', '--resolve'], { env: th.env });
    expect(entered.code).toBe(1);

    // Abort it.
    const res = await run(['sync', '--abort'], { env: th.env });
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/cancelled/i);

    // Local is exactly as it was; the remote change was not merged; status is clear.
    expect(readFileSync(join(paths.environments, 'writing', 'env.yaml'), 'utf8')).toContain('local-change');
    expect(existsSync(join(paths.environments, 'writing', 'skills', 'local-skill'))).toBe(true);
    expect(existsSync(join(paths.environments, 'writing', 'skills', 'remote-skill'))).toBe(false);
    expect(await isConflictPending(paths)).toBe(false);
    expect((await run(['status'], { env: th.env })).stdout).not.toMatch(/BLOCKED by a rebase conflict/i);
  });

  it('clears the blocked marker even when a prior sync already aborted the rebase', async () => {
    const th = gitHome();
    const { paths } = await induceConflict(th);
    await run(['sync'], { env: th.env }); // aborts the rebase, sets the marker
    expect(await isConflictPending(paths)).toBe(true);

    const res = await run(['sync', '--abort'], { env: th.env });
    expect(res.code).toBe(0);
    expect(await isConflictPending(paths)).toBe(false);
    expect(readFileSync(join(paths.environments, 'writing', 'env.yaml'), 'utf8')).toContain('local-change');
  });
});
