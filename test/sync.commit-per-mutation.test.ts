import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { commitStore } from '../src/git.js';
import { resolvePaths } from '../src/paths.js';
import { makeFixtureRepo, makeTempHome, type FixtureRepo, type TempHome } from './helpers.js';

/** A temp home whose git commands never read the dev machine's global config. */
function gitHome(): TempHome {
  const th = makeTempHome({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' });
  homes.push(th);
  return th;
}

const homes: TempHome[] = [];
const repos: FixtureRepo[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
  for (const r of repos.splice(0)) r.cleanup();
});

/** The subject lines of the store's git history, newest first. */
function subjects(store: string): string[] {
  return execFileSync('git', ['log', '--format=%s'], { cwd: store, encoding: 'utf8' })
    .split('\n')
    .filter((l) => l.trim() !== '');
}

describe('sync: commit-per-mutation (D9)', () => {
  it('create / add / edit / rm each auto-commit with a descriptive message', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    await run(['init'], { env: th.env });

    await run(['create', 'writing'], { env: th.env });
    expect(subjects(paths.store)[0]).toBe('agentenv: create env writing');

    await run(['add', 'skill', 'writing', 'sharpen-prose'], { env: th.env });
    expect(subjects(paths.store)[0]).toBe('agentenv: add skill sharpen-prose → writing');

    await run(['add', 'mcp', 'writing', 'linear'], { env: th.env });
    expect(subjects(paths.store)[0]).toBe('agentenv: add mcp linear → writing');

    // edit: an injected editor writes a new description; the change is committed.
    const editEnv = { ...th.env, EDITOR: 'fake-editor' };
    await run(['edit', 'writing'], {
      env: editEnv,
      launchEditor: async (_cmd, args) => {
        writeFileSync(args[args.length - 1]!, 'version: "1.0"\ndescription: sharper writing\n');
        return 0;
      },
    });
    expect(subjects(paths.store)[0]).toBe('agentenv: edit env writing');

    await run(['rm', 'writing', '--yes'], { env: th.env });
    expect(subjects(paths.store)[0]).toBe('agentenv: remove env writing');
  });

  it('--print-path adds nothing and creates no commit', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    await run(['init'], { env: th.env });
    await run(['create', 'writing'], { env: th.env });
    const before = subjects(paths.store).length;

    const res = await run(['add', 'skill', 'writing', 'foo', '--print-path'], { env: th.env });
    expect(res.code).toBe(0);
    expect(subjects(paths.store).length).toBe(before); // no mutation ⇒ no commit
  });

  it('a batch `add skills --all` yields one commit per installed skill', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    await run(['init'], { env: th.env });
    await run(['create', 'writing'], { env: th.env });

    const repo = makeFixtureRepo();
    repos.push(repo);
    repo.writeSkill('skills/alpha');
    repo.writeSkill('skills/beta');
    repo.writeSkill('skills/gamma');
    repo.commit('init');

    const before = subjects(paths.store).length;
    const res = await run(['add', 'skills', 'writing', repo.fileUrl('skills'), '--all'], { env: th.env });
    expect(res.code).toBe(0);
    const after = subjects(paths.store);
    expect(after.length - before).toBe(3); // three skills ⇒ three commits
    expect(after.slice(0, 3).sort()).toEqual([
      'agentenv: add skill alpha → writing',
      'agentenv: add skill beta → writing',
      'agentenv: add skill gamma → writing',
    ]);
  });
});

describe('sync: pre-commit secret scan BLOCKS a leak (D6/D9)', () => {
  it('refuses to commit a store tree containing a token, and reports it', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    await run(['init'], { env: th.env });
    await run(['create', 'writing'], { env: th.env });
    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: paths.store, encoding: 'utf8' }).trim();

    // Simulate an editor baking a real token into a store file.
    writeFileSync(join(paths.envDir('writing'), 'leaked.txt'), 'api_key: AKIAIOSFODNN7EXAMPLE\n');
    const result = await commitStore(paths, th.env, 'agentenv: should be blocked');
    expect(result.status).toBe('blocked');
    expect(result.findings?.length).toBeGreaterThan(0);

    // Nothing committed — HEAD is unchanged and the leak stays out of history.
    const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: paths.store, encoding: 'utf8' }).trim();
    expect(headAfter).toBe(headBefore);
  });
});
