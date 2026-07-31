import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { resolvePaths } from '../src/paths.js';
import { approvalsPath, isApproved, readApprovals, recordApproval } from '../src/session/approvals.js';
import { makeTempHome, type TempHome } from './helpers.js';

const homes: TempHome[] = [];
const dirs: string[] = [];
function home(): TempHome {
  const h = makeTempHome();
  homes.push(h);
  return h;
}
/** A temp "project" directory; when `repo`, it carries a `.git` marker (worktree root). */
function projectDir(repo = true): string {
  const d = mkdtempSync(join(tmpdir(), 'agentenv-proj-'));
  if (repo) mkdirSync(join(d, '.git'));
  dirs.push(d);
  return d;
}
/** Seed an environment in the store so existence checks pass. */
function seedEnv(th: TempHome, name: string): void {
  mkdirSync(resolvePaths(th.env).envDir(name), { recursive: true });
}
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// dotagentenv — the `.agentenv` per-folder default (D16, spec criterion 10).
describe('dotagentenv: agentenv default command (D16)', () => {
  it('AC: `default <env>` writes .agentenv at the project root, one env per line', async () => {
    const th = home();
    seedEnv(th, 'writing');
    const proj = projectDir();

    const res = await run(['default', 'writing'], { env: th.env, cwd: join(proj, 'sub') });
    expect(res.code).toBe(0);
    // Written at the WORKTREE root, not the launch subdir (D16).
    expect(readFileSync(join(proj, '.agentenv'), 'utf8')).toBe('writing\n');
    expect(res.stdout).toContain('.agentenv');
    // No "does not exist" notice for a seeded env.
    expect(res.stderr ?? '').not.toContain('does not exist');
  });

  it('AC: `default a b` writes multiple env names, one per line, de-duplicated', async () => {
    const th = home();
    seedEnv(th, 'work');
    seedEnv(th, 'writing');
    const proj = projectDir();

    const res = await run(['default', 'work', 'writing', 'work'], { env: th.env, cwd: proj });
    expect(res.code).toBe(0);
    expect(readFileSync(join(proj, '.agentenv'), 'utf8')).toBe('work\nwriting\n');
  });

  it('AC: `default --remove` deletes the file; removing when absent is a friendly no-op', async () => {
    const th = home();
    seedEnv(th, 'writing');
    const proj = projectDir();
    await run(['default', 'writing'], { env: th.env, cwd: proj });
    expect(readFileSync(join(proj, '.agentenv'), 'utf8')).toBe('writing\n');

    const removed = await run(['default', '--remove'], { env: th.env, cwd: proj });
    expect(removed.code).toBe(0);
    expect(removed.stdout).toContain('Removed');
    expect(() => readFileSync(join(proj, '.agentenv'), 'utf8')).toThrow();

    const again = await run(['default', '--remove'], { env: th.env, cwd: proj });
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('No ');
  });

  it('rejects an invalid env name before writing anything', async () => {
    const th = home();
    const proj = projectDir();
    const res = await run(['default', 'Bad Name'], { env: th.env, cwd: proj });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('invalid environment name');
    expect(() => readFileSync(join(proj, '.agentenv'), 'utf8')).toThrow();
  });

  it('warns (does not fail) when a named env does not exist in this store, and still writes', async () => {
    const th = home();
    const proj = projectDir();
    const res = await run(['default', 'ghost'], { env: th.env, cwd: proj });
    expect(res.code).toBe(0); // fail-soft: the file is shared, the env may exist elsewhere
    expect(res.stderr).toContain("environment 'ghost' does not exist");
    expect(readFileSync(join(proj, '.agentenv'), 'utf8')).toBe('ghost\n');
  });

  it('records approval for THIS machine (the write is the user\'s explicit local act)', async () => {
    const th = home();
    seedEnv(th, 'writing');
    const proj = projectDir();
    expect(await isApproved(resolvePaths(th.env), proj)).toBe(false);

    await run(['default', 'writing'], { env: th.env, cwd: proj });
    expect(await isApproved(resolvePaths(th.env), proj)).toBe(true);
  });

  it('errors on --remove combined with env names, and on a missing name', async () => {
    const th = home();
    const proj = projectDir();
    expect((await run(['default', '--remove', 'writing'], { env: th.env, cwd: proj })).code).toBe(1);
    expect((await run(['default'], { env: th.env, cwd: proj })).stderr).toContain('missing environment');
  });
});

describe('dotagentenv: approvals store', () => {
  it('an absent store reads empty; recordApproval round-trips and is idempotent', async () => {
    const paths = resolvePaths(home().env);
    expect((await readApprovals(paths)).approvals).toEqual({});

    await recordApproval(paths, '/repo/a', () => 111);
    expect(await isApproved(paths, '/repo/a')).toBe(true);
    expect(await isApproved(paths, '/repo/b')).toBe(false);

    await recordApproval(paths, '/repo/a', () => 222); // idempotent — keeps first stamp
    expect((await readApprovals(paths)).approvals['/repo/a']?.approvedAt).toBe(111);
  });

  it('isApproved is fail-safe: a corrupt store reads as NOT approved (never throws)', async () => {
    const paths = resolvePaths(home().env);
    mkdirSync(paths.base, { recursive: true });
    writeFileSync(approvalsPath(paths), '{ not json');
    await expect(readApprovals(paths)).rejects.toThrow();
    expect(await isApproved(paths, '/anything')).toBe(false);
  });
});
