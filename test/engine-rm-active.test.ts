import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { resolvePaths } from '../src/paths.js';
import { readState, writeState } from '../src/state.js';
import {
  findBinding,
  readSessionRegistry,
  resolveProjectRoot,
} from '../src/session/registry.js';
import { FIXTURE_CONFIG_ENV, makeFixtureAdapter } from './fixtures/fixture-adapter.js';
import { makeTempHome, type TempHome } from './helpers.js';

const homes: TempHome[] = [];
function home(): TempHome {
  const h = makeTempHome();
  homes.push(h);
  return h;
}
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
});

describe('engine: rm active-env refusal', () => {
  it('requires an env bound in a session to be explicitly dropped first', async () => {
    const th = home();
    await run(['create', 'writing'], { env: th.env });
    const env = { ...th.env, AGENTENV_SESSION: 'S1' };
    await run(['use', 'writing'], { env, cwd: th.home });

    const refused = await run(['rm', 'writing'], { env, cwd: th.home });
    expect(refused.code).toBe(1);
    expect(refused.stderr?.toLowerCase()).toContain('active');
    expect(refused.stderr).toContain('deactivate it first');
    expect(existsSync(resolvePaths(th.env).envDir('writing'))).toBe(true);

    expect((await run(['drop'], { env, cwd: th.home })).code).toBe(0);
    const removed = await run(['rm', 'writing'], { env, cwd: th.home, confirm: async () => true });
    expect(removed.code).toBe(0);
    expect(existsSync(resolvePaths(th.env).envDir('writing'))).toBe(false);

    const projectRoot = await resolveProjectRoot(th.home);
    const paths = resolvePaths(th.env);
    expect(findBinding(await readSessionRegistry(paths), 'S1', projectRoot)).toBeUndefined();
  });

  it('requires an env active in the global stack to be explicitly dropped first', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const realHome = join(th.home, 'real');
    mkdirSync(realHome, { recursive: true });
    mkdirSync(join(paths.envDir('writing'), 'skills', 'w-skill'), { recursive: true });
    writeFileSync(join(paths.envDir('writing'), 'skills', 'w-skill', 'SKILL.md'), '# w\n');
    writeFileSync(paths.envYaml('writing'), 'version: "1.0"\ndescription: ""\n');
    const env: NodeJS.ProcessEnv = { ...th.env, [FIXTURE_CONFIG_ENV]: realHome };
    const opts = { env, adapters: [makeFixtureAdapter()] };
    await run(['use', 'writing', '--global'], opts);

    const refused = await run(['rm', 'writing'], opts);
    expect(refused.code).toBe(1);
    expect(refused.stderr?.toLowerCase()).toContain('active');
    expect(existsSync(paths.envDir('writing'))).toBe(true);

    expect((await run(['drop', '--global'], opts)).code).toBe(0);
    const removed = await run(['rm', 'writing'], { ...opts, confirm: async () => true });
    expect(removed.code).toBe(0);
    expect(existsSync(paths.envDir('writing'))).toBe(false);
    // Global materialisation was dropped: no owned items, empty stack, real home clean.
    const manifest = await readState(paths);
    expect(manifest.items).toEqual([]);
    expect(manifest.globalStack).toEqual([]);
    expect(readdirSync(join(realHome, 'skills'))).not.toContain('w-skill');
  });

  it('distinguishes materialised-only ownership from global-stack membership in the refusal (Finding 3)', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const realHome = join(th.home, 'real');
    mkdirSync(realHome, { recursive: true });
    mkdirSync(join(paths.envDir('writing'), 'skills', 'w-skill'), { recursive: true });
    writeFileSync(join(paths.envDir('writing'), 'skills', 'w-skill', 'SKILL.md'), '# w\n');
    writeFileSync(paths.envYaml('writing'), 'version: "1.0"\ndescription: ""\n');
    const env: NodeJS.ProcessEnv = { ...th.env, [FIXTURE_CONFIG_ENV]: realHome };
    const opts = { env, adapters: [makeFixtureAdapter()] };
    await run(['use', 'writing', '--global'], opts);

    // Orphan (Finding 1 shape): items committed, the stack write lost — so the env
    // is materialised but NOT in the global stack.
    const manifest = await readState(paths);
    (manifest as { globalStack?: string[] }).globalStack = [];
    await writeState(paths, manifest);

    const refused = await run(['rm', 'writing'], opts);
    expect(refused.code).toBe(1);
    expect(refused.stderr?.toLowerCase()).toContain('materialised');
    expect(refused.stderr).not.toContain('the global stack'); // not stacked → not that label

    // An env-less global drop removes orphaned ownership before explicit removal.
    expect((await run(['drop', '--global'], opts)).code).toBe(0);
    const removed = await run(['rm', 'writing'], { ...opts, confirm: async () => true });
    expect(removed.code).toBe(0);
    expect(existsSync(paths.envDir('writing'))).toBe(false);
  });

  it('removes an inactive env after confirmation', async () => {
    const th = home();
    await run(['create', 'writing'], { env: th.env });
    const res = await run(['rm', 'writing'], { env: th.env, confirm: async () => true });
    expect(res.code).toBe(0);
    expect(existsSync(resolvePaths(th.env).envDir('writing'))).toBe(false);
  });
});
