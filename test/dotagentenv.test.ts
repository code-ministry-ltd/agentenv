import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import type { RunOptions } from '../src/command.js';
import { resolvePaths } from '../src/paths.js';
import type { ExecHarness, ExecSpec } from '../src/session/exec.js';
import { approvalsPath, isApproved, readApprovals, recordApproval } from '../src/session/approvals.js';
import {
  parseAgentenvEnvs,
  resolveProjectRoot,
  resolveSessionBinding,
  setBinding,
} from '../src/session/registry.js';
import { FIXTURE_CONFIG_ENV, installFixtureHarness, makeFixtureAdapter } from './fixtures/fixture-adapter.js';
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

describe('dotagentenv: parseAgentenvEnvs', () => {
  it('reads one env per line; ignores blanks and # comments; de-dups; drops invalid names', () => {
    expect(parseAgentenvEnvs('writing\n')).toEqual(['writing']);
    expect(parseAgentenvEnvs('# a comment\nwork\n\n  writing  \nwork\n')).toEqual(['work', 'writing']);
    // 'Bad Name' and '../escape' are not valid env names → dropped (path-safety gate).
    expect(parseAgentenvEnvs('Bad Name\n../escape\nok\n')).toEqual(['ok']);
    expect(parseAgentenvEnvs('\n\n')).toEqual([]);
  });
});

describe('dotagentenv: resolveSessionBinding pickup (D16 precedence + approval)', () => {
  /** A repo project dir with an `.agentenv` naming `names`. */
  function repoWithAgentenv(...names: string[]): string {
    const proj = projectDir();
    writeFileSync(join(proj, '.agentenv'), `${names.join('\n')}\n`);
    return proj;
  }

  it('an APPROVED .agentenv binds its env stack at session scope (source agentenv-file)', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const proj = repoWithAgentenv('writing');
    await recordApproval(paths, proj);

    const resolved = await resolveSessionBinding({
      paths,
      session: 'shell-with-no-binding',
      projectRoot: await resolveProjectRoot(proj),
      env: th.env,
    });
    expect(resolved.source).toBe('agentenv-file');
    expect(resolved.binding?.envs).toEqual(['writing']);
    expect(resolved.binding?.global).toBe(false);
  });

  it('an UNAPPROVED .agentenv with NO approve seam is inert (non-interactive → notice, source none)', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const proj = repoWithAgentenv('writing');

    const resolved = await resolveSessionBinding({
      paths,
      session: 's1',
      projectRoot: await resolveProjectRoot(proj),
      env: th.env,
    });
    expect(resolved.source).toBe('none');
    expect(resolved.note).toContain('one-time');
    expect(await isApproved(paths, proj)).toBe(false); // never auto-approved
  });

  it('the approve seam grants a one-time approval, records it, then binds', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const proj = repoWithAgentenv('writing');
    let asked = 0;

    const first = await resolveSessionBinding({
      paths,
      session: 's1',
      projectRoot: await resolveProjectRoot(proj),
      env: th.env,
      approve: async () => {
        asked += 1;
        return true;
      },
    });
    expect(first.source).toBe('agentenv-file');
    expect(asked).toBe(1);
    expect(await isApproved(paths, proj)).toBe(true);

    // Second time it is already approved — no prompt, still binds.
    const second = await resolveSessionBinding({
      paths,
      session: 's1',
      projectRoot: await resolveProjectRoot(proj),
      env: th.env,
      approve: async () => {
        asked += 1;
        return true;
      },
    });
    expect(second.source).toBe('agentenv-file');
    expect(asked).toBe(1); // not asked again
  });

  it('a declined approval leaves it inert with a notice', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const proj = repoWithAgentenv('writing');
    const resolved = await resolveSessionBinding({
      paths,
      session: 's1',
      projectRoot: await resolveProjectRoot(proj),
      env: th.env,
      approve: async () => false,
    });
    expect(resolved.source).toBe('none');
    expect(await isApproved(paths, proj)).toBe(false);
  });

  it('AC: an explicit `use` binding WINS over an approved .agentenv (precedence)', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const proj = repoWithAgentenv('writing');
    const projectRoot = await resolveProjectRoot(proj);
    await recordApproval(paths, proj);
    await setBinding(paths, { session: 'S1', projectRoot, envs: ['work'] });

    const resolved = await resolveSessionBinding({ paths, session: 'S1', projectRoot, env: th.env });
    expect(resolved.source).toBe('explicit');
    expect(resolved.binding?.envs).toEqual(['work']); // explicit, not the file's 'writing'
  });

  it('an empty .agentenv is inert with a notice (no env named)', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const proj = projectDir();
    writeFileSync(join(proj, '.agentenv'), '\n# nothing\n');
    const resolved = await resolveSessionBinding({
      paths,
      session: 's1',
      projectRoot: await resolveProjectRoot(proj),
      env: th.env,
      approve: async () => true,
    });
    expect(resolved.source).toBe('none');
    expect(resolved.note).toContain('no environment');
  });
});

describe('dotagentenv: shim pickup end-to-end (spec criterion 10)', () => {
  function capturingExec(): { exec: ExecHarness; calls: ExecSpec[]; lastStdout: () => string } {
    const calls: ExecSpec[] = [];
    let stdout = '';
    const exec: ExecHarness = async (spec) => {
      calls.push(spec);
      const r = spawnSync(spec.binaryPath, [...spec.args], { env: spec.env, encoding: 'utf8' });
      stdout = r.stdout ?? '';
      return r.status ?? 0;
    };
    return { exec, calls, lastStdout: () => stdout };
  }

  /** A repo project dir + fixture harness on PATH + `writing` seeded in the store. */
  function scenario(th: TempHome): { env: NodeJS.ProcessEnv; proj: string } {
    seedEnv(th, 'writing');
    const binDir = join(th.home, 'bin');
    installFixtureHarness(binDir);
    const env: NodeJS.ProcessEnv = { ...th.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}` };
    const proj = projectDir();
    return { env, proj };
  }

  const shimArgs = ['__shim', 'fixture-harness', '--', '--print-config-root'] as const;

  it('AC: an APPROVED folder — a shim launch with NO shell binding activates the .agentenv env', async () => {
    const th = home();
    const { env, proj } = scenario(th);
    // `agentenv default` writes the file AND approves it on this machine.
    await run(['default', 'writing'], { env, cwd: proj });

    const { exec, calls, lastStdout } = capturingExec();
    const res = await run([...shimArgs], {
      env: { ...env, AGENTENV_SESSION: 'shell-never-ran-use' },
      cwd: proj,
      adapters: [makeFixtureAdapter()],
      execHarness: exec,
    });
    expect(res.code).toBe(0);
    // The override was applied and the real fixture harness observed the private view.
    const viewRoot = calls[0]?.env[FIXTURE_CONFIG_ENV];
    expect(viewRoot).toBeTruthy();
    expect(lastStdout().trim()).toBe(viewRoot); // adapter self-check probe equivalent
    expect(res.stderr).toContain('applying .agentenv default [writing]');
  });

  it('approval persists — a SECOND launch with no confirm still binds (no re-prompt)', async () => {
    const th = home();
    const { env, proj } = scenario(th);
    await run(['default', 'writing'], { env, cwd: proj });

    const { exec, calls } = capturingExec();
    // A subdir launch (walks up to the worktree root to find the file).
    mkdirSync(join(proj, 'src'), { recursive: true });
    await run([...shimArgs], {
      env: { ...env, AGENTENV_SESSION: 'another-shell' },
      cwd: join(proj, 'src'),
      adapters: [makeFixtureAdapter()],
      execHarness: exec,
    });
    expect(calls[0]?.env[FIXTURE_CONFIG_ENV]).toBeTruthy();
  });

  it('AC: an UNAPPROVED clone does nothing non-interactively — launches untouched with a notice', async () => {
    const th = home();
    const { env, proj } = scenario(th);
    // Simulate a fresh clone: the file is present but this machine never approved it.
    writeFileSync(join(proj, '.agentenv'), 'writing\n');

    const { exec, calls } = capturingExec();
    const res = await run([...shimArgs], {
      env: { ...env, AGENTENV_SESSION: 'clone-shell' },
      cwd: proj,
      adapters: [makeFixtureAdapter()],
      execHarness: exec,
      // No `confirm` seam → non-interactive → never auto-approves.
    });
    expect(res.code).toBe(0);
    expect(calls[0]?.env[FIXTURE_CONFIG_ENV]).toBeUndefined(); // untouched, unbound
    expect(res.stderr).toContain('one-time');
    expect(await isApproved(resolvePaths(th.env), proj)).toBe(false);
  });

  it('an unapproved clone approved AT LAUNCH via the confirm seam binds and records approval', async () => {
    const th = home();
    const { env, proj } = scenario(th);
    writeFileSync(join(proj, '.agentenv'), 'writing\n');

    const { exec, calls } = capturingExec();
    const options: RunOptions = {
      env: { ...env, AGENTENV_SESSION: 'clone-shell' },
      cwd: proj,
      adapters: [makeFixtureAdapter()],
      execHarness: exec,
      confirm: async () => true, // the user approves at the prompt
    };
    await run([...shimArgs], options);
    expect(calls[0]?.env[FIXTURE_CONFIG_ENV]).toBeTruthy(); // bound
    expect(await isApproved(resolvePaths(th.env), proj)).toBe(true);
  });

  it('AC: a .agentenv naming a MISSING env → launch proceeds unbound with a warning naming it', async () => {
    const th = home();
    const { env, proj } = scenario(th);
    await run(['default', 'ghost'], { env, cwd: proj }); // writes + approves 'ghost'

    const { exec, calls } = capturingExec();
    const res = await run([...shimArgs], {
      env: { ...env, AGENTENV_SESSION: 'a-shell' },
      cwd: proj,
      adapters: [makeFixtureAdapter()],
      execHarness: exec,
    });
    expect(res.code).toBe(0);
    expect(calls[0]?.env[FIXTURE_CONFIG_ENV]).toBeUndefined(); // unbound — never fails the launch
    expect(res.stderr).toContain("'ghost'");
  });

  it('AC: an explicit `use` binding wins over the .agentenv at the shim (no pickup notice)', async () => {
    const th = home();
    const { env, proj } = scenario(th);
    await run(['default', 'writing'], { env, cwd: proj });
    const projectRoot = await resolveProjectRoot(proj);
    await setBinding(resolvePaths(th.env), { session: 'S1', projectRoot, envs: ['writing'] });

    const { exec, calls } = capturingExec();
    const res = await run([...shimArgs], {
      env: { ...env, AGENTENV_SESSION: 'S1' },
      cwd: proj,
      adapters: [makeFixtureAdapter()],
      execHarness: exec,
    });
    expect(calls[0]?.env[FIXTURE_CONFIG_ENV]).toBeTruthy(); // bound (via explicit)
    expect(res.stderr ?? '').not.toContain('applying .agentenv default'); // explicit path, not pickup
  });
});
