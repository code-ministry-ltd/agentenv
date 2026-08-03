import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { resolvePaths } from '../src/paths.js';
import type { ExecHarness, ExecSpec } from '../src/session/exec.js';
import { launchHarness, type LaunchRequest } from '../src/session/launch.js';
import { cursorAdapter } from '../src/adapters/cursor.js';
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

/** Install a no-op executable `agent` so PATH resolution reaches the launch branch. */
function installFakeCursorAgent(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  const p = join(binDir, 'agent');
  writeFileSync(p, '#!/bin/sh\nexit 0\n');
  chmodSync(p, 0o755);
}

function installLegacyFakeCursorAgent(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  const p = join(binDir, 'cursor-agent');
  writeFileSync(p, '#!/bin/sh\nexit 0\n');
  chmodSync(p, 0o755);
}

/** An injected exec that records the spec and really spawns the (fake) binary. */
function capturingExec(): { exec: ExecHarness; calls: ExecSpec[] } {
  const calls: ExecSpec[] = [];
  const exec: ExecHarness = async (spec) => {
    calls.push(spec);
    const r = spawnSync(spec.binaryPath, [...spec.args], { env: spec.env, encoding: 'utf8' });
    return r.status ?? 0;
  };
  return { exec, calls };
}

describe('adapter.cursor — session-unsupported launch (AC)', () => {
  it('a bound launch for agent execs UNTOUCHED (no CURSOR_CONFIG_DIR override) + a --global notice', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const binDir = join(th.home, 'bin');
    installFakeCursorAgent(binDir);
    // Seed the env so the launch is genuinely "bound" (envs non-empty).
    mkdirSync(join(paths.envDir('writing'), 'skills', 'w-skill'), { recursive: true });
    writeFileSync(join(paths.envDir('writing'), 'skills', 'w-skill', 'SKILL.md'), '# w\n');

    const env: NodeJS.ProcessEnv = { ...th.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}` };
    const { exec, calls } = capturingExec();

    const reqObj: LaunchRequest = {
      paths,
      adapter: cursorAdapter,
      envs: ['writing'],
      session: 'sess-1',
      args: [],
      cwd: th.home,
      env,
      execHarness: exec,
    };
    const result = await launchHarness(reqObj);

    // Fails closed to global mode: no session view, no config-root override applied.
    expect(result.mode).toBe('session-unsupported');
    expect(result.applied).toBe(false);
    expect(calls[0]?.env.CURSOR_CONFIG_DIR).toBeUndefined();
    // The one-line notice points the user at --global.
    expect(result.notices.join(' ')).toContain('--global');
    expect(result.notices.join(' ')).toContain('does not support session mode');
  });

  it('launches the legacy cursor-agent alias untouched when that shim was invoked', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const binDir = join(th.home, 'bin');
    installLegacyFakeCursorAgent(binDir);
    mkdirSync(join(paths.envDir('writing'), 'skills', 'w-skill'), { recursive: true });
    writeFileSync(join(paths.envDir('writing'), 'skills', 'w-skill', 'SKILL.md'), '# w\n');
    const env: NodeJS.ProcessEnv = { ...th.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}` };
    const { exec, calls } = capturingExec();

    const result = await launchHarness({
      paths,
      adapter: cursorAdapter,
      binaryName: 'cursor-agent',
      envs: ['writing'],
      session: 'sess-legacy',
      args: [],
      cwd: th.home,
      env,
      execHarness: exec,
    });

    expect(result.mode).toBe('session-unsupported');
    expect(calls[0]?.binaryPath).toBe(join(binDir, 'cursor-agent'));
  });
});

describe('adapter.cursor — status reports the global-instructions gap', () => {
  it('status lists the instructions surface UNSUPPORTED with the no-clean-surface reason', async () => {
    const th = home();
    // Point realConfigRoot at a temp dir so status can resolve the adapter's root.
    const env: NodeJS.ProcessEnv = { ...th.env, CURSOR_CONFIG_DIR: join(th.home, 'cursor-copy') };
    const res = await run(['status'], { env, adapters: [cursorAdapter] });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('cursor');
    expect(res.stdout).toContain('UNSUPPORTED');
    expect(res.stdout).toMatch(/no global-instructions surface/i);
  });
});
