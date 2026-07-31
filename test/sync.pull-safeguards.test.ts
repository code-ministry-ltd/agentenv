import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { resolvePaths } from '../src/paths.js';
import { FIXTURE_CONFIG_ENV, makeFixtureAdapter } from './fixtures/fixture-adapter.js';
import { makeTempHome, type TempHome } from './helpers.js';

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

/** Run git quietly (git chatters progress to stderr; keep the test output clean). */
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

/** Simulate ANOTHER machine: clone the remote, mutate the store, commit, push. */
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

/** A hermetic fixture "real home" for the fixture harness, plus resolved paths. */
function localWithWork(th: TempHome) {
  const paths = resolvePaths(th.env);
  const realHome = join(th.home, 'real');
  mkdirSync(realHome, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...th.env, [FIXTURE_CONFIG_ENV]: realHome };
  return { paths, realHome, env };
}

function subjects(store: string): string[] {
  return execFileSync('git', ['log', '--format=%s'], { cwd: store, encoding: 'utf8' })
    .split('\n')
    .filter((l) => l.trim() !== '');
}

describe('sync: drift-sweep commit BEFORE the pull (D9)', () => {
  it('a write-through edit to a materialised skill is committed as `agentenv: sync drift`', async () => {
    const th = gitHome();
    const { paths, env } = localWithWork(th);
    const opts = { env, adapters: [makeFixtureAdapter()] };

    await run(['init'], { env: th.env });
    await run(['create', 'work'], opts);
    await run(['add', 'skill', 'work', 'w-skill'], opts);
    await run(['use', 'work', '--global'], opts);

    // Edit the skill through its MATERIALISED symlink → writes through to the store file.
    const realSkill = join(th.home, 'real', 'skills', 'w-skill', 'SKILL.md');
    expect(lstatSync(join(th.home, 'real', 'skills', 'w-skill')).isSymbolicLink()).toBe(true);
    writeFileSync(realSkill, '# w skill — edited mid-session\n');

    // The next store-touching command sweeps + commits that drift before doing its own work.
    await run(['create', 'other'], opts);
    const log = subjects(paths.store);
    expect(log).toContain('agentenv: sync drift');
    expect(log[0]).toBe('agentenv: create env other');
  });
});

describe('sync: post-pull safeguards quarantine a bad pulled tree (D9)', () => {
  it('a pulled fake TOKEN is reported and NOT materialised', async () => {
    const th = gitHome();
    const { realHome, env } = localWithWork(th);
    const opts = { env, adapters: [makeFixtureAdapter()] };

    await run(['init'], { env: th.env });
    await run(['create', 'work'], opts);
    await run(['add', 'skill', 'work', 'w-skill'], opts);
    const remote = makeBareRemote();
    await run(['remote', remote], { env: th.env });

    // Another machine pushes an env whose skill carries a real-looking token.
    otherMachinePushes(
      remote,
      (root) => {
        const dir = join(root, 'environments', 'evil', 'skills', 'x');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(root, 'environments', 'evil', 'env.yaml'), 'version: "1.0"\ndescription: evil\n');
        writeFileSync(join(dir, 'SKILL.md'), '---\nname: x\ndescription: x\n---\napi_key: AKIAIOSFODNN7EXAMPLE\n');
      },
      'add evil env with a token',
    );

    const res = await run(['use', 'work', '--global'], opts);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Did NOT materialise');
    expect(res.stderr ?? '').toMatch(/QUARANTINED/);
    // work was NOT materialised: no w-skill symlink appeared on real paths.
    expect(existsSync(join(realHome, 'skills', 'w-skill'))).toBe(false);
  });

  it('a pulled MALFORMED env.yaml is reported and NOT materialised', async () => {
    const th = gitHome();
    const { realHome, env } = localWithWork(th);
    const opts = { env, adapters: [makeFixtureAdapter()] };

    await run(['init'], { env: th.env });
    await run(['create', 'work'], opts);
    await run(['add', 'skill', 'work', 'w-skill'], opts);
    const remote = makeBareRemote();
    await run(['remote', remote], { env: th.env });

    otherMachinePushes(
      remote,
      (root) => {
        const dir = join(root, 'environments', 'broken');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'env.yaml'), 'this: : : is not: [valid yaml\n');
      },
      'add a malformed env',
    );

    const res = await run(['use', 'work', '--global'], opts);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Did NOT materialise');
    expect(res.stderr ?? '').toMatch(/QUARANTINED|malformed/i);
    expect(existsSync(join(realHome, 'skills', 'w-skill'))).toBe(false);
  });
});

describe('sync: manifest reconcile warns on a remotely-deleted active env (D9)', () => {
  it('an active env rm-ed on another machine warns and points at doctor', async () => {
    const th = gitHome();
    const { env } = localWithWork(th);
    const opts = { env, adapters: [makeFixtureAdapter()] };

    await run(['init'], { env: th.env });
    await run(['create', 'work'], opts);
    await run(['add', 'skill', 'work', 'w-skill'], opts);
    const remote = makeBareRemote();
    await run(['remote', remote], { env: th.env });
    await run(['use', 'work', '--global'], opts); // work is now active + materialised

    // Another machine deletes `work` from the store entirely.
    otherMachinePushes(
      remote,
      (root) => rmSync(join(root, 'environments', 'work'), { recursive: true, force: true }),
      'rm env work',
    );

    // The next invocation pulls the deletion and must warn (not silently dangle).
    const res = await run(['create', 'foo'], opts);
    expect(res.code).toBe(0);
    const notices = res.stderr ?? '';
    expect(notices).toContain("environment 'work'");
    expect(notices).toContain('doctor');
  });
});
