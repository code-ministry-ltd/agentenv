import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { isConflictPending } from '../src/git.js';
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
const SKILL = (name: string): string => `---\nname: ${name}\ndescription: the ${name} skill\n---\n# ${name}\n`;

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
    const bareDir = new URL(remote).pathname;
    const remoteSubjects = execFileSync('git', ['log', '--format=%s', 'main'], { cwd: bareDir, encoding: 'utf8' });
    expect(remoteSubjects).toContain('agentenv: remote edits writing');
    expect(remoteSubjects).not.toContain('agentenv: local edits writing');
  });
});
