import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fetchSkillSource,
  diffDirs,
  hashDir,
  resolveSkillSource,
  scanSkillDirs,
  type ParsedSkillSource,
} from '../src/skill-source.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers.js';

function asSource(result: Awaited<ReturnType<typeof resolveSkillSource>>): ParsedSkillSource {
  if ('error' in result) throw new Error(`resolve failed: ${result.error}`);
  return result;
}

describe('add.source: fetchSkillSource (offline, file:// clone)', () => {
  let repo: FixtureRepo;
  const cleanups: string[] = [];
  afterEach(async () => {
    repo?.cleanup();
    for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('clones the default branch and resolves the HEAD commit', async () => {
    repo = makeFixtureRepo();
    repo.writeSkill('skills/thinking-partner');
    const head = repo.commit('init');

    const source = asSource(await resolveSkillSource(repo.fileUrl('skills/thinking-partner')));
    const fetched = await fetchSkillSource(source);
    if ('error' in fetched) throw new Error(fetched.error);
    cleanups.push(fetched.cloneDir);

    expect(fetched.commit).toBe(head);
    expect(existsSync(join(fetched.scanDir, 'SKILL.md'))).toBe(true);
    expect(fetched.ref).toBe('main');
  });

  it('honours @ref, checking out a tagged older commit', async () => {
    repo = makeFixtureRepo();
    repo.writeSkill('skills/x', { body: 'v1 body\n' });
    const v1 = repo.commit('v1');
    repo.git('tag', 'v1');
    repo.writeSkill('skills/x', { body: 'v2 body\n' });
    const v2 = repo.commit('v2');
    expect(v1).not.toBe(v2);

    const source = asSource(await resolveSkillSource(repo.fileUrl('skills/x') + '@v1'));
    expect(source.ref).toBe('v1');
    const fetched = await fetchSkillSource(source);
    if ('error' in fetched) throw new Error(fetched.error);
    cleanups.push(fetched.cloneDir);

    expect(fetched.commit).toBe(v1);
    expect(fetched.ref).toBe('v1');
  });

  it('scanSkillDirs finds every SKILL.md dir with its description', async () => {
    repo = makeFixtureRepo();
    repo.writeSkill('skills/alpha', { description: 'The alpha skill.' });
    repo.writeSkill('skills/beta', { description: 'The beta skill.' });
    repo.writeFile('skills/README.md', 'not a skill\n');
    repo.commit('init');

    const source = asSource(await resolveSkillSource(repo.fileUrl('skills')));
    const fetched = await fetchSkillSource(source);
    if ('error' in fetched) throw new Error(fetched.error);
    cleanups.push(fetched.cloneDir);

    const candidates = await scanSkillDirs(fetched.scanDir);
    expect(candidates.map((c) => c.name)).toEqual(['alpha', 'beta']);
    expect(candidates.map((c) => c.description)).toEqual(['The alpha skill.', 'The beta skill.']);
  });

  it('errors cleanly (nothing left behind) when the subpath does not exist', async () => {
    repo = makeFixtureRepo();
    repo.writeSkill('skills/x');
    repo.commit('init');

    const source = asSource(await resolveSkillSource(repo.fileUrl('skills/nope')));
    const fetched = await fetchSkillSource(source);
    expect('error' in fetched).toBe(true);
    if ('error' in fetched) expect(fetched.error).toContain('does not exist');
  });

  it('errors cleanly on an unresolvable ref', async () => {
    repo = makeFixtureRepo();
    repo.writeSkill('skills/x');
    repo.commit('init');

    const source = asSource(await resolveSkillSource(repo.fileUrl('skills/x') + '@no-such-ref'));
    const fetched = await fetchSkillSource(source);
    expect('error' in fetched).toBe(true);
  });
});

describe('add.source: hashDir', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });
  function makeDir(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'agentenv-hash-'));
    dirs.push(dir);
    for (const [rel, contents] of Object.entries(files)) {
      const full = join(dir, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, contents, 'utf8');
    }
    return dir;
  }

  it('is stable for identical content and differs when content changes', async () => {
    const a = makeDir({ 'SKILL.md': 'x', 'sub/f.txt': 'y' });
    const b = makeDir({ 'SKILL.md': 'x', 'sub/f.txt': 'y' });
    const c = makeDir({ 'SKILL.md': 'x', 'sub/f.txt': 'CHANGED' });

    const [ha, hb, hc] = [await hashDir(a), await hashDir(b), await hashDir(c)];
    expect(ha).toBe(hb);
    expect(ha).not.toBe(hc);
    expect(ha).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes and diffs symlink identity without following the target', async () => {
    const files = {
      'SKILL.md': 'x',
      'targets/one.txt': 'same bytes',
      'targets/two.txt': 'same bytes',
    };
    const a = makeDir(files);
    const b = makeDir(files);
    symlinkSync('targets/one.txt', join(a, 'resource'));
    symlinkSync('targets/two.txt', join(b, 'resource'));

    expect(await hashDir(a)).not.toBe(await hashDir(b));
    const diff = await diffDirs(a, b);
    expect(diff).toContain('changed: resource (symlink)');
    expect(diff).toContain('targets/one.txt');
    expect(diff).toContain('targets/two.txt');
  });
});
