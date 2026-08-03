import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { defaultGitRunner, type GitRunner } from '../src/git.js';
import { makeTempHome, type TempHome } from './helpers.js';

const homes: TempHome[] = [];
function home(): TempHome {
  const result = makeTempHome({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' });
  homes.push(result);
  return result;
}
afterEach(() => {
  for (const entry of homes.splice(0)) entry.cleanup();
});

describe('settled root CLI flags', () => {
  it('documents and accepts --json, --offline, and --verbose before the command', async () => {
    const help = await run(['--help']);
    expect(help.stdout).toContain('--json');
    expect(help.stdout).toContain('--offline');
    expect(help.stdout).toContain('--verbose');

    const th = home();
    await run(['init'], { env: th.env });
    const result = await run(['--json', '--offline', '--verbose', 'list'], { env: th.env });
    expect(result.code).toBe(0);
    expect(result.stderr).toBeUndefined();
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command: 'list',
      code: 0,
      diagnostics: { offline: true },
    });
  });

  it('emits semantic machine-readable status data for plugin consumers', async () => {
    const th = home();
    await run(['init'], { env: th.env });

    const result = await run(['--json', 'status'], { env: th.env, cwd: th.home });
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(payload).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command: 'status',
      data: {
        session: { mode: 'unbound' },
        global: { stack: [] },
        lifecycle: { commands: [], generations: [], projections: [], rescues: [] },
      },
    });
  });

  it('keeps --offline local commits but runs no fetch, pull, ls-remote, or push', async () => {
    const th = home();
    await run(['init'], { env: th.env });
    const network: string[] = [];
    const runner: GitRunner = (args, options) => {
      if (['fetch', 'pull', 'push', 'ls-remote'].includes(args[0] ?? '')) network.push(args[0]!);
      return defaultGitRunner(args, options);
    };

    const result = await run(['--offline', 'create', 'work'], { env: th.env, gitRun: runner });

    expect(result.code).toBe(0);
    expect(network).toEqual([]);
  });

  it('returns JSON for command errors without leaking a second stderr protocol', async () => {
    const result = await run(['--json', 'frobnicate']);
    expect(result.stderr).toBeUndefined();
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: false,
      command: 'frobnicate',
      code: 1,
    });
  });

  it('rejects unknown root options before dispatch', async () => {
    const result = await run(['--wat', 'status']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unknown global option '--wat'");
  });
});
