import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  importGitSkills,
  type ExactGitSkillImport,
} from '../src/application/git-skill-import.js';
import { createUiContentTransferRuntime } from '../src/ui/content-transfer-runtime.js';
import { createContentTransferRuntime } from '../src/application/content-transfer-runtime.js';
import { discoverGitSkills, type GitSkillDiscovery } from '../src/application/git-skill-discovery.js';
import { run } from '../src/cli.js';
import { parseEnvConfig } from '../src/env-config.js';
import { resolvePaths } from '../src/paths.js';
import { makeFixtureRepo, makeTempHome, type FixtureRepo, type TempHome } from './helpers.js';

describe('exact Git skill import', () => {
  let temp: TempHome;
  let env: NodeJS.ProcessEnv;
  let repo: FixtureRepo;
  const discoveries: GitSkillDiscovery[] = [];

  beforeEach(async () => {
    temp = makeTempHome();
    env = {
      ...process.env,
      ...temp.env,
      GIT_AUTHOR_NAME: 'agentenv-test',
      GIT_AUTHOR_EMAIL: 'test@agentenv.invalid',
      GIT_COMMITTER_NAME: 'agentenv-test',
      GIT_COMMITTER_EMAIL: 'test@agentenv.invalid',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    };
    expect((await run(['create', 'writing'], { env })).code).toBe(0);
    const store = resolvePaths(env).store;
    execFileSync('git', ['init', '-b', 'main'], { cwd: store, env });
    execFileSync('git', ['add', '--', '.'], { cwd: store, env });
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', 'initial'], {
      cwd: store,
      env,
    });
    repo = makeFixtureRepo();
  });

  afterEach(async () => {
    await Promise.all(discoveries.splice(0).map((discovery) => discovery.release()));
    repo.cleanup();
    temp.cleanup();
  });

  async function discover(): Promise<GitSkillDiscovery> {
    const result = await discoverGitSkills({
      source: repo.fileUrl('skills'),
      cwd: process.cwd(),
      env,
      offline: true,
    });
    if (result.status !== 'ready') throw new Error(result.message);
    discoveries.push(result.discovery);
    return result.discovery;
  }

  function selected(
    discovery: GitSkillDiscovery,
    names: readonly string[],
    collision: 'skip' | 'overwrite' = 'skip',
  ): ExactGitSkillImport[] {
    return discovery.candidates
      .filter((candidate) => names.includes(candidate.name))
      .map((candidate, index) => ({
        candidateId: `candidate-${index}`,
        candidate,
        sourceDirectory: discovery.candidateDirectory(candidate),
        source: discovery.source,
        collision,
      }));
  }

  it('installs exact selected content with provenance and candidate-specific collisions', async () => {
    repo.writeSkill('skills/alpha', { body: '# alpha\n\nVersion one.\n' });
    repo.writeSkill('skills/gamma');
    repo.commit('first');
    const first = await discover();
    const paths = resolvePaths(env);

    const installed = await importGitSkills({
      paths,
      environment: 'writing',
      imports: selected(first, ['alpha']),
      runtime: createUiContentTransferRuntime({ paths, env }),
    });
    expect(installed).toEqual(expect.objectContaining({
      status: 'complete',
      outcomes: [expect.objectContaining({
        name: 'alpha', status: 'installed', publication: 'complete',
      })],
    }));
    expect(existsSync(join(paths.envDir('writing'), 'skills', 'gamma'))).toBe(false);

    repo.writeSkill('skills/alpha', { body: '# alpha\n\nVersion two.\n' });
    repo.writeSkill('skills/beta');
    repo.commit('second');
    const second = await discover();
    const mixed = await importGitSkills({
      paths,
      environment: 'writing',
      imports: selected(second, ['alpha', 'beta']),
      runtime: createUiContentTransferRuntime({ paths, env }),
    });
    expect(mixed).toMatchObject({
      status: 'complete',
      outcomes: [
        { name: 'alpha', status: 'skipped', reason: 'collision' },
        { name: 'beta', status: 'installed' },
      ],
    });
    expect(readFileSync(join(paths.envDir('writing'), 'skills', 'alpha', 'SKILL.md'), 'utf8'))
      .toContain('Version one.');

    const overwritten = await importGitSkills({
      paths,
      environment: 'writing',
      imports: selected(second, ['alpha'], 'overwrite'),
      runtime: createUiContentTransferRuntime({ paths, env }),
    });
    expect(overwritten).toMatchObject({
      status: 'complete',
      outcomes: [{ name: 'alpha', status: 'installed' }],
    });
    expect(readFileSync(join(paths.envDir('writing'), 'skills', 'alpha', 'SKILL.md'), 'utf8'))
      .toContain('Version two.');
    const config = parseEnvConfig(readFileSync(paths.envYaml('writing'), 'utf8'), 'env.yaml');
    expect(config.sources?.alpha).toMatchObject({
      repo: repo.fileUrl(),
      path: 'skills/alpha',
      commit: repo.head(),
    });
    expect(config.sources?.beta?.path).toBe('skills/beta');
    const history = execFileSync('git', ['log', '--format=%s', '--', 'environments/writing/skills'], {
      cwd: paths.store,
      env,
      encoding: 'utf8',
    });
    expect(history).toContain('agentenv: import Git skill alpha into writing');
    expect(history).toContain('agentenv: import Git skill beta into writing');
  });

  it('rejects candidate substitution without changing the environment', async () => {
    repo.writeSkill('skills/alpha');
    repo.commit('candidate');
    const discovery = await discover();
    const imports = selected(discovery, ['alpha']);
    writeFileSync(join(imports[0]!.sourceDirectory, 'extra.md'), 'substituted\n');
    const paths = resolvePaths(env);

    const result = await importGitSkills({
      paths,
      environment: 'writing',
      imports,
      runtime: createUiContentTransferRuntime({ paths, env }),
    });
    expect(result).toMatchObject({
      status: 'complete',
      outcomes: [{ name: 'alpha', status: 'failed', reason: 'candidate-changed' }],
    });
    expect(existsSync(join(paths.envDir('writing'), 'skills', 'alpha'))).toBe(false);
  });

  it('reports a Git-pending first import and truthfully fails the remaining selection', async () => {
    repo.writeSkill('skills/alpha');
    repo.writeSkill('skills/beta');
    repo.commit('pending candidates');
    const discovery = await discover();
    const paths = resolvePaths(env);
    const result = await importGitSkills({
      paths,
      environment: 'writing',
      imports: selected(discovery, ['alpha', 'beta']),
      runtime: createContentTransferRuntime({
        paths,
        gitBookkeeping: async () => {
          throw new Error('injected Git failure');
        },
      }),
    });

    expect(result).toMatchObject({
      status: 'complete',
      outcomes: [
        { name: 'alpha', status: 'installed', publication: 'git-pending' },
        { name: 'beta', status: 'failed', reason: 'publication' },
      ],
    });
    expect(existsSync(join(paths.envDir('writing'), 'skills', 'alpha', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(paths.envDir('writing'), 'skills', 'beta'))).toBe(false);
  });
});
