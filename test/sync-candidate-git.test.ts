import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultGitRunner, type GitRunner } from '../src/git.js';
import { resolvePaths } from '../src/paths.js';
import { readState } from '../src/state.js';
import { promoteSyncCandidate } from '../src/sync-candidate-git.js';

const dirs: string[] = [];
const gitEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'candidate-wal-test',
  GIT_AUTHOR_EMAIL: 'candidate-wal@test.invalid',
  GIT_COMMITTER_NAME: 'candidate-wal-test',
  GIT_COMMITTER_EMAIL: 'candidate-wal@test.invalid',
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, env: gitEnv, encoding: 'utf8' }).trim();
}

function scenario(): {
  paths: ReturnType<typeof resolvePaths>;
  env: NodeJS.ProcessEnv;
  worktree: string;
  expected: string;
  revision: string;
  changed: string;
  removed: string;
} {
  const base = mkdtempSync(join(tmpdir(), 'agentenv-candidate-wal-'));
  dirs.push(base);
  const env = { ...gitEnv, AGENTENV_HOME: base };
  const paths = resolvePaths(env);
  mkdirSync(paths.store, { recursive: true });
  git(paths.store, ['init', '-b', 'main']);
  const changed = 'environments/work/env.yaml';
  const removed = 'environments/work/obsolete.md';
  mkdirSync(join(paths.store, 'environments', 'work'), { recursive: true });
  writeFileSync(join(paths.store, changed), 'version: "1.0"\ndescription: old\n');
  writeFileSync(join(paths.store, removed), 'obsolete\n');
  git(paths.store, ['add', '-A']);
  git(paths.store, ['commit', '-m', 'old']);
  const expected = git(paths.store, ['rev-parse', 'HEAD']);

  const worktree = join(base, 'candidate-worktree');
  git(paths.store, ['worktree', 'add', '--detach', worktree, expected]);
  writeFileSync(join(worktree, changed), 'version: "1.0"\ndescription: candidate\n');
  rmSync(join(worktree, removed));
  git(worktree, ['add', '-A']);
  git(worktree, ['commit', '-m', 'candidate']);
  const revision = git(worktree, ['rev-parse', 'HEAD']);
  return { paths, env, worktree, expected, revision, changed, removed };
}

describe('sync candidate WAL promotion', () => {
  it('retains committed candidate bytes when Git bookkeeping fails, then resumes without replay', async () => {
    const { paths, env, worktree, expected, revision, changed, removed } = scenario();
    let resetAttempts = 0;
    const failResetOnce: GitRunner = (args, options) => {
      if (args[0] === 'reset' && args[1] === '--mixed') {
        resetAttempts += 1;
        return Promise.resolve({
          code: 1,
          stdout: '',
          stderr: 'fatal: injected candidate reset failure',
          timedOut: false,
        });
      }
      return defaultGitRunner(args, options);
    };

    await expect(
      promoteSyncCandidate({
        paths,
        env,
        id: 'candidate-one',
        worktree,
        touchedCanonicalPaths: [changed, removed],
        expectedHead: expected,
        revision,
        run: failResetOnce,
      }),
    ).rejects.toThrow(/candidate reset failure/i);

    expect(resetAttempts).toBe(1);
    expect(readFileSync(join(paths.store, changed), 'utf8')).toContain('candidate');
    expect(existsSync(join(paths.store, removed))).toBe(false);
    expect(git(paths.store, ['rev-parse', 'HEAD'])).toBe(expected);
    expect((await readState(paths)).commands).toMatchObject([
      {
        transactionId: 'candidate-candidate-one',
        phase: 'git-pending',
        commitPoint: true,
        gitRequired: true,
      },
    ]);

    const resumed = await promoteSyncCandidate({
      paths,
      env,
      id: 'candidate-one',
      worktree,
      touchedCanonicalPaths: [changed, removed],
      expectedHead: expected,
      revision,
    });

    expect(resumed.status).toBe('promoted');
    expect(git(paths.store, ['rev-parse', 'HEAD'])).toBe(revision);
    expect(git(paths.store, ['status', '--porcelain'])).toBe('');
    expect((await readState(paths)).commands).toEqual([]);
  });

  it('rolls every candidate path back when publication faults before the command commit point', async () => {
    const { paths, env, worktree, expected, revision, changed, removed } = scenario();

    await expect(
      promoteSyncCandidate({
        paths,
        env,
        id: 'candidate-two',
        worktree,
        touchedCanonicalPaths: [changed, removed],
        expectedHead: expected,
        revision,
        afterApply: async (entry) => {
          if (entry.id === 'candidate-1') throw new Error('injected candidate publication failure');
        },
      }),
    ).rejects.toThrow(/candidate publication failure/i);

    expect(readFileSync(join(paths.store, changed), 'utf8')).toContain('description: old');
    expect(readFileSync(join(paths.store, removed), 'utf8')).toBe('obsolete\n');
    expect(git(paths.store, ['rev-parse', 'HEAD'])).toBe(expected);
    expect(git(paths.store, ['status', '--porcelain'])).toBe('');
    expect((await readState(paths)).commands).toEqual([]);
  });
});
