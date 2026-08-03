import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { resolvePaths } from '../src/paths.js';
import { readState, writeState } from '../src/state.js';
import { createViewGeneration, publishGeneration } from '../src/view-generation.js';
import { FIXTURE_CONFIG_ENV, makeFixtureAdapter } from './fixtures/fixture-adapter.js';
import { makeTempHome, type TempHome } from './helpers.js';

const homes: TempHome[] = [];
const dirs: string[] = [];
const gitEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'candidate-test',
  GIT_AUTHOR_EMAIL: 'candidate@test.invalid',
  GIT_COMMITTER_NAME: 'candidate-test',
  GIT_COMMITTER_EMAIL: 'candidate@test.invalid',
};

afterEach(() => {
  for (const value of homes.splice(0)) value.cleanup();
  for (const value of dirs.splice(0)) rmSync(value, { recursive: true, force: true });
});

function git(args: string[], cwd?: string): void {
  execFileSync('git', args, { ...(cwd ? { cwd } : {}), env: gitEnv, stdio: 'ignore' });
}

function remoteWithRejectedChange(): { remote: string; pushRejectedChange: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'agentenv-candidate-'));
  dirs.push(root);
  const bare = join(root, 'store.git');
  git(['init', '--bare', '-b', 'main', bare]);

  return {
    remote: pathToFileURL(bare).href,
    pushRejectedChange: () => {
      const clone = join(root, 'other');
      git(['clone', pathToFileURL(bare).href, clone]);
      const broken = join(clone, 'environments', 'broken');
      mkdirSync(broken, { recursive: true });
      writeFileSync(join(broken, 'env.yaml'), 'this: : : is not: [valid yaml\n');
      git(['add', '-A'], clone);
      git(['commit', '-m', 'add rejected candidate', '--no-verify'], clone);
      git(['push', 'origin', 'main'], clone);
    },
  };
}

function remoteWithValidChange(): { remote: string; pushValidChange: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'agentenv-candidate-valid-'));
  dirs.push(root);
  const bare = join(root, 'store.git');
  git(['init', '--bare', '-b', 'main', bare]);

  return {
    remote: pathToFileURL(bare).href,
    pushValidChange: () => {
      const clone = join(root, 'other');
      git(['clone', pathToFileURL(bare).href, clone]);
      const added = join(clone, 'environments', 'remote-env');
      mkdirSync(added, { recursive: true });
      writeFileSync(
        join(added, 'env.yaml'),
        'version: "1.0"\ndescription: valid remote environment\n',
      );
      git(['add', '-A'], clone);
      git(['commit', '-m', 'add valid candidate', '--no-verify'], clone);
      git(['push', 'origin', 'main'], clone);
    },
  };
}

describe('merge baseline — rejected candidate visibility', () => {
  it('a rejected remote candidate remains isolated and visible to status on the next invocation', async () => {
    const th = makeTempHome({
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    });
    homes.push(th);
    const realRoot = join(th.home, 'fixture-real');
    const env = { ...th.env, [FIXTURE_CONFIG_ENV]: realRoot };
    const adapters = [makeFixtureAdapter()];
    const paths = resolvePaths(env);

    await run(['init'], { env });
    await run(['create', 'work'], { env, adapters });
    await run(['add', 'skill', 'work', 'w-skill'], { env, adapters });
    const candidate = remoteWithRejectedChange();
    await run(['remote', candidate.remote], { env });
    candidate.pushRejectedChange();

    const rejected = await run(['use', 'work', '--global'], { env, adapters });
    expect(rejected.stderr ?? '').toMatch(/quarantined/i);
    expect(() => readFileSync(join(paths.envDir('broken'), 'env.yaml'), 'utf8')).toThrow();
    expect((await readState(paths)).candidates).toContainEqual(
      expect.objectContaining({ phase: 'rejected', reason: expect.any(String) }),
    );

    const status = await run(['status'], { env, adapters });
    expect(`${status.stdout}\n${status.stderr ?? ''}`).toMatch(/rejected|quarantined|candidate/i);
  });

  it('defers a valid candidate while a retained generation can still write', async () => {
    const th = makeTempHome({
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    });
    homes.push(th);
    const env = { ...th.env, [FIXTURE_CONFIG_ENV]: join(th.home, 'fixture-real') };
    const adapters = [makeFixtureAdapter()];
    const paths = resolvePaths(env);

    await run(['init'], { env });
    await run(['create', 'work'], { env, adapters });
    const remote = remoteWithValidChange();
    await run(['remote', remote.remote], { env });

    const state = await readState(paths);
    state.generations.push(publishGeneration(createViewGeneration('live-generation', ['work'])));
    await writeState(paths, state);
    remote.pushValidChange();

    const result = await run(['use', 'work', '--global'], { env, adapters });
    expect(result.stderr ?? '').toMatch(/DEFERRED/);
    expect(() => readFileSync(join(paths.envDir('remote-env'), 'env.yaml'), 'utf8')).toThrow();
    expect((await readState(paths)).candidates).toContainEqual(
      expect.objectContaining({
        phase: 'deferred',
        blockers: ['generation:live-generation'],
      }),
    );
  });
});
