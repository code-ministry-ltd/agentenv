import { existsSync, mkdirSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  adoptSweep,
  readInventory,
  snapshotInventory,
  type AdoptSurface,
} from '../src/adopt.js';
import { resolvePaths } from '../src/paths.js';
import { readState } from '../src/state.js';
import { makeTempHome, type TempHome } from './helpers.js';

const homes: TempHome[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
});

function tmp(): TempHome {
  const th = makeTempHome();
  homes.push(th);
  return th;
}

/** Create an environment directory (enough for `environmentExists`). */
function makeEnv(paths: ReturnType<typeof resolvePaths>, name: string): void {
  mkdirSync(paths.envDir(name), { recursive: true });
  writeFileSync(paths.envYaml(name), `version: "1.0"\ndescription: ${name}\n`, 'utf8');
}

/** Create a skill folder (SKILL.md + optional body) in a surface dir. */
function makeSkill(surfaceDir: string, name: string, body = `# ${name}\n`): string {
  const dir = join(surfaceDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: the ${name} skill\n---\n\n${body}`, 'utf8');
  return dir;
}

/** A ready-to-sweep global surface for `env`, with `dir` snapshotted empty. */
async function setup(scope: AdoptSurface['scope'] = 'global'): Promise<{
  th: TempHome;
  paths: ReturnType<typeof resolvePaths>;
  surfaceDir: string;
  surface: AdoptSurface;
}> {
  const th = tmp();
  const paths = resolvePaths(th.env);
  makeEnv(paths, 'work');
  const surfaceDir = join(th.home, 'surface', 'skills');
  mkdirSync(surfaceDir, { recursive: true });
  const surface: AdoptSurface = { dir: surfaceDir, scope, storeKind: 'skills', ownerEnv: 'work' };
  await snapshotInventory(paths, [surface]);
  return { th, paths, surfaceDir, surface };
}

describe('adopt: inventory snapshot (D10)', () => {
  it('snapshots the baseline names of every dir-merge surface', async () => {
    const th = tmp();
    const paths = resolvePaths(th.env);
    makeEnv(paths, 'work');
    const surfaceDir = join(th.home, 'surface', 'skills');
    makeSkill(surfaceDir, 'preexisting');
    await snapshotInventory(paths, [
      { dir: surfaceDir, scope: 'global', storeKind: 'skills', ownerEnv: 'work' },
    ]);
    const inv = readInventory(await readState(paths));
    expect(inv).toHaveLength(1);
    expect(inv[0]?.baseline).toEqual(['preexisting']);
  });
});

describe('adopt: sweep auto-adopts a new item (D10)', () => {
  it('moves the new skill into the store, symlinks it back, and records ownership', async () => {
    const { paths, surfaceDir } = await setup();
    makeSkill(surfaceDir, 'fresh', '# fresh body\n');

    const result = await adoptSweep({ paths });
    expect(result.adopted.map((a) => a.name)).toEqual(['fresh']);

    // In the store under environments/work/skills/fresh
    const storePath = join(paths.envDir('work'), 'skills', 'fresh');
    expect(await readFile(join(storePath, 'SKILL.md'), 'utf8')).toContain('fresh body');

    // Symlinked back into the surface dir, pointing at the store copy
    const surfacePath = join(surfaceDir, 'fresh');
    expect((await lstat(surfacePath)).isSymbolicLink()).toBe(true);
    expect(readlinkSync(surfacePath)).toBe(storePath);

    // Owned in the manifest, flagged as an adoption
    const owner = (await readState(paths)).items.find((i) => i.path === surfacePath);
    expect(owner?.ownerEnv).toBe('work');
    expect((owner as { adopted?: boolean }).adopted).toBe(true);
    expect((owner as { origin?: string }).origin).toBe('global');
  });

  it('does not re-adopt an item it already owns', async () => {
    const { paths, surfaceDir } = await setup();
    makeSkill(surfaceDir, 'fresh');
    await adoptSweep({ paths });
    const second = await adoptSweep({ paths });
    expect(second.adopted).toHaveLength(0);
  });
});

describe('adopt: guardrail 1 — foreign-manager symlinks are never touched', () => {
  it('leaves a symlink into a non-agentenv root untouched (not moved, not adopted)', async () => {
    const { paths, surfaceDir, th } = await setup();
    // A `skills`-CLI-style symlink: points into ~/.agents/, outside the store.
    const foreignTarget = join(th.home, 'dot-agents', 'skills', 'vendored');
    makeSkill(join(th.home, 'dot-agents', 'skills'), 'vendored');
    const link = join(surfaceDir, 'vendored');
    symlinkSync(foreignTarget, link);

    const result = await adoptSweep({ paths });
    expect(result.adopted).toHaveLength(0);
    expect(result.skipped.some((s) => s.name === 'vendored' && s.reason === 'foreign-symlink')).toBe(true);
    // Untouched: still a symlink to the foreign target, and the target still exists.
    expect(readlinkSync(link)).toBe(foreignTarget);
    expect((await lstat(foreignTarget)).isDirectory()).toBe(true);
  });
});

describe('adopt: guardrail 2 — secret-bearing content prompts first', () => {
  it('declining the prompt leaves the item unadopted', async () => {
    const { paths, surfaceDir } = await setup();
    const dir = makeSkill(surfaceDir, 'leaky');
    writeFileSync(join(dir, 'creds.txt'), 'aws_secret_access_key = AKIAZ7Q2W9E4R6T1Y8U3\n');

    const result = await adoptSweep({ paths, confirm: async () => false });
    expect(result.adopted).toHaveLength(0);
    expect(result.skipped.some((s) => s.name === 'leaky' && s.reason === 'secret-declined')).toBe(true);
    // Still a real directory in the surface, not moved into the store.
    expect((await lstat(join(surfaceDir, 'leaky'))).isDirectory()).toBe(true);
  });

  it('accepting the prompt adopts it', async () => {
    const { paths, surfaceDir } = await setup();
    const dir = makeSkill(surfaceDir, 'leaky');
    writeFileSync(join(dir, 'creds.txt'), 'aws_secret_access_key = AKIAZ7Q2W9E4R6T1Y8U3\n');

    let asked = false;
    const result = await adoptSweep({
      paths,
      confirm: async () => {
        asked = true;
        return true;
      },
    });
    expect(asked).toBe(true);
    expect(result.adopted.map((a) => a.name)).toEqual(['leaky']);
    expect((await lstat(join(surfaceDir, 'leaky'))).isSymbolicLink()).toBe(true);
  });
});

describe('adopt: guardrail 3 — project-dir items are never auto-adopted', () => {
  it('leaves a new item in a project surface project-static', async () => {
    const { paths, surfaceDir } = await setup('project');
    makeSkill(surfaceDir, 'team-skill');
    const result = await adoptSweep({ paths });
    expect(result.adopted).toHaveLength(0);
    expect(result.skipped.some((s) => s.name === 'team-skill' && s.reason === 'project')).toBe(true);
    expect((await lstat(join(surfaceDir, 'team-skill'))).isDirectory()).toBe(true);
  });
});

describe('adopt: guardrail 4 — no active env leaves items global', () => {
  it('adopts nothing when the surface owner env no longer exists', async () => {
    const { paths, surfaceDir } = await setup();
    // Snapshot recorded owner 'work'; now sweep against a surface whose env is gone.
    await snapshotInventory(paths, [
      { dir: surfaceDir, scope: 'global', storeKind: 'skills', ownerEnv: 'ghost' },
    ]);
    makeSkill(surfaceDir, 'orphan');
    const result = await adoptSweep({ paths });
    expect(result.adopted).toHaveLength(0);
    expect(result.skipped.some((s) => s.name === 'orphan' && s.reason === 'no-env')).toBe(true);
    expect((await lstat(join(surfaceDir, 'orphan'))).isDirectory()).toBe(true);
  });
});

describe('adopt: Finding 2 — junk / dotfiles / malformed items are never auto-adopted', () => {
  /** A directory `folder` whose SKILL.md frontmatter name is `frontName` (mis-named when they differ). */
  function makeMisnamedSkill(surfaceDir: string, folder: string, frontName: string): void {
    const dir = join(surfaceDir, folder);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${frontName}\ndescription: mis-named\n---\n\n# ${frontName}\n`, 'utf8');
  }

  it('adopts only the well-formed skill; skips dotfiles, loose files, and mis-shaped dirs as invalid', async () => {
    const { paths, surfaceDir } = await setup();

    // Junk that MUST NEVER be adopted:
    writeFileSync(join(surfaceDir, '.DS_Store'), 'macOS finder junk\n', 'utf8'); // dotfile
    mkdirSync(join(surfaceDir, '.git'), { recursive: true }); // dot-dir (gitlink risk)
    writeFileSync(join(surfaceDir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    writeFileSync(join(surfaceDir, 'notes.txt'), 'a loose non-item file\n', 'utf8'); // loose file
    makeMisnamedSkill(surfaceDir, 'wrongname', 'othername'); // folder != frontmatter name

    // A well-formed skill that MUST be adopted:
    makeSkill(surfaceDir, 'sharpen', '# sharpen body\n');

    const result = await adoptSweep({ paths });

    // Only the well-formed skill is adopted.
    expect(result.adopted.map((a) => a.name)).toEqual(['sharpen']);

    // Every junk item is reported skipped `invalid`, is NOT in the store, and is NOT owned.
    const state = await readState(paths);
    for (const junk of ['.DS_Store', '.git', 'notes.txt', 'wrongname']) {
      expect(result.skipped.some((s) => s.name === junk && s.reason === 'invalid')).toBe(true);
      expect(existsSync(join(paths.envDir('work'), 'skills', junk))).toBe(false);
      expect(state.items.some((i) => i.path === join(surfaceDir, junk))).toBe(false);
    }
    // Junk left untouched on the surface (not moved out / not symlinked away).
    expect((await lstat(join(surfaceDir, 'notes.txt'))).isFile()).toBe(true);
    expect((await lstat(join(surfaceDir, 'wrongname'))).isDirectory()).toBe(true);
    expect((await lstat(join(surfaceDir, '.git'))).isDirectory()).toBe(true);
    expect((await lstat(join(surfaceDir, '.DS_Store'))).isFile()).toBe(true);

    // The good skill IS in the store and symlinked back.
    expect(existsSync(join(paths.envDir('work'), 'skills', 'sharpen', 'SKILL.md'))).toBe(true);
    expect((await lstat(join(surfaceDir, 'sharpen'))).isSymbolicLink()).toBe(true);
  });
});

describe('adopt: capture dry-run previews without changing anything', () => {
  it('lists what would be adopted and touches nothing on disk', async () => {
    const { paths, surfaceDir } = await setup();
    makeSkill(surfaceDir, 'fresh');

    const result = await adoptSweep({ paths, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.adopted.map((a) => a.name)).toEqual(['fresh']);
    // Nothing moved: still a real dir, nothing in the store, nothing owned.
    expect((await lstat(join(surfaceDir, 'fresh'))).isDirectory()).toBe(true);
    await expect(readdir(join(paths.envDir('work'), 'skills'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readState(paths)).items).toHaveLength(0);
    void realpathSync; // keep import used across edits
  });
});
