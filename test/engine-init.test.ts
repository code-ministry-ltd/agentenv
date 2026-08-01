import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { type GitRunner, storeIsRepo } from '../src/git.js';
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

  // The generated store README is the ONLY explanation a person gets when they find
  // this repo on another machine — cloned from the sync remote, or in a backup — with
  // no agentenv installed. Pin the four things it must tell them, so a future edit
  // cannot quietly drop one.
  it('writes a store README that explains the layout to a stranger who clones it', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    expect((await run(['init'], { env: th.env })).code).toBe(0);

    const readme = readFileSync(paths.storeReadme, 'utf8');

    // 1. The content layout, including the canonical MCP file.
    expect(readme).toContain('environments/');
    expect(readme).toContain('mcp/');
    expect(readme).toContain('servers.yaml');

    // 2. The machine-local siblings that are deliberately NOT in the repo.
    expect(readme).toContain('state.json');
    expect(readme).toContain('secrets.env');

    // 3. That secrets never sync — the one misunderstanding that leaks credentials.
    expect(readme).toMatch(/secrets?[^\n]*never synced|never synced/i);

    // 4. How to get from this repo back to a working machine.
    expect(readme).toContain('agentenv init --remote');
  });

  it('never overwrites a store README the user has edited', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    expect((await run(['init'], { env: th.env })).code).toBe(0);

    writeFileSync(paths.storeReadme, '# my own notes\n');
    expect((await run(['init'], { env: th.env })).code).toBe(0);

    expect(readFileSync(paths.storeReadme, 'utf8')).toBe('# my own notes\n');
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

  it('still bootstraps state + shims (warning, exit 0) when git is unavailable (F3)', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    // Simulate git missing entirely: every `git` invocation spawn-errors (code null).
    const gitMissing: GitRunner = () =>
      Promise.resolve({ code: null, stdout: '', stderr: 'spawn git ENOENT', timedOut: false });

    const res = await run(['init'], { env: th.env, adapters: [makeFixtureAdapter()], gitRun: gitMissing });

    // Session-mode machinery is created even with no git: exit 0, state + shims exist.
    expect(res.code).toBe(0);
    expect(existsSync(paths.state)).toBe(true);
    expect(existsSync(join(paths.shims, 'fixture-harness'))).toBe(true);
    // The failure was surfaced as a warning, not a fatal error.
    expect(res.stderr ?? '').toMatch(/warning/i);
    expect(res.stderr ?? '').toMatch(/git/i);
    // The store was NOT put under version control.
    expect(await storeIsRepo(paths)).toBe(false);
    expect(res.stdout).not.toContain('git initialised');
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
