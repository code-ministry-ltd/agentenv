import { afterEach, describe, expect, it } from 'vitest';
import { parseEnvConfig, scaffoldEnvYaml, upsertEnvSource } from '../src/env-config.js';
import { resolveSkillSource, type ParsedSkillSource } from '../src/skill-source.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers.js';

function expectSource(result: Awaited<ReturnType<typeof resolveSkillSource>>): ParsedSkillSource {
  if ('error' in result) throw new Error(`expected a parsed source, got error: ${result.error}`);
  return result;
}

describe('add.source: resolveSkillSource — shorthand and URLs', () => {
  it('parses owner/repo/path shorthand into an https clone URL', async () => {
    const s = expectSource(await resolveSkillSource('JimJafar/agent-skills/skills/thinking-partner'));
    expect(s.repo).toBe('JimJafar/agent-skills');
    expect(s.cloneUrl).toBe('https://github.com/JimJafar/agent-skills.git');
    expect(s.subpath).toBe('skills/thinking-partner');
    expect(s.ref).toBeUndefined();
  });

  it('treats the first two segments as owner/repo and the rest as subpath', async () => {
    const s = expectSource(await resolveSkillSource('acme/tools'));
    expect(s.repo).toBe('acme/tools');
    expect(s.subpath).toBe('');
  });

  it('peels a trailing @ref (tag, branch or sha)', async () => {
    const s = expectSource(await resolveSkillSource('acme/tools/skills/x@v1.2'));
    expect(s.repo).toBe('acme/tools');
    expect(s.subpath).toBe('skills/x');
    expect(s.ref).toBe('v1.2');
  });

  it('normalises a full https GitHub URL', async () => {
    const s = expectSource(await resolveSkillSource('https://github.com/acme/tools'));
    expect(s.repo).toBe('acme/tools');
    expect(s.cloneUrl).toBe('https://github.com/acme/tools.git');
    expect(s.subpath).toBe('');
  });

  it('honours /tree/<ref>/<path> in a GitHub web URL', async () => {
    const s = expectSource(
      await resolveSkillSource('https://github.com/acme/tools/tree/main/skills/x'),
    );
    expect(s.repo).toBe('acme/tools');
    expect(s.ref).toBe('main');
    expect(s.subpath).toBe('skills/x');
  });

  it('strips a .git suffix and parses an scp-style URL', async () => {
    const s = expectSource(await resolveSkillSource('git@github.com:acme/tools.git/skills/x'));
    expect(s.repo).toBe('acme/tools');
    expect(s.cloneUrl).toBe('git@github.com:acme/tools.git');
    expect(s.subpath).toBe('skills/x');
  });

  it('preserves the SSH username in a scheme URL', async () => {
    const s = expectSource(
      await resolveSkillSource('ssh://deploy@code.example.com/acme/tools/skills/x'),
    );
    expect(s.repo).toBe('acme/tools');
    expect(s.cloneUrl).toBe('ssh://deploy@code.example.com/acme/tools.git');
    expect(s.subpath).toBe('skills/x');
  });

  it('rejects an argument with fewer than owner/repo segments', async () => {
    const r = await resolveSkillSource('justowner');
    expect('error' in r).toBe(true);
  });

  it('rejects a subpath that tries to escape with ..', async () => {
    const r = await resolveSkillSource('acme/tools/../../etc');
    expect('error' in r).toBe(true);
  });
});

describe('add.source: resolveSkillSource — local file:// repos', () => {
  let repo: FixtureRepo;
  afterEach(() => repo?.cleanup());

  it('finds the repo root above a skill dir and splits the subpath', async () => {
    repo = makeFixtureRepo();
    repo.writeSkill('skills/thinking-partner');
    repo.commit('init');

    const s = expectSource(await resolveSkillSource(repo.fileUrl('skills/thinking-partner')));
    expect(s.subpath).toBe('skills/thinking-partner');
    expect(s.cloneUrl.startsWith('file://')).toBe(true);
    expect(s.repo).toBe(s.cloneUrl);
  });

  it('errors (changing nothing) when no git repo exists at or above a file:// path', async () => {
    const r = await resolveSkillSource('file:///definitely/not/a/repo/skills/x');
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toContain('unreachable');
  });
});

describe('add.source: env.yaml provenance round-trip', () => {
  it('upserts a sources entry, preserving comments and round-tripping', () => {
    const yaml = scaffoldEnvYaml({ description: 'writing env' });
    const updated = upsertEnvSource(yaml, 'thinking-partner', {
      repo: 'acme/tools',
      path: 'skills/thinking-partner',
      ref: 'main',
      commit: 'a'.repeat(40),
      hash: 'deadbeef',
    });
    // Header comment survives the document edit.
    expect(updated).toContain('agentenv environment manifest');

    const cfg = parseEnvConfig(updated, 'env.yaml');
    expect(cfg.sources?.['thinking-partner']).toEqual({
      repo: 'acme/tools',
      path: 'skills/thinking-partner',
      ref: 'main',
      commit: 'a'.repeat(40),
      hash: 'deadbeef',
    });
  });

  it('replaces an existing entry rather than duplicating it', () => {
    let yaml = scaffoldEnvYaml({ description: 'x' });
    yaml = upsertEnvSource(yaml, 's', {
      repo: 'a/b',
      path: 'p',
      ref: 'r',
      commit: 'c',
      hash: 'h1',
    });
    yaml = upsertEnvSource(yaml, 's', {
      repo: 'a/b',
      path: 'p',
      ref: 'r',
      commit: 'c',
      hash: 'h2',
    });
    const cfg = parseEnvConfig(yaml, 'env.yaml');
    expect(Object.keys(cfg.sources ?? {})).toEqual(['s']);
    expect(cfg.sources?.['s']?.hash).toBe('h2');
  });
});
