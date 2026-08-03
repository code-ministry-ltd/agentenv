import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { defaultGitRunner, type GitRunner } from '../src/git.js';
import { resolvePaths } from '../src/paths.js';
import { writeSecrets } from '../src/secrets.js';
import type { ExecHarness, ExecSpec } from '../src/session/exec.js';
import { launchHarness, type LaunchRequest } from '../src/session/launch.js';
import { readState } from '../src/state.js';
import type { ProcessIdentity } from '../src/view-generation.js';
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

/** An injected exec that really spawns the (fixture) binary and captures stdout. */
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

/** Build a temp environment with the fixture harness on PATH and a seeded env. */
function scenario(th: TempHome, opts: { seedEnv?: boolean; realRoot?: string } = {}) {
  const paths = resolvePaths(th.env);
  const binDir = join(th.home, 'bin');
  installFixtureHarness(binDir);
  if (opts.seedEnv !== false) {
    const envDir = paths.envDir('writing');
    mkdirSync(join(envDir, 'skills', 'w-skill'), { recursive: true });
    writeFileSync(join(envDir, 'skills', 'w-skill', 'SKILL.md'), '# w\n');
  }
  const env: NodeJS.ProcessEnv = {
    ...th.env,
    PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
  };
  if (opts.realRoot) env[FIXTURE_CONFIG_ENV] = opts.realRoot;
  return { paths, env };
}

function req(partial: Partial<LaunchRequest> & Pick<LaunchRequest, 'paths' | 'adapter' | 'env'>): LaunchRequest {
  return {
    envs: ['writing'],
    session: 'sess-1',
    args: ['--print-config-root'],
    cwd: partial.paths.base,
    ...partial,
  } as LaunchRequest;
}

describe('session launch', () => {
  it('AC: a bound launch composes a view, self-check passes, and execs with overrides; harness prints the private root', async () => {
    const th = home();
    const { paths, env } = scenario(th);
    const { exec, calls, lastStdout } = capturingExec();

    const result = await launchHarness(req({ paths, adapter: makeFixtureAdapter(), env, execHarness: exec }));

    expect(result.mode).toBe('applied');
    expect(result.applied).toBe(true);
    expect(result.code).toBe(0);
    // Overrides were applied and point at the composed view.
    expect(calls[0]?.env[FIXTURE_CONFIG_ENV]).toBe(result.viewRoot);
    // The real fixture harness, launched under the overrides, printed that root.
    expect(lastStdout().trim()).toBe(result.viewRoot);
  });

  it('durably reserves a generation before spawn, leases its process group, and sweeps it after exit', async () => {
    const th = home();
    const { paths, env } = scenario(th);
    let generationId = '';
    const identity: ProcessIdentity = {
      processGroupId: 4100,
      pid: 4101,
      processStart: 'fixture-start-4101',
    };
    const exec: ExecHarness = async (spec) => {
      const beforeSpawn = await readState(paths);
      const active = beforeSpawn.generations.find((generation) =>
        generation.reservations.length === 1,
      );
      expect(active).toMatchObject({ phase: 'published', envs: ['writing'] });
      expect(active?.inventory?.length).toBeGreaterThan(0);
      generationId = active?.id ?? '';

      const onSpawn = (spec as ExecSpec & {
        onSpawn?: (spawned: ProcessIdentity) => Promise<void>;
      }).onSpawn;
      expect(onSpawn).toBeTypeOf('function');
      await onSpawn?.(identity);

      const leased = (await readState(paths)).generations.find((g) => g.id === generationId);
      expect(leased?.reservations).toEqual([]);
      expect(leased?.leases).toEqual([{ reservationId: expect.any(String), ...identity }]);
      return 0;
    };

    const result = await launchHarness(
      req({ paths, adapter: makeFixtureAdapter(), env, execHarness: exec }),
    );

    expect(result.generationId).toBe(generationId);
    expect(result.viewRoot).toContain(join('live', 'generations', generationId));
    const swept = (await readState(paths)).generations.find((g) => g.id === generationId);
    expect(swept).toMatchObject({ phase: 'swept', reservations: [], leases: [] });
  });

  it('writes inline instruction drift back from its immutable generation before sweep completes', async () => {
    const th = home();
    const { paths, env } = scenario(th);
    const storeInstruction = join(paths.envDir('writing'), 'instructions', 'base.md');
    mkdirSync(join(paths.envDir('writing'), 'instructions'), { recursive: true });
    writeFileSync(storeInstruction, 'ORIGINAL INSTRUCTION\n');
    const exec: ExecHarness = async (spec) => {
      const onSpawn = spec.onSpawn;
      await onSpawn?.({
        processGroupId: 4200,
        pid: 4201,
        processStart: 'fixture-start-4201',
      });
      const viewRoot = spec.env[FIXTURE_CONFIG_ENV];
      if (!viewRoot) throw new Error('fixture view root missing');
      const instructionFile = join(viewRoot, 'INSTRUCTIONS.md');
      const generated = readFileSync(instructionFile, 'utf8');
      writeFileSync(
        instructionFile,
        generated.replace('ORIGINAL INSTRUCTION', 'EDITED IN HARNESS'),
      );
      return 0;
    };

    const result = await launchHarness(
      req({ paths, adapter: makeFixtureAdapter(), env, execHarness: exec }),
    );

    expect(result.mode).toBe('applied');
    expect(readFileSync(storeInstruction, 'utf8')).toBe('EDITED IN HARNESS\n');
    const generation = (await readState(paths)).generations.find(
      (candidate) => candidate.id === result.generationId,
    );
    expect(generation?.phase).toBe('swept');
  });

  it('quarantines a generation when its required final drift commit fails', async () => {
    const th = home();
    const { paths, env } = scenario(th);
    const storeInstruction = join(paths.envDir('writing'), 'instructions', 'base.md');
    mkdirSync(join(storeInstruction, '..'), { recursive: true });
    writeFileSync(storeInstruction, 'ORIGINAL INSTRUCTION\n');
    await run(['init'], { env });

    const failingCommit: GitRunner = (args, options) =>
      args.includes('commit')
        ? Promise.resolve({
            code: 1,
            stdout: '',
            stderr: 'fatal: injected session commit failure',
            timedOut: false,
          })
        : defaultGitRunner(args, options);
    const exec: ExecHarness = async (spec) => {
      await spec.onSpawn?.({
        processGroupId: 4300,
        pid: 4301,
        processStart: 'fixture-start-4301',
      });
      const viewRoot = spec.env[FIXTURE_CONFIG_ENV]!;
      const instructions = join(viewRoot, 'INSTRUCTIONS.md');
      writeFileSync(
        instructions,
        readFileSync(instructions, 'utf8').replace(
          'ORIGINAL INSTRUCTION',
          'UNCOMMITTED HARNESS EDIT',
        ),
      );
      return 0;
    };

    const request = {
      ...req({ paths, adapter: makeFixtureAdapter(), env, execHarness: exec }),
      gitRun: failingCommit,
    } as LaunchRequest & { gitRun: GitRunner };
    const result = await launchHarness(request);

    const generation = (await readState(paths)).generations.find(
      (candidate) => candidate.id === result.generationId,
    );
    expect(generation?.phase).toBe('quarantined');
    expect(result.notices.join(' ')).toMatch(/final generation sweep failed|commit failed/i);
    expect(readFileSync(storeInstruction, 'utf8')).toBe('UNCOMMITTED HARNESS EDIT\n');
  });

  it('uses Adapter v2 launch arguments, environment, and optional root override', async () => {
    const th = home();
    const { paths, env } = scenario(th);
    const { exec, calls } = capturingExec();
    const adapter = makeFixtureAdapter();
    adapter.definition = {
      version: 2,
      id: adapter.id,
      binaryName: adapter.binaryName,
      session: {
        supported: true,
        launch: {
          arguments: ['--view={view}'],
          environment: { FIXTURE_EXTRA: 'enabled' },
          rootOverride: { variable: FIXTURE_CONFIG_ENV },
        },
      },
      surfaces: [],
      rawMappings: [],
    };

    const result = await launchHarness(
      req({ paths, adapter, env, args: ['--print-config-root'], execHarness: exec }),
    );

    expect(result.mode).toBe('applied');
    expect(calls[0]?.args).toEqual([`--view=${result.viewRoot}`, '--print-config-root']);
    expect(calls[0]?.env[FIXTURE_CONFIG_ENV]).toBe(result.viewRoot);
    expect(calls[0]?.env.FIXTURE_EXTRA).toBe('enabled');
  });

  it('adds machine-local secrets only to an applied child, with secrets.env precedence', async () => {
    const th = home();
    const { paths, env } = scenario(th);
    env.SHARED_TOKEN = 'shell-value';
    await writeSecrets(paths, new Map([
      ['SHARED_TOKEN', 'machine-value'],
      ['CHILD_ONLY', 'child-value'],
    ]));
    const applied = capturingExec();

    await launchHarness(req({ paths, adapter: makeFixtureAdapter(), env, execHarness: applied.exec }));

    expect(applied.calls[0]?.env.SHARED_TOKEN).toBe('machine-value');
    expect(applied.calls[0]?.env.CHILD_ONLY).toBe('child-value');

    const unbound = capturingExec();
    await launchHarness(
      req({ paths, adapter: makeFixtureAdapter(), env, envs: null, execHarness: unbound.exec }),
    );
    expect(unbound.calls[0]?.env.SHARED_TOKEN).toBe('shell-value');
    expect(unbound.calls[0]?.env.CHILD_ONLY).toBeUndefined();
  });

  it('AC: an unbound launch execs the real binary untouched (no overrides)', async () => {
    const th = home();
    const { paths, env } = scenario(th);
    const { exec, calls } = capturingExec();

    const result = await launchHarness(
      req({ paths, adapter: makeFixtureAdapter(), env, envs: null, execHarness: exec }),
    );
    expect(result.mode).toBe('unbound');
    expect(result.applied).toBe(false);
    expect(calls[0]?.env[FIXTURE_CONFIG_ENV]).toBeUndefined();
  });

  it('AC: a failing self-check falls closed — no overrides + a notice pointing at --global', async () => {
    const th = home();
    const { paths, env } = scenario(th);
    const { exec, calls } = capturingExec();
    const adapter = makeFixtureAdapter({ forceSelfCheck: { ok: false, detail: 'forced' } });

    const result = await launchHarness(req({ paths, adapter, env, execHarness: exec }));
    expect(result.mode).toBe('self-check-failed');
    expect(result.applied).toBe(false);
    expect(calls[0]?.env[FIXTURE_CONFIG_ENV]).toBeUndefined();
    expect(result.notices.join(' ')).toContain('--global');
  });

  it('a session-unsupported adapter (Cursor-like) launches untouched with a --global notice', async () => {
    const th = home();
    const { paths, env } = scenario(th);
    const { exec, calls } = capturingExec();
    const adapter = makeFixtureAdapter({ sessionSupported: false });

    const result = await launchHarness(req({ paths, adapter, env, execHarness: exec }));
    expect(result.mode).toBe('session-unsupported');
    expect(calls[0]?.env[FIXTURE_CONFIG_ENV]).toBeUndefined();
    expect(result.notices.join(' ')).toContain('--global');
  });

  it('AC: a corrupt state.json fails OPEN — no overrides + a warning, the tool still launches', async () => {
    const th = home();
    const { paths, env } = scenario(th);
    mkdirSync(paths.base, { recursive: true });
    writeFileSync(paths.state, '{ not valid json');
    const { exec, calls } = capturingExec();

    const result = await launchHarness(req({ paths, adapter: makeFixtureAdapter(), env, execHarness: exec }));
    expect(result.mode).toBe('fail-open');
    expect(result.applied).toBe(false);
    expect(result.code).toBe(0); // the child still ran
    expect(calls[0]?.env[FIXTURE_CONFIG_ENV]).toBeUndefined();
    expect(result.notices.join(' ').toLowerCase()).toContain('without overrides');
  });
});
