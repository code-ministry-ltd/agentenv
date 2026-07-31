import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { snapshotInventory, type AdoptSurface } from '../src/adopt.js';
import { run } from '../src/cli.js';
import { resolvePaths } from '../src/paths.js';
import { makeTempHome, type TempHome } from './helpers.js';

const homes: TempHome[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
});

/** A git-backed temp home so store commits are exercised. */
function gitHome(): TempHome {
  const th = makeTempHome({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' });
  homes.push(th);
  return th;
}

/** Store git subjects, newest first. */
function subjects(store: string): string[] {
  return execFileSync('git', ['log', '--format=%s'], { cwd: store, encoding: 'utf8' })
    .split('\n')
    .filter((l) => l.trim() !== '');
}

function makeSkill(surfaceDir: string, name: string, body = `# ${name}\n`): string {
  const dir = join(surfaceDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: the ${name} skill\n---\n\n${body}`, 'utf8');
  return dir;
}

/** init + a `work` env + an empty snapshotted global surface dir. */
async function setup(): Promise<{ th: TempHome; paths: ReturnType<typeof resolvePaths>; surfaceDir: string }> {
  const th = gitHome();
  const paths = resolvePaths(th.env);
  await run(['init'], { env: th.env });
  await run(['create', 'work'], { env: th.env });
  const surfaceDir = join(th.home, 'surface', 'skills');
  mkdirSync(surfaceDir, { recursive: true });
  const surface: AdoptSurface = { dir: surfaceDir, scope: 'global', storeKind: 'skills', ownerEnv: 'work' };
  await snapshotInventory(paths, [surface]);
  return { th, paths, surfaceDir };
}

describe('capture: auto-adopts a new item and commits it (D10)', () => {
  it('moves the skill into the store, symlinks it back, and the store commit shows the adoption', async () => {
    const { th, paths, surfaceDir } = await setup();
    makeSkill(surfaceDir, 'fresh');

    const res = await run(['capture'], { env: th.env });
    expect(res.code).toBe(0);

    // In the store, symlinked back, and owned.
    const storePath = join(paths.envDir('work'), 'skills', 'fresh');
    expect(existsSync(join(storePath, 'SKILL.md'))).toBe(true);
    expect((await lstat(join(surfaceDir, 'fresh'))).isSymbolicLink()).toBe(true);

    // The store commit records the adoption (D9 message shape).
    expect(subjects(paths.store)[0]).toBe('agentenv: adopt skill fresh → work');

    // Announced, never silent.
    expect(res.stdout).toMatch(/adopt/i);
    expect(res.stdout).toContain('fresh');
  });

  it('reports nothing to adopt when there are no new items', async () => {
    const { th } = await setup();
    const res = await run(['capture'], { env: th.env });
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/nothing to adopt/i);
  });
});

describe('capture --dry-run: previews the adoption without changing anything', () => {
  it('lists what would be adopted and touches nothing', async () => {
    const { th, paths, surfaceDir } = await setup();
    makeSkill(surfaceDir, 'fresh');
    const before = subjects(paths.store).length;

    const res = await run(['capture', '--dry-run'], { env: th.env });
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/would adopt/i);
    expect(res.stdout).toContain('fresh');

    // Nothing changed: still a real dir, nothing in the store, no new commit.
    expect((await lstat(join(surfaceDir, 'fresh'))).isDirectory()).toBe(true);
    await expect(readdir(join(paths.envDir('work'), 'skills'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(subjects(paths.store).length).toBe(before);
  });
});

describe('capture: guardrails are enforced (D10)', () => {
  it('does not adopt a secret-bearing item when the prompt is declined', async () => {
    const { th, surfaceDir } = await setup();
    const dir = makeSkill(surfaceDir, 'leaky');
    writeFileSync(join(dir, 'creds.txt'), 'aws_secret_access_key = AKIAZ7Q2W9E4R6T1Y8U3\n');

    const res = await run(['capture'], { env: th.env, confirm: async () => false });
    expect(res.code).toBe(0);
    expect((await lstat(join(surfaceDir, 'leaky'))).isDirectory()).toBe(true);
    expect(res.stdout).toMatch(/nothing to adopt/i);
  });

  it('does not auto-adopt an item in a project surface', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    await run(['init'], { env: th.env });
    await run(['create', 'work'], { env: th.env });
    const projectDir = join(th.home, 'repo', '.claude', 'skills');
    mkdirSync(projectDir, { recursive: true });
    await snapshotInventory(paths, [
      { dir: projectDir, scope: 'project', storeKind: 'skills', ownerEnv: 'work' },
    ]);
    makeSkill(projectDir, 'team-skill');

    const res = await run(['capture'], { env: th.env });
    expect(res.code).toBe(0);
    expect((await lstat(join(projectDir, 'team-skill'))).isDirectory()).toBe(true);
  });
});
