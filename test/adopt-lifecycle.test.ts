import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readInventory, snapshotInventory, type AdoptSurface } from '../src/adopt.js';
import { run } from '../src/cli.js';
import { resolvePaths } from '../src/paths.js';
import { readState } from '../src/state.js';
import { makeFixtureAdapter } from './fixtures/fixture-adapter.js';
import { makeTempHome, type TempHome } from './helpers.js';

const homes: TempHome[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
});

function gitHome(extra: NodeJS.ProcessEnv = {}): TempHome {
  const th = makeTempHome({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...extra });
  homes.push(th);
  return th;
}

function subjects(store: string): string[] {
  return execFileSync('git', ['log', '--format=%s'], { cwd: store, encoding: 'utf8' })
    .split('\n')
    .filter((l) => l.trim() !== '');
}

function makeSkill(surfaceDir: string, name: string): void {
  const dir = join(surfaceDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: the ${name} skill\n---\n\n# ${name}\n`, 'utf8');
}

describe('adopt: the sweep runs on EVERY invocation, not just capture (D10)', () => {
  it('an ordinary mutating command auto-adopts a new item created since the snapshot', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    await run(['init'], { env: th.env });
    await run(['create', 'work'], { env: th.env });

    // Simulate a prior activation having snapshotted this surface.
    const surfaceDir = join(th.home, 'surface', 'skills');
    mkdirSync(surfaceDir, { recursive: true });
    await snapshotInventory(paths, [
      { dir: surfaceDir, scope: 'global', storeKind: 'skills', ownerEnv: 'work' } as AdoptSurface,
    ]);

    // An agent creates a new skill mid-session, then any later invocation runs.
    makeSkill(surfaceDir, 'midsession');
    const res = await run(['create', 'other'], { env: th.env });
    expect(res.code).toBe(0);

    // Auto-adopted by the lifecycle sweep, symlinked back, and committed.
    expect(existsSync(join(paths.envDir('work'), 'skills', 'midsession', 'SKILL.md'))).toBe(true);
    expect((await lstat(join(surfaceDir, 'midsession'))).isSymbolicLink()).toBe(true);
    expect(subjects(paths.store)).toContain('agentenv: adopt skill midsession → work');
  });

  it('does not silently adopt a secret item in the non-interactive lifecycle sweep', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    await run(['init'], { env: th.env });
    await run(['create', 'work'], { env: th.env });
    const surfaceDir = join(th.home, 'surface', 'skills');
    mkdirSync(surfaceDir, { recursive: true });
    await snapshotInventory(paths, [
      { dir: surfaceDir, scope: 'global', storeKind: 'skills', ownerEnv: 'work' } as AdoptSurface,
    ]);

    makeSkill(surfaceDir, 'leaky');
    writeFileSync(join(surfaceDir, 'leaky', 'creds.txt'), 'aws_secret_access_key = AKIAZ7Q2W9E4R6T1Y8U3\n');
    await run(['create', 'other'], { env: th.env });

    // Left in place — the interactive `capture` is the only path that can adopt it.
    expect((await lstat(join(surfaceDir, 'leaky'))).isDirectory()).toBe(true);
    expect(existsSync(join(paths.envDir('work'), 'skills', 'leaky'))).toBe(false);
  });
});

describe('adopt: use --global snapshots the adapter dir-merge surfaces (D10)', () => {
  it('records each supported dir-merge surface so the next invocation can sweep it', async () => {
    const fixtureRoot = makeTempHome();
    homes.push(fixtureRoot);
    const th = gitHome({ FIXTURE_CONFIG_DIR: fixtureRoot.home });
    const paths = resolvePaths(th.env);
    const adapter = makeFixtureAdapter();

    await run(['init'], { env: th.env });
    await run(['create', 'work'], { env: th.env });
    await run(['use', 'work', '--global'], { env: th.env, adapters: [adapter] });

    // The fixture adapter's skills surface (rootRelativePath 'skills') is snapshotted.
    const inv = readInventory(await readState(paths));
    const skillsSurface = inv.find((s) => s.dir === join(fixtureRoot.home, 'skills'));
    expect(skillsSurface).toBeDefined();
    expect(skillsSurface?.ownerEnv).toBe('work');
    expect(skillsSurface?.scope).toBe('global');

    // A new skill dropped into the real surface is adopted by the next invocation.
    mkdirSync(join(fixtureRoot.home, 'skills'), { recursive: true });
    makeSkill(join(fixtureRoot.home, 'skills'), 'agent-made');
    await run(['create', 'other'], { env: th.env, adapters: [adapter] });
    expect(existsSync(join(paths.envDir('work'), 'skills', 'agent-made', 'SKILL.md'))).toBe(true);
    expect(subjects(paths.store)).toContain('agentenv: adopt skill agent-made → work');
  });
});
