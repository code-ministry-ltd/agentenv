import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import type { SkillChoice } from '../src/command.js';
import { parseEnvConfig } from '../src/env-config.js';
import { makeFixtureRepo, makeTempHome, type FixtureRepo, type TempHome } from './helpers.js';

describe('add.source: add skills <env> <source> (collection checklist)', () => {
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

  function skillDir(name: string): string {
    return join(tmp.home, 'store', 'environments', 'writing', 'skills', name);
  }
  function sources() {
    const text = readFileSync(join(tmp.home, 'store', 'environments', 'writing', 'env.yaml'), 'utf8');
    return parseEnvConfig(text, 'env.yaml').sources ?? {};
  }

  it('offers a checklist of discovered skills and installs the selection', async () => {
    repo.writeSkill('skills/alpha', { description: 'Alpha does A.' });
    repo.writeSkill('skills/beta', { description: 'Beta does B.' });
    repo.writeSkill('skills/gamma', { description: 'Gamma does G.' });
    repo.commit('init');

    let offered: readonly SkillChoice[] = [];
    const res = await run(['add', 'skills', 'writing', repo.fileUrl('skills')], {
      env: tmp.env,
      selectSkills: async (choices) => {
        offered = choices;
        return ['alpha', 'gamma'];
      },
    });
    expect(res.code).toBe(0);

    // The checklist saw every skill with its description.
    expect(offered.map((c) => c.name)).toEqual(['alpha', 'beta', 'gamma']);
    expect(offered.map((c) => c.description)).toEqual(['Alpha does A.', 'Beta does B.', 'Gamma does G.']);

    // Only the selection was installed, each with provenance.
    expect(existsSync(join(skillDir('alpha'), 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillDir('gamma'), 'SKILL.md'))).toBe(true);
    expect(existsSync(skillDir('beta'))).toBe(false);

    const prov = sources();
    expect(Object.keys(prov).sort()).toEqual(['alpha', 'gamma']);
    expect(prov['alpha']!.path).toBe('skills/alpha');
    expect(prov['gamma']!.path).toBe('skills/gamma');
    expect(prov['alpha']!.commit).toBe(repo.head());
  });

  it('--all installs everything found without a selector', async () => {
    repo.writeSkill('skills/alpha');
    repo.writeSkill('skills/beta');
    repo.commit('init');

    const res = await run(['add', 'skills', 'writing', repo.fileUrl('skills'), '--all'], {
      env: tmp.env,
      // A selector is provided but must NOT be consulted under --all.
      selectSkills: async () => {
        throw new Error('selector must not be called with --all');
      },
    });
    expect(res.code).toBe(0);
    expect(Object.keys(sources()).sort()).toEqual(['alpha', 'beta']);
  });

  it('installs nothing when the selection is empty', async () => {
    repo.writeSkill('skills/alpha');
    repo.commit('init');
    const res = await run(['add', 'skills', 'writing', repo.fileUrl('skills')], {
      env: tmp.env,
      selectSkills: async () => [],
    });
    expect(res.code).toBe(0);
    expect(existsSync(skillDir('alpha'))).toBe(false);
    expect(Object.keys(sources())).toEqual([]);
  });

  it('errors helpfully when the source contains no skills', async () => {
    repo.writeFile('docs/readme.md', 'nothing here\n');
    repo.commit('init');
    const res = await run(['add', 'skills', 'writing', repo.fileUrl('docs')], {
      env: tmp.env,
      selectSkills: async () => [],
    });
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('no skills');
  });

  it('skips a colliding skill with a warning unless --force, and warns on invalid ones', async () => {
    repo.writeSkill('skills/alpha');
    repo.writeSkill('skills/renamed', { name: 'mismatch' }); // folder != frontmatter → invalid
    repo.commit('init');

    // Pre-existing alpha (from a first install) collides on the second run.
    await run(['add', 'skills', 'writing', repo.fileUrl('skills'), '--all'], { env: tmp.env });
    const res = await run(['add', 'skills', 'writing', repo.fileUrl('skills'), '--all'], { env: tmp.env });
    // alpha already exists → skipped; renamed is invalid → error line; nothing installed.
    expect(res.stdout + (res.stderr ?? '')).toMatch(/Skipped:.*alpha/);
    expect(res.stdout + (res.stderr ?? '')).toMatch(/Errors:.*renamed/);
  });
});
