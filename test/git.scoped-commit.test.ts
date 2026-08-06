import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { commitStorePaths } from '../src/git.js';
import { resolvePaths } from '../src/paths.js';
import { makeTempHome, type TempHome } from './helpers.js';

const homes: TempHome[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) home.cleanup();
});

describe('path-scoped durable Git bookkeeping', () => {
  it('commits only declared store paths and is idempotent on retry', async () => {
    const home = makeTempHome({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' });
    homes.push(home);
    const paths = resolvePaths(home.env);
    await run(['init'], { env: home.env });
    const intended = join(paths.store, 'environments', 'work', 'env.yaml');
    const unrelated = join(paths.store, 'unrelated.md');
    mkdirSync(dirname(intended), { recursive: true });
    writeFileSync(intended, 'version: "1.0"\ndescription: work\n');
    writeFileSync(unrelated, 'leave me dirty\n');

    const committed = await commitStorePaths(
      paths,
      home.env,
      'agentenv: create env work',
      [intended],
    );
    expect(committed.status).toBe('committed');
    const names = execFileSync('git', ['show', '--format=', '--name-only', 'HEAD'], {
      cwd: paths.store,
      encoding: 'utf8',
    });
    expect(names).toContain('environments/work/env.yaml');
    expect(names).not.toContain('unrelated.md');
    expect(execFileSync('git', ['status', '--short'], { cwd: paths.store, encoding: 'utf8' }))
      .toContain('?? unrelated.md');

    const retried = await commitStorePaths(
      paths,
      home.env,
      'agentenv: create env work',
      [intended],
    );
    expect(retried.status).toBe('nothing');
  });

  it('rejects a declared path outside the store before touching the index', async () => {
    const home = makeTempHome({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' });
    homes.push(home);
    const paths = resolvePaths(home.env);
    await run(['init'], { env: home.env });
    await expect(
      commitStorePaths(paths, home.env, 'bad', [join(home.home, 'outside')]),
    ).rejects.toThrow(/outside.*store/i);
  });
});
