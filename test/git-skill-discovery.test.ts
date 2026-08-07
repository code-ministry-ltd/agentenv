import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  discoverGitSkills,
  type GitSkillDiscovery,
} from '../src/application/git-skill-discovery.js';
import { defaultGitRunner } from '../src/git.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers.js';

describe('shared Git skill discovery', () => {
  const repos: FixtureRepo[] = [];
  const leases: GitSkillDiscovery[] = [];

  afterEach(async () => {
    await Promise.all(leases.splice(0).map((lease) => lease.release()));
    for (const repo of repos.splice(0)) repo.cleanup();
  });

  it('resolves exact commit and repo-path metadata without exposing clone paths', async () => {
    const repo = makeFixtureRepo();
    repos.push(repo);
    repo.writeSkill('skills/alpha', { description: 'Alpha does A.' });
    repo.writeSkill('skills/beta', { description: 'Beta does B.' });
    const commit = repo.commit('skills');

    const result = await discoverGitSkills({
      source: repo.fileUrl('skills'),
      cwd: process.cwd(),
      env: process.env,
      offline: true,
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    leases.push(result.discovery);

    expect(result.discovery.source).toEqual({
      repo: repo.fileUrl(),
      ref: 'main',
      commit,
    });
    expect(result.discovery.candidates).toEqual([
      {
        name: 'alpha',
        description: 'Alpha does A.',
        repoPath: 'skills/alpha',
        validation: { status: 'valid' },
      },
      {
        name: 'beta',
        description: 'Beta does B.',
        repoPath: 'skills/beta',
        validation: { status: 'valid' },
      },
    ]);
    expect(JSON.stringify(result.discovery.candidates)).not.toContain('agentenv-skill-clone-');

    const alphaDir = result.discovery.candidateDirectory(
      result.discovery.candidates[0]!,
    );
    expect(await readFile(join(alphaDir, 'SKILL.md'), 'utf8')).toContain('name: alpha');
    await result.discovery.release();
    await expect(access(alphaDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('supports an offline raw local repository path and the injected Git environment', async () => {
    const repo = makeFixtureRepo();
    repos.push(repo);
    repo.writeSkill('collection/local-skill');
    const commit = repo.commit('local skill');
    const observedMarkers: Array<string | undefined> = [];

    const result = await discoverGitSkills({
      source: join(repo.dir, 'collection'),
      cwd: process.cwd(),
      env: { ...process.env, AGENTENV_DISCOVERY_MARKER: 'injected' },
      offline: true,
      gitRun: async (args, options) => {
        observedMarkers.push(options.env.AGENTENV_DISCOVERY_MARKER);
        return defaultGitRunner(args, options);
      },
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    leases.push(result.discovery);

    expect(observedMarkers.length).toBeGreaterThan(0);
    expect(observedMarkers.every((marker) => marker === 'injected')).toBe(true);
    expect(result.discovery.source.commit).toBe(commit);
    expect(result.discovery.candidates.map((candidate) => candidate.repoPath))
      .toEqual(['collection/local-skill']);
  });

  it('reports invalid candidates but refuses network sources while offline without cloning', async () => {
    const repo = makeFixtureRepo();
    repos.push(repo);
    repo.writeSkill('skills/wrong-folder', { name: 'different-name' });
    repo.commit('invalid skill');

    const local = await discoverGitSkills({
      source: repo.fileUrl('skills'),
      cwd: process.cwd(),
      env: process.env,
      offline: true,
    });
    expect(local.status).toBe('ready');
    if (local.status === 'ready') {
      leases.push(local.discovery);
      expect(local.discovery.candidates[0]?.validation.status).toBe('invalid');
    }

    let gitCalls = 0;
    const network = await discoverGitSkills({
      source: 'code-ministry-ltd/agentenv/skills',
      cwd: process.cwd(),
      env: process.env,
      offline: true,
      gitRun: async () => {
        gitCalls += 1;
        throw new Error('must not run');
      },
    });
    expect(network).toEqual({
      status: 'failure',
      kind: 'offline',
      message: 'network git sources are disabled by --offline',
    });
    expect(gitCalls).toBe(0);
  });

  it('cleans failed fetches and never includes a private temp clone path in errors', async () => {
    const result = await discoverGitSkills({
      source: 'file:///no/such/private/repository/skills',
      cwd: process.cwd(),
      env: process.env,
      offline: true,
    });
    expect(result.status).toBe('failure');
    if (result.status !== 'failure') return;
    expect(result.message).not.toContain('agentenv-skill-clone-');
    expect(result.message).not.toContain('/var/folders/');
  });
});
