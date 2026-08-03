import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { dematerialiseGlobal, materialiseGlobal } from '../src/engine.js';
import { resolvePaths } from '../src/paths.js';
import { beginCandidateValidation, createSyncCandidate, rejectCandidate } from '../src/sync-candidate.js';
import { readState, writeState } from '../src/state.js';
import { FIXTURE_CONFIG_ENV, makeFixtureAdapter } from './fixtures/fixture-adapter.js';
import { makeTempHome, type TempHome } from './helpers.js';

const homes: TempHome[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) home.cleanup();
});

describe('resolve: explicit retained lifecycle resolution', () => {
  it('requires quiescence before reconciling a retired global projection', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const realRoot = join(home.home, 'real');
    const canonical = join(paths.envDir('writing'), 'skills', 'w-skill', 'SKILL.md');
    mkdirSync(join(canonical, '..'), { recursive: true });
    writeFileSync(canonical, '# original\n');
    const env = { ...home.env, [FIXTURE_CONFIG_ENV]: realRoot };
    const adapter = makeFixtureAdapter();
    await materialiseGlobal({ paths, adapters: [adapter], envs: ['writing'], env });
    await dematerialiseGlobal({ paths, adapters: [adapter], envs: ['writing'], all: true, env });
    const projection = (await readState(paths)).globalProjections.find(
      (entry) => entry.canonicalPath === join(paths.envDir('writing'), 'skills', 'w-skill'),
    )!;
    writeFileSync(join(projection.retainedPath!, 'SKILL.md'), '# retained edit\n');

    const refused = await run(['resolve', 'projection', projection.id], { env });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/quiescent/i);
    expect(readFileSync(canonical, 'utf8')).toBe('# original\n');

    const resolved = await run(
      ['resolve', 'projection', projection.id, '--quiescent'],
      { env },
    );
    expect(resolved.code).toBe(0);
    expect(readFileSync(canonical, 'utf8')).toBe('# retained edit\n');
    expect(existsSync(projection.retainedPath!)).toBe(true);
  });

  it('abandons a rejected candidate without deleting its retained worktree', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const worktree = join(paths.live, 'candidates', 'candidate-1');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, 'README.md'), 'retained\n');
    const state = await readState(paths);
    state.candidates.push(
      rejectCandidate(
        beginCandidateValidation(
          createSyncCandidate({
            id: 'candidate-1',
            ref: 'refs/agentenv/candidates/candidate-1',
            worktree,
            fetchedAt: 1,
            touchedCanonicalPaths: [],
          }),
        ),
        'invalid candidate',
      ),
    );
    await writeState(paths, state);

    const result = await run(['resolve', 'candidate', 'candidate-1', '--abandon'], {
      env: home.env,
    });
    expect(result.code).toBe(0);
    expect((await readState(paths)).candidates[0]?.phase).toBe('abandoned');
    expect(readFileSync(join(worktree, 'README.md'), 'utf8')).toBe('retained\n');
  });

  it('acknowledges a rescue without collecting its retained bytes', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const retainedPath = join(paths.live, 'quarantine', 'rescue-1', 'content');
    mkdirSync(join(retainedPath, '..'), { recursive: true });
    writeFileSync(retainedPath, 'recoverable bytes\n');
    const state = await readState(paths);
    state.quarantine.push({
      schemaVersion: 2,
      id: 'rescue-1',
      kind: 'third-identity',
      path: '/original',
      retainedPath,
      reason: 'retained',
      createdAt: 1,
      resolved: false,
    });
    await writeState(paths, state);

    const result = await run(['resolve', 'rescue', 'rescue-1', '--acknowledge'], {
      env: home.env,
    });
    expect(result.code).toBe(0);
    expect((await readState(paths)).quarantine[0]?.resolved).toBe(true);
    expect(readFileSync(retainedPath, 'utf8')).toBe('recoverable bytes\n');
  });
});
