import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { resolvePaths } from '../src/paths.js';
import { makeFixtureAdapter } from './fixtures/fixture-adapter.js';
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

describe('engine: init', () => {
  it('creates the store, state.json, shims dir, and prints the shell hook line', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const res = await run(['init'], { env: th.env });
    expect(res.code).toBe(0);
    expect(existsSync(paths.environments)).toBe(true);
    expect(existsSync(paths.storeReadme)).toBe(true);
    expect(existsSync(paths.state)).toBe(true);
    expect(existsSync(paths.shims)).toBe(true);
    expect(res.stdout).toContain('eval "$(agentenv shell-init)"');
    const state = JSON.parse(readFileSync(paths.state, 'utf8'));
    expect(state.items).toEqual([]);
  });

  it('installs one shim per registered adapter', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const res = await run(['init'], { env: th.env, adapters: [makeFixtureAdapter()] });
    expect(res.code).toBe(0);
    const shim = join(paths.shims, 'fixture-harness');
    expect(existsSync(shim)).toBe(true);
    expect(statSync(shim).mode & 0o111).not.toBe(0);
  });

  it('is idempotent and never clobbers an existing state.json', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    await run(['init'], { env: th.env });

    // Seed a pre-existing ownership record and prove init preserves it.
    await mkdir(paths.base, { recursive: true });
    writeFileSync(
      paths.state,
      JSON.stringify({ version: '1.0', items: [{ surface: 'dir-merge', path: '/x', ownerEnv: 'writing' }] }),
    );

    const res = await run(['init'], { env: th.env });
    expect(res.code).toBe(0);
    const state = JSON.parse(readFileSync(paths.state, 'utf8'));
    expect(state.items).toHaveLength(1);
    expect(state.items[0].ownerEnv).toBe('writing');
  });
});
