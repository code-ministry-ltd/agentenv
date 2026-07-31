import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { snapshotInventory, type AdoptSurface } from '../src/adopt.js';
import { run } from '../src/cli.js';
import { resolvePaths } from '../src/paths.js';
import { readState } from '../src/state.js';
import { makeTempHome, type TempHome } from './helpers.js';

const homes: TempHome[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
});

function gitHome(): TempHome {
  const th = makeTempHome({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' });
  homes.push(th);
  return th;
}

function subjects(store: string): string[] {
  return execFileSync('git', ['log', '--format=%s'], { cwd: store, encoding: 'utf8' })
    .split('\n')
    .filter((l) => l.trim() !== '');
}

/** A skill folder with a stable, checkable body + an extra file. */
function makeSkill(surfaceDir: string, name: string): string {
  const dir = join(surfaceDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: the ${name} skill\n---\n\n# ${name}\nbody-of-${name}\n`, 'utf8');
  writeFileSync(join(dir, 'extra.txt'), `extra-for-${name}\n`, 'utf8');
  return dir;
}

describe('adopt --into: manual adoption into a chosen env (D10)', () => {
  it('adopts a new unowned item into the named (non-top) env', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    await run(['init'], { env: th.env });
    await run(['create', 'work'], { env: th.env });
    await run(['create', 'research'], { env: th.env });
    const surfaceDir = join(th.home, 'surface', 'skills');
    mkdirSync(surfaceDir, { recursive: true });
    // Top env is `work`; snapshot records it, but --into overrides to `research`.
    await snapshotInventory(paths, [
      { dir: surfaceDir, scope: 'global', storeKind: 'skills', ownerEnv: 'work' } as AdoptSurface,
    ]);
    makeSkill(surfaceDir, 'chosen');

    const res = await run(['adopt', 'chosen', '--into', 'research'], { env: th.env });
    expect(res.code).toBe(0);

    // Lands in research, NOT work.
    expect(existsSync(join(paths.envDir('research'), 'skills', 'chosen', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(paths.envDir('work'), 'skills', 'chosen'))).toBe(false);
    expect((await lstat(join(surfaceDir, 'chosen'))).isSymbolicLink()).toBe(true);
    expect(subjects(paths.store)[0]).toBe('agentenv: adopt skill chosen → research');
  });
});

describe('disown: reverses a global-mode adoption byte-identically (D10)', () => {
  it('restores the item to its recorded original path with identical bytes', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    await run(['init'], { env: th.env });
    await run(['create', 'work'], { env: th.env });
    const surfaceDir = join(th.home, 'surface', 'skills');
    mkdirSync(surfaceDir, { recursive: true });
    await snapshotInventory(paths, [
      { dir: surfaceDir, scope: 'global', storeKind: 'skills', ownerEnv: 'work' } as AdoptSurface,
    ]);
    const originalDir = makeSkill(surfaceDir, 'guessed');
    const originalSkill = readFileSync(join(originalDir, 'SKILL.md'));
    const originalExtra = readFileSync(join(originalDir, 'extra.txt'));

    // Auto-adopt, then reverse the guess.
    await run(['capture'], { env: th.env });
    expect((await lstat(join(surfaceDir, 'guessed'))).isSymbolicLink()).toBe(true);

    const res = await run(['disown', 'guessed'], { env: th.env });
    expect(res.code).toBe(0);

    // The original real path is restored, byte-identically, as a real directory.
    const restored = join(surfaceDir, 'guessed');
    expect((await lstat(restored)).isDirectory()).toBe(true);
    expect(readFileSync(join(restored, 'SKILL.md')).equals(originalSkill)).toBe(true);
    expect(readFileSync(join(restored, 'extra.txt')).equals(originalExtra)).toBe(true);
    // The store copy is gone and ownership dropped.
    expect(existsSync(join(paths.envDir('work'), 'skills', 'guessed'))).toBe(false);
    expect((await readState(paths)).items.some((i) => i.path === restored)).toBe(false);
    expect(subjects(paths.store)[0]).toBe('agentenv: disown skill guessed');
  });
});

describe('disown: a session-born item prompts keep-ephemeral vs place-global (D10)', () => {
  /** Adopt a session-born skill; return the paths involved. */
  async function adoptSessionBorn(): Promise<{
    th: TempHome;
    paths: ReturnType<typeof resolvePaths>;
    viewDir: string;
    realDir: string;
    name: string;
  }> {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    await run(['init'], { env: th.env });
    await run(['create', 'work'], { env: th.env });
    const viewDir = join(th.home, 'live', 'sess', 'harness', 'skills');
    const realDir = join(th.home, 'real', 'skills');
    mkdirSync(viewDir, { recursive: true });
    mkdirSync(realDir, { recursive: true });
    await snapshotInventory(paths, [
      { dir: viewDir, scope: 'session', storeKind: 'skills', ownerEnv: 'work', session: 'sess', realDir } as AdoptSurface,
    ]);
    makeSkill(viewDir, 'born');
    await run(['capture'], { env: th.env });
    return { th, paths, viewDir, realDir, name: 'born' };
  }

  it('keep-ephemeral (declined) restores to the view path, not the real global surface', async () => {
    const { th, paths, viewDir, realDir, name } = await adoptSessionBorn();
    const res = await run(['disown', name], { env: th.env, confirm: async () => false });
    expect(res.code).toBe(0);
    // Restored to the ephemeral view dir; the real global surface is untouched.
    expect((await lstat(join(viewDir, name))).isDirectory()).toBe(true);
    expect(existsSync(join(realDir, name))).toBe(false);
    expect(existsSync(join(paths.envDir('work'), 'skills', name))).toBe(false);
    expect(res.stdout).toMatch(/ephemeral/i);
  });

  it('place-global (accepted) places it into the real global surface', async () => {
    const { th, paths, viewDir, realDir, name } = await adoptSessionBorn();
    const res = await run(['disown', name], { env: th.env, confirm: async () => true });
    expect(res.code).toBe(0);
    // Placed into the real global surface as a real dir; the view path is cleared.
    expect((await lstat(join(realDir, name))).isDirectory()).toBe(true);
    expect(await readFile(join(realDir, name, 'SKILL.md'), 'utf8')).toContain('body-of-born');
    expect(existsSync(join(viewDir, name))).toBe(false);
    expect(existsSync(join(paths.envDir('work'), 'skills', name))).toBe(false);
    expect(res.stdout).toMatch(/global/i);
  });
});
