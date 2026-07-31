import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import type { RunOptions } from '../src/command.js';
import { resolvePaths } from '../src/paths.js';
import type { ExecHarness, ExecSpec } from '../src/session/exec.js';
import { resolveProjectRoot, setBinding } from '../src/session/registry.js';
import { generateShims, shimScript } from '../src/session/shims.js';
import { FIXTURE_CONFIG_ENV, installFixtureHarness, makeFixtureAdapter } from './fixtures/fixture-adapter.js';
import { makeTempHome, type TempHome } from './helpers.js';

const homes: TempHome[] = [];
function home(): TempHome {
  const h = makeTempHome();
  homes.push(h);
  return h;
}
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
});

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

/** A temp home with the fixture harness on PATH and env 'writing' seeded. */
function withHarness(th: TempHome) {
  const paths = resolvePaths(th.env);
  const binDir = join(th.home, 'bin');
  installFixtureHarness(binDir);
  const envDir = paths.envDir('writing');
  mkdirSync(join(envDir, 'skills', 'w-skill'), { recursive: true });
  writeFileSync(join(envDir, 'skills', 'w-skill', 'SKILL.md'), '# w\n');
  const env: NodeJS.ProcessEnv = { ...th.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}` };
  return { paths, env };
}

describe('session shell-init command', () => {
  it('emits a hook that puts the shims dir on PATH and assigns a session id', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const res = await run(['shell-init'], { env: th.env });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(paths.shims);
    expect(res.stdout).toContain('PATH=');
    expect(res.stdout).toContain('AGENTENV_SESSION');
    expect(res.stdout).not.toContain('__shim'); // it emits the hook, not the shim
  });
});

describe('session shim generation', () => {
  it('writes one executable shim per adapter that delegates to agentenv __shim', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const written = await generateShims(paths, [makeFixtureAdapter()]);
    expect(written).toEqual([join(paths.shims, 'fixture-harness')]);
    const mode = statSync(written[0]!).mode & 0o111;
    expect(mode).not.toBe(0); // executable
    const body = readFileSync(written[0]!, 'utf8');
    expect(body).toContain('exec agentenv __shim');
    // Fallback path exists so a missing agentenv never bricks the tool.
    expect(body).toContain('command -v agentenv');
    expect(shimScript('claude', paths.shims)).toContain('agentenv __shim');
  });
});

describe('session run command', () => {
  it('AC: works with NO hook installed — composes a view and the harness prints the private root', async () => {
    const th = home();
    const { env } = withHarness(th);
    const { exec, calls, lastStdout } = capturingExec();
    const options: RunOptions = { env, cwd: th.home, adapters: [makeFixtureAdapter()], execHarness: exec };

    const res = await run(['run', 'writing', '--', 'fixture-harness', '--print-config-root'], options);
    expect(res.code).toBe(0);
    const viewRoot = calls[0]?.env[FIXTURE_CONFIG_ENV];
    expect(viewRoot).toBeTruthy();
    expect(lastStdout().trim()).toBe(viewRoot);
  });

  it('errors clearly on missing --, missing/unknown env, and unknown harness', async () => {
    const th = home();
    const { env } = withHarness(th);
    const options: RunOptions = { env, cwd: th.home, adapters: [makeFixtureAdapter()] };

    expect((await run(['run', 'writing', 'fixture-harness'], options)).code).toBe(1);
    expect((await run(['run', '--', 'fixture-harness'], options)).stderr).toContain('environment');
    expect((await run(['run', 'ghost', '--', 'fixture-harness'], options)).stderr).toContain(
      "environment 'ghost' does not exist",
    );
    const unknown = await run(['run', 'writing', '--', 'not-a-harness'], options);
    expect(unknown.stderr).toContain('no adapter');
  });
});

describe('session __shim command', () => {
  it('a bound shell composes a view and applies overrides; an unbound shell launches untouched', async () => {
    const th = home();
    const { paths, env } = withHarness(th);
    const projectRoot = await resolveProjectRoot(th.home);
    await setBinding(paths, { session: 'S1', projectRoot, envs: ['writing'] });

    const bound = capturingExec();
    const boundRes = await run(['__shim', 'fixture-harness', '--', '--print-config-root'], {
      env: { ...env, AGENTENV_SESSION: 'S1' },
      cwd: th.home,
      adapters: [makeFixtureAdapter()],
      execHarness: bound.exec,
    });
    expect(boundRes.code).toBe(0);
    expect(bound.calls[0]?.env[FIXTURE_CONFIG_ENV]).toBeTruthy();
    expect(bound.lastStdout().trim()).toBe(bound.calls[0]?.env[FIXTURE_CONFIG_ENV]);

    const unbound = capturingExec();
    await run(['__shim', 'fixture-harness', '--', '--print-config-root'], {
      env: { ...env, AGENTENV_SESSION: 'no-binding-here' },
      cwd: th.home,
      adapters: [makeFixtureAdapter()],
      execHarness: unbound.exec,
    });
    expect(unbound.calls[0]?.env[FIXTURE_CONFIG_ENV]).toBeUndefined();
  });

  it('AC: an unreadable session registry fails OPEN — launches unbound with a warning', async () => {
    const th = home();
    const { paths, env } = withHarness(th);
    mkdirSync(paths.base, { recursive: true });
    writeFileSync(join(paths.base, 'sessions.json'), '{ corrupt');
    const { exec, calls } = capturingExec();

    const res = await run(['__shim', 'fixture-harness', '--', '--print-config-root'], {
      env: { ...env, AGENTENV_SESSION: 'S1' },
      cwd: th.home,
      adapters: [makeFixtureAdapter()],
      execHarness: exec,
    });
    expect(res.code).toBe(0);
    expect(calls[0]?.env[FIXTURE_CONFIG_ENV]).toBeUndefined(); // untouched
    expect(res.stderr?.toLowerCase()).toContain('unbound');
  });

  it('an unknown harness (no adapter) execs the real binary untouched (fail open)', async () => {
    const th = home();
    const { env } = withHarness(th);
    const { exec, calls } = capturingExec();
    const res = await run(['__shim', 'fixture-harness', '--', '--print-config-root'], {
      env,
      cwd: th.home,
      adapters: [], // no adapter matches → unmanaged passthrough
      execHarness: exec,
    });
    expect(res.code).toBe(0);
    expect(calls[0]?.binaryPath).toContain('fixture-harness');
    expect(calls[0]?.env[FIXTURE_CONFIG_ENV]).toBeUndefined();
  });

  it('the internal __shim command is hidden from --help', async () => {
    const res = await run(['--help']);
    expect(res.stdout).toContain('run ');
    expect(res.stdout).toContain('shell-init');
    expect(res.stdout).not.toContain('__shim');
  });

  it('M1: a binding whose only env was deleted drops it and launches unbound with a notice', async () => {
    const th = home();
    const { paths, env } = withHarness(th);
    const projectRoot = await resolveProjectRoot(th.home);
    await setBinding(paths, { session: 'S1', projectRoot, envs: ['ghost'] });
    const { exec, calls } = capturingExec();

    const res = await run(['__shim', 'fixture-harness', '--', '--print-config-root'], {
      env: { ...env, AGENTENV_SESSION: 'S1' },
      cwd: th.home,
      adapters: [makeFixtureAdapter()],
      execHarness: exec,
    });
    expect(res.code).toBe(0);
    expect(calls[0]?.env[FIXTURE_CONFIG_ENV]).toBeUndefined(); // unbound — no override applied
    expect(res.stderr).toContain("environment 'ghost'");
    expect(res.stderr?.toLowerCase()).toContain('unbound');
  });

  it('M1: a partially-valid binding composes the surviving envs and warns about the missing one', async () => {
    const th = home();
    const { paths, env } = withHarness(th);
    const projectRoot = await resolveProjectRoot(th.home);
    await setBinding(paths, { session: 'S1', projectRoot, envs: ['writing', 'ghost'] });
    const { exec, calls } = capturingExec();

    const res = await run(['__shim', 'fixture-harness', '--', '--print-config-root'], {
      env: { ...env, AGENTENV_SESSION: 'S1' },
      cwd: th.home,
      adapters: [makeFixtureAdapter()],
      execHarness: exec,
    });
    expect(res.code).toBe(0);
    expect(calls[0]?.env[FIXTURE_CONFIG_ENV]).toBeTruthy(); // bound — surviving env composed
    expect(res.stderr).toContain("environment 'ghost'");
  });
});
