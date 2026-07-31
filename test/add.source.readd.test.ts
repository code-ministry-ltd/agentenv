import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { parseEnvConfig } from '../src/env-config.js';
import { makeFixtureRepo, makeTempHome, type FixtureRepo, type TempHome } from './helpers.js';

describe('add.source: re-add diff + overwrite (the v1 update path)', () => {
  let tmp: TempHome;
  let repo: FixtureRepo;

  beforeEach(async () => {
    tmp = makeTempHome();
    await run(['create', 'writing'], { env: tmp.env });
    repo = makeFixtureRepo();
  });
  afterEach(() => {
    tmp.cleanup();
    repo?.cleanup();
  });

  const source = (): string => repo.fileUrl('skills/tp');
  function skillMd(): string {
    return readFileSync(join(tmp.home, 'store', 'environments', 'writing', 'skills', 'tp', 'SKILL.md'), 'utf8');
  }
  function prov() {
    const text = readFileSync(join(tmp.home, 'store', 'environments', 'writing', 'env.yaml'), 'utf8');
    return parseEnvConfig(text, 'env.yaml').sources?.['tp'];
  }

  async function firstInstall(): Promise<void> {
    repo.writeSkill('skills/tp', { name: 'tp', body: 'version one body\n' });
    repo.commit('v1');
    const res = await run(['add', 'skill', 'writing', source()], { env: tmp.env });
    expect(res.code).toBe(0);
  }

  it('is a no-op with no prompt when the source is unchanged', async () => {
    await firstInstall();
    const commit1 = prov()!.commit;

    const res = await run(['add', 'skill', 'writing', source()], {
      env: tmp.env,
      confirm: async () => {
        throw new Error('confirm must not be called when the source is unchanged');
      },
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/already up to date/);
    expect(prov()!.commit).toBe(commit1);
  });

  it('shows a diff and prompts; declining leaves the skill and provenance unchanged', async () => {
    await firstInstall();
    const commit1 = prov()!.commit;

    repo.writeSkill('skills/tp', { name: 'tp', body: 'version two body\n' });
    repo.commit('v2');

    let asked = '';
    const res = await run(['add', 'skill', 'writing', source()], {
      env: tmp.env,
      confirm: async (q) => {
        asked = q;
        return false;
      },
    });
    expect(res.code).toBe(0);
    // The prompt included a real diff of the change.
    expect(asked).toContain('changed:');
    expect(asked).toContain('-version one body');
    expect(asked).toContain('+version two body');
    // Declined → nothing changed.
    expect(skillMd()).toContain('version one body');
    expect(prov()!.commit).toBe(commit1);
    expect(res.stdout).toMatch(/unchanged/);
  });

  it('overwrites and updates provenance when the prompt is accepted', async () => {
    await firstInstall();
    const commit1 = prov()!.commit;
    const hash1 = prov()!.hash;

    repo.writeSkill('skills/tp', { name: 'tp', body: 'version two body\n' });
    repo.commit('v2');

    const res = await run(['add', 'skill', 'writing', source()], {
      env: tmp.env,
      confirm: async () => true,
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/Updated skill 'tp'/);
    expect(skillMd()).toContain('version two body');
    expect(prov()!.commit).not.toBe(commit1);
    expect(prov()!.hash).not.toBe(hash1);
    expect(prov()!.commit).toBe(repo.head());
  });

  it('--force overwrites a changed source without prompting', async () => {
    await firstInstall();
    repo.writeSkill('skills/tp', { name: 'tp', body: 'version two body\n' });
    repo.commit('v2');

    const res = await run(['add', 'skill', 'writing', source(), '--force'], {
      env: tmp.env,
      confirm: async () => {
        throw new Error('confirm must not be called with --force');
      },
    });
    expect(res.code).toBe(0);
    expect(skillMd()).toContain('version two body');
  });

  it('refuses to overwrite a differently-sourced skill of the same name without --force', async () => {
    // A scaffolded skill named tp (no provenance) collides with a git source tp.
    await run(['add', 'skill', 'writing', 'tp'], { env: tmp.env });
    repo.writeSkill('skills/tp', { name: 'tp', body: 'from git\n' });
    repo.commit('v1');

    const refused = await run(['add', 'skill', 'writing', source()], { env: tmp.env });
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('--force');
    expect(prov()).toBeUndefined();

    const forced = await run(['add', 'skill', 'writing', source(), '--force'], { env: tmp.env });
    expect(forced.code).toBe(0);
    expect(skillMd()).toContain('from git');
    expect(prov()).toBeDefined();
  });
});
