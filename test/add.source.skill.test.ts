import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { validateSkillDir } from '../src/content-items.js';
import { parseEnvConfig } from '../src/env-config.js';
import {
  expectRealHomeUntouched,
  makeFixtureRepo,
  realHomeSnapshot,
  makeTempHome,
  type FixtureRepo,
  type TempHome,
} from './helpers.js';

describe('add.source: add skill <env> <gitSource> (single)', () => {
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
  function envYaml(): string {
    return readFileSync(join(tmp.home, 'store', 'environments', 'writing', 'env.yaml'), 'utf8');
  }

  it('vendors exactly one skill with full provenance (criterion 12)', async () => {
    repo.writeSkill('skills/thinking-partner', {
      description: 'A thinking partner.',
      extraFiles: { 'reference.md': 'extra reference\n' },
    });
    // A sibling skill that must NOT be pulled in by the single-skill install.
    repo.writeSkill('skills/other');
    const head = repo.commit('init');

    const real = realHomeSnapshot();
    const res = await run(
      ['add', 'skill', 'writing', repo.fileUrl('skills/thinking-partner')],
      { env: tmp.env },
    );
    expect(res.code).toBe(0);

    // Exactly that skill (and its whole tree) vendored; the sibling is not.
    expect(existsSync(join(skillDir('thinking-partner'), 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillDir('thinking-partner'), 'reference.md'))).toBe(true);
    expect(existsSync(skillDir('other'))).toBe(false);

    // Vendored copy validates identically to a scaffolded skill.
    expect(await validateSkillDir(skillDir('thinking-partner'))).toEqual({ name: 'thinking-partner' });

    // Provenance recorded: repo, path, ref, commit, hash.
    const cfg = parseEnvConfig(envYaml(), 'env.yaml');
    const prov = cfg.sources?.['thinking-partner'];
    expect(prov).toBeDefined();
    expect(prov!.path).toBe('skills/thinking-partner');
    expect(prov!.commit).toBe(head);
    expect(prov!.ref).toBe('main');
    expect(prov!.repo.startsWith('file://')).toBe(true);
    expect(prov!.hash).toMatch(/^[0-9a-f]{64}$/);

    expectRealHomeUntouched(real);
  });

  it('errors helpfully when the path contains no SKILL.md, writing nothing', async () => {
    repo.writeFile('skills/empty/notes.md', 'no skill here\n');
    repo.commit('init');
    const res = await run(['add', 'skill', 'writing', repo.fileUrl('skills/empty')], { env: tmp.env });
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('SKILL.md');
    expect(existsSync(skillDir('empty'))).toBe(false);
  });

  it('errors listing candidates when a collection is given to `add skill`', async () => {
    repo.writeSkill('skills/alpha');
    repo.writeSkill('skills/beta');
    repo.commit('init');
    const res = await run(['add', 'skill', 'writing', repo.fileUrl('skills')], { env: tmp.env });
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('collection');
    expect(res.stderr).toContain('alpha');
    expect(res.stderr).toContain('beta');
    expect(res.stderr).toContain('add skills');
  });

  it('rejects a vendored skill whose folder name is invalid, identically to a scaffold', async () => {
    // Folder 'bad_name' can never equal a valid kebab-case frontmatter name.
    repo.writeSkill('skills/bad_name', { name: 'bad_name' });
    repo.commit('init');
    const res = await run(['add', 'skill', 'writing', repo.fileUrl('skills/bad_name')], { env: tmp.env });
    expect(res.code).not.toBe(0);
    expect(existsSync(skillDir('bad_name'))).toBe(false);
    const cfg = parseEnvConfig(envYaml(), 'env.yaml');
    expect(cfg.sources).toBeUndefined();
  });

  it('rejects a vendored skill whose folder name != frontmatter name', async () => {
    repo.writeSkill('skills/thinking-partner', { name: 'renamed' });
    repo.commit('init');
    const res = await run(
      ['add', 'skill', 'writing', repo.fileUrl('skills/thinking-partner')],
      { env: tmp.env },
    );
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/must equal/);
    expect(existsSync(skillDir('thinking-partner'))).toBe(false);
  });

  it('fails cleanly and writes nothing when the source is unreachable (offline)', async () => {
    const real = realHomeSnapshot();
    const res = await run(
      ['add', 'skill', 'writing', 'file:///no/such/repo/skills/x'],
      { env: tmp.env },
    );
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/unreachable|does not exist|no git repository/);
    expect(existsSync(join(tmp.home, 'store', 'environments', 'writing', 'skills'))).toBe(false);
    const cfg = parseEnvConfig(envYaml(), 'env.yaml');
    expect(cfg.sources).toBeUndefined();
    expectRealHomeUntouched(real);
  });
});
