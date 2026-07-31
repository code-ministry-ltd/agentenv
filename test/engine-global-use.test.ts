import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { resolvePaths } from '../src/paths.js';
import { readState } from '../src/state.js';
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

/**
 * A hermetic "real home" for the fixture harness plus an env stack in the store.
 * Seeds pre-existing USER content in every surface so the round-trip guarantee is
 * exercised (user content must survive materialise + dematerialise byte-for-byte).
 */
function scenario(th: TempHome, envName = 'writing') {
  const paths = resolvePaths(th.env);
  const realHome = join(th.home, 'real');
  mkdirSync(join(realHome, 'skills', 'user-skill'), { recursive: true });
  writeFileSync(join(realHome, 'skills', 'user-skill', 'SKILL.md'), '# user skill\n');
  writeFileSync(join(realHome, 'INSTRUCTIONS.md'), '# user instructions\n\nkeep me.\n');
  writeFileSync(join(realHome, 'config.json'), '{\n  "mcpServers": {\n    "user-server": { "url": "u" }\n  }\n}\n');
  writeFileSync(join(realHome, 'auth.json'), '{"token":"secret-state"}\n'); // bucket-1 state

  const envDir = paths.envDir(envName);
  mkdirSync(join(envDir, 'skills', 'w-skill'), { recursive: true });
  writeFileSync(join(envDir, 'skills', 'w-skill', 'SKILL.md'), '# w skill\n');
  mkdirSync(join(envDir, 'instructions'), { recursive: true });
  writeFileSync(join(envDir, 'instructions', 'base.md'), 'writing base instructions\n');
  mkdirSync(join(envDir, 'mcp'), { recursive: true });
  writeFileSync(join(envDir, 'mcp', 'servers.yaml'), 'linear:\n  url: https://linear\n');

  const env: NodeJS.ProcessEnv = { ...th.env, [FIXTURE_CONFIG_ENV]: realHome };
  return { paths, realHome, env };
}

describe('engine: global use (materialise)', () => {
  it('materialises the stack onto the REAL config paths and records ownership', async () => {
    const th = home();
    const { paths, realHome, env } = scenario(th);

    const res = await run(['use', 'writing', '--global'], { env, adapters: [makeFixtureAdapter()] });
    expect(res.code).toBe(0);

    // dir-merge: our skill symlinked in beside the user's own skill.
    const wSkill = join(realHome, 'skills', 'w-skill');
    expect(lstatSync(wSkill).isSymbolicLink()).toBe(true);
    expect(readlinkSync(wSkill)).toBe(join(paths.envDir('writing'), 'skills', 'w-skill'));
    expect(existsSync(join(realHome, 'skills', 'user-skill'))).toBe(true);

    // file-block: our region appended, user content preserved.
    const instr = readFileSync(join(realHome, 'INSTRUCTIONS.md'), 'utf8');
    expect(instr).toContain('keep me.');
    expect(instr).toContain('writing base instructions');
    expect(instr).toContain('agentenv:writing/base.md');

    // config-keys: our server injected beside the user's.
    const cfg = JSON.parse(readFileSync(join(realHome, 'config.json'), 'utf8'));
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(['linear', 'user-server']);

    // bucket-1 state file untouched.
    expect(readFileSync(join(realHome, 'auth.json'), 'utf8')).toBe('{"token":"secret-state"}\n');

    // manifest ownership + persisted global stack.
    const manifest = await readState(paths);
    expect(manifest.items.some((i) => i.surface === 'dir-merge' && i.ownerEnv === 'writing')).toBe(true);
    expect(manifest.items.some((i) => i.surface === 'file-block' && i.ownerEnv === 'writing')).toBe(true);
    expect(manifest.items.some((i) => i.surface === 'config-keys' && i.ownerEnv === 'writing')).toBe(true);
    expect(manifest.globalStack).toEqual(['writing']);
  });

  it('is idempotent: re-use produces no duplicate items or content', async () => {
    const th = home();
    const { paths, realHome, env } = scenario(th);
    const opts = { env, adapters: [makeFixtureAdapter()] };

    await run(['use', 'writing', '--global'], opts);
    const afterFirst = readFileSync(join(realHome, 'INSTRUCTIONS.md'), 'utf8');
    const itemsFirst = (await readState(paths)).items.length;

    const res2 = await run(['use', 'writing', '--global'], opts);
    expect(res2.code).toBe(0);
    expect(readFileSync(join(realHome, 'INSTRUCTIONS.md'), 'utf8')).toBe(afterFirst);
    const cfg = JSON.parse(readFileSync(join(realHome, 'config.json'), 'utf8'));
    expect(Object.keys(cfg.mcpServers).filter((k) => k === 'linear')).toHaveLength(1);
    expect((await readState(paths)).items.length).toBe(itemsFirst);
  });

  it('skips a user item of the same name and warns (D7)', async () => {
    const th = home();
    const { realHome, env } = scenario(th);
    // A user skill named exactly like the env's skill: the user wins.
    mkdirSync(join(realHome, 'skills', 'w-skill'), { recursive: true });
    writeFileSync(join(realHome, 'skills', 'w-skill', 'SKILL.md'), '# USER OWNS THIS\n');

    const res = await run(['use', 'writing', '--global'], { env, adapters: [makeFixtureAdapter()] });
    expect(res.code).toBe(0);
    // The user's file is untouched (not replaced by a symlink).
    expect(lstatSync(join(realHome, 'skills', 'w-skill')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(realHome, 'skills', 'w-skill', 'SKILL.md'), 'utf8')).toBe('# USER OWNS THIS\n');
    expect(res.stderr ?? '').toContain('w-skill');
  });

  it('errors when no adapter is registered', async () => {
    const th = home();
    const { env } = scenario(th);
    const res = await run(['use', 'writing', '--global'], { env, adapters: [] });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('adapter');
  });
});
