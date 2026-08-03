/**
 * Opt-in release checkpoint for Cursor's global-only adapter.
 *
 * Current Cursor CLI documentation names the executable `agent` and the
 * observation command `agent mcp list`. The probe runs with a throwaway HOME,
 * so both agentenv global materialisation and every Cursor CLI write stay away
 * from the user's real ~/.cursor directory.
 *
 * Run just this: AGENTENV_LIVE=1 npm run test:live -- test/adapter.cursor.live.test.ts
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cursorAdapter } from '../src/adapters/cursor.js';
import { run } from '../src/cli.js';
import { resolvePaths } from '../src/paths.js';

const PROBE_TIMEOUT_MS = 30_000;
const probeRoot = mkdtempSync(join(tmpdir(), 'agentenv-cursor-probe-'));
const probeEnv: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: probeRoot,
  USERPROFILE: probeRoot,
};
delete probeEnv.CURSOR_CONFIG_DIR;
const hasCursor = spawnSync('agent', ['--version'], {
  env: probeEnv,
  timeout: 20_000,
}).status === 0;
const canRun = process.env.AGENTENV_LIVE === '1' && hasCursor;
const realCursorRoot = join(homedir(), '.cursor');

function realConfigSha(): string {
  const hash = createHash('sha256');
  for (const name of ['mcp.json', 'cli-config.json']) {
    const path = join(realCursorRoot, name);
    hash.update(`${name}:`).update(existsSync(path) ? readFileSync(path) : Buffer.from('<absent>'));
  }
  return hash.digest('hex');
}

afterAll(() => {
  rmSync(probeRoot, { recursive: true, force: true });
});

describe.skipIf(!canRun)('adapter.cursor — live global observation in a throwaway HOME', () => {
  it(
    'materialises an MCP server that `agent mcp list` observes without touching real config',
    async () => {
      const realBefore = realConfigSha();
      const env: NodeJS.ProcessEnv = {
        ...probeEnv,
        AGENTENV_HOME: join(probeRoot, 'agentenv'),
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      };
      const paths = resolvePaths(env);
      const probeName = `agentenv_live_${process.pid}`;
      mkdirSync(join(paths.envDir('live-writing'), 'mcp'), { recursive: true });
      writeFileSync(
        join(paths.envDir('live-writing'), 'mcp', 'servers.yaml'),
        `${probeName}:\n  transport: stdio\n  command: /bin/echo\n  args: ["marker"]\n`,
      );

      const used = await run(['use', 'live-writing', '--global'], {
        env,
        adapters: [cursorAdapter],
      });
      expect(used.code).toBe(0);
      expect(readFileSync(join(probeRoot, '.cursor', 'mcp.json'), 'utf8')).toContain(probeName);

      const observed = spawnSync('agent', ['mcp', 'list'], {
        env,
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
      });
      expect(observed.status).toBe(0);
      expect(`${observed.stdout ?? ''}${observed.stderr ?? ''}`).toContain(probeName);
      expect(realConfigSha()).toBe(realBefore);
    },
    PROBE_TIMEOUT_MS + 20_000,
  );
});
