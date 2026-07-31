import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cursorAdapter } from '../src/adapters/cursor.js';
import { run } from '../src/cli.js';
import type { ConfigKeysItem } from '../src/config-keys.js';
import { resolvePaths } from '../src/paths.js';
import { readState } from '../src/state.js';
import { makeTempHome, type TempHome } from './helpers.js';

/**
 * F2 — the engine must run `adapter.validateConfigFile` after writing a config-keys
 * surface and ROLL BACK a whole-file-rejecting write. Cursor's CLI drops EVERY server
 * in `mcp.json` if a single entry is malformed, so a bad `--global` injection would
 * otherwise silently nuke the user's real Cursor MCP config. Fail-closed: on
 * `{ok:false}` the surface's write is rolled back (the real file left byte-identical)
 * and a skip/warning is surfaced; a valid injection passes untouched.
 */

const homes: TempHome[] = [];
function home(): TempHome {
  const h = makeTempHome();
  homes.push(h);
  return h;
}
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
});

/** A real ~/.cursor with a pre-existing user mcp.json, plus an env store dir. */
function scenario(th: TempHome, serversYaml: string) {
  const paths = resolvePaths(th.env);
  const realHome = join(th.home, 'cursor');
  mkdirSync(realHome, { recursive: true });
  // The user's real, VALID Cursor MCP config — must survive a bad injection.
  const userMcp = `${JSON.stringify({ mcpServers: { userSrv: { command: 'x' } } }, null, 2)}\n`;
  writeFileSync(join(realHome, 'mcp.json'), userMcp);

  const envDir = paths.envDir('writing');
  mkdirSync(join(envDir, 'mcp'), { recursive: true });
  writeFileSync(join(envDir, 'mcp', 'servers.yaml'), serversYaml);

  const env: NodeJS.ProcessEnv = { ...th.env, CURSOR_CONFIG_DIR: realHome };
  return { paths, realHome, env, userMcp };
}

describe('engine: global config-keys whole-file validation (F2)', () => {
  it('rolls back a bad injection that would make Cursor reject the whole mcp.json', async () => {
    const th = home();
    // `bad` has no url → Cursor shape `{type:'http'}` (neither command nor url) →
    // Cursor rejects the WHOLE file, dropping the user's valid server too.
    const { paths, realHome, env, userMcp } = scenario(th, 'bad:\n  transport: http\n');

    const res = await run(['use', 'writing', '--global'], { env, adapters: [cursorAdapter] });
    expect(res.code).toBe(0);

    // The user's real mcp.json is left byte-identical (the bad write rolled back).
    expect(readFileSync(join(realHome, 'mcp.json'), 'utf8')).toBe(userMcp);

    // A fail-closed skip/warning names the validation failure.
    expect(res.stderr ?? '').toContain('validation-failed');

    // No config-keys ownership was recorded for the rolled-back surface.
    const manifest = await readState(paths);
    const mcpFile = join(realHome, 'mcp.json');
    const owned = manifest.items.filter(
      (i): i is ConfigKeysItem => i.surface === 'config-keys' && i.path === mcpFile,
    );
    expect(owned).toHaveLength(0);
  });

  it('lets a valid injection through (server added beside the user\'s)', async () => {
    const th = home();
    const { realHome, env } = scenario(th, 'good:\n  transport: stdio\n  command: y\n');

    const res = await run(['use', 'writing', '--global'], { env, adapters: [cursorAdapter] });
    expect(res.code).toBe(0);
    expect(res.stderr ?? '').not.toContain('validation-failed');

    const cfg = JSON.parse(readFileSync(join(realHome, 'mcp.json'), 'utf8'));
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(['good', 'userSrv']);
    expect(cfg.mcpServers.good).toEqual({ command: 'y' });
  });
});
