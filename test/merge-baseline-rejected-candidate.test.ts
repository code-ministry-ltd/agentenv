import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
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

describe('merge baseline — rejected candidate visibility', () => {
  it.fails('a rejected remote candidate remains visible to status on the next invocation', async () => {
    const th = makeTempHome({
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    });
    homes.push(th);
    const realRoot = join(th.home, 'fixture-real');
    const env = { ...th.env, [FIXTURE_CONFIG_ENV]: realRoot };
    const adapters = [makeFixtureAdapter()];

    await run(['init'], { env });
    await run(['create', 'work'], { env, adapters });
    await run(['add', 'skill', 'work', 'w-skill'], { env, adapters });
    const candidate = remoteWithRejectedChange();
    await run(['remote', candidate.remote], { env });
    candidate.pushRejectedChange();

    const rejected = await run(['use', 'work', '--global'], { env, adapters });
    expect(rejected.stderr ?? '').toMatch(/quarantined/i);

    const status = await run(['status'], { env, adapters });
    expect(`${status.stdout}\n${status.stderr ?? ''}`).toMatch(/rejected|quarantined|candidate/i);
  });
});
