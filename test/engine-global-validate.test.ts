import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Adapter, SelfCheckResult } from '../src/adapter.js';
import { cursorAdapter } from '../src/adapters/cursor.js';
import { run } from '../src/cli.js';
import { materialiseGlobal } from '../src/engine.js';
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
function scenario(
  th: TempHome,
  serversYaml: string,
  userServers: Record<string, unknown> = { userSrv: { command: 'x' } },
) {
  const paths = resolvePaths(th.env);
  const realHome = join(th.home, 'cursor');
  mkdirSync(realHome, { recursive: true });
  // The user's real Cursor MCP config — must survive a bad injection byte-for-byte.
  const userMcp = `${JSON.stringify({ mcpServers: userServers }, null, 2)}\n`;
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

describe('engine: config-keys validation is fail-CLOSED and honest (F5/5,6,7)', () => {
  it('does not blame our injection when the file was ALREADY invalid (F5/7)', async () => {
    const th = home();
    // The user's mcp.json ALREADY holds a malformed entry, so Cursor rejects the whole
    // file before we touch it. Validating only AFTER the write makes our own (valid)
    // injection look like the culprit and hides the real offender forever.
    const { realHome, env, userMcp } = scenario(th, 'good:\n  transport: stdio\n  command: y\n', {
      userSrv: { command: 'x' },
      broken: {},
    });

    const res = await run(['use', 'writing', '--global'], { env, adapters: [cursorAdapter] });
    expect(res.code).toBe(0);

    const stderr = res.stderr ?? '';
    // A DISTINCT reason, naming the pre-existing offender — not `validation-failed`
    // against our own surface.
    expect(stderr).toContain('validation-baseline');
    expect(stderr).toContain('broken');
    expect(stderr).not.toContain('validation-failed');

    // And the already-rejected file is never written to at all.
    expect(readFileSync(join(realHome, 'mcp.json'), 'utf8')).toBe(userMcp);
  });

  it('treats a THROWING validator as a failure, never as a pass (F5/6)', async () => {
    const th = home();
    // Every other adapter-hook call site in materialiseConfigKeys is defensively wrapped;
    // an unguarded throw in the POST-WRITE check escapes withLock AFTER the batch commits
    // — an exit with a stack trace AND the bad config left on disk, the exact fail-OPEN
    // outcome the validation exists to prevent. The baseline call (1st) passes so the
    // throw lands squarely in that post-write window.
    let calls = 0;
    const boom: Adapter = {
      ...cursorAdapter,
      validateConfigFile(): SelfCheckResult {
        calls += 1;
        if (calls === 1) return { ok: true };
        throw new Error('validator exploded');
      },
    };
    const { realHome, env, userMcp } = scenario(th, 'good:\n  transport: stdio\n  command: y\n');

    const res = await run(['use', 'writing', '--global'], { env, adapters: [boom] });
    expect(res.code).toBe(0);
    expect(res.stderr ?? '').toContain('validation-failed');
    expect(res.stderr ?? '').toContain('validator exploded');
    // Fail-closed: the write is rolled back, so the user's file is byte-identical.
    expect(readFileSync(join(realHome, 'mcp.json'), 'utf8')).toBe(userMcp);
  });

  it('never claims a rollback that did not happen (F5/5)', async () => {
    const th = home();
    // `removeKey` refuses a drifted value (`hash-mismatch`) WITHOUT touching the file.
    // Simulate the race deterministically: the POST-WRITE validation is our last read of
    // the file before the rollback, so editing our injected value from inside that call
    // (the 2nd; the 1st is the pre-write baseline) lands exactly in the window.
    let calls = 0;
    const racy: Adapter = {
      ...cursorAdapter,
      validateConfigFile(absPath, content): SelfCheckResult {
        calls += 1;
        if (calls === 1) return { ok: true }; // baseline: the user's file is fine
        const cfg = JSON.parse(content) as { mcpServers: Record<string, JsonLike> };
        cfg.mcpServers.good = { command: 'edited-by-someone-else' };
        writeFileSync(absPath, `${JSON.stringify(cfg, null, 2)}\n`);
        return { ok: false, detail: `${absPath}: rejected by the test validator` };
      },
    };
    const { realHome, env } = scenario(th, 'good:\n  transport: stdio\n  command: y\n');

    const res = await run(['use', 'writing', '--global'], { env, adapters: [racy] });
    expect(res.code).toBe(0);

    const stderr = res.stderr ?? '';
    // The truth must be surfaced: the key is STILL in the file, so the user is told
    // which one and that the rollback was incomplete.
    expect(stderr).toMatch(/could not (be )?remove/i);
    expect(stderr).toContain('mcpServers.good');

    // …and it really is still there (which is exactly why we must not claim success).
    const cfg = JSON.parse(readFileSync(join(realHome, 'mcp.json'), 'utf8'));
    expect(cfg.mcpServers.good).toEqual({ command: 'edited-by-someone-else' });
  });
});

describe('engine: rollback reporting is honest about WHAT happened (F6/8,10,11)', () => {
  it('records our ownership in the manifest when the key really is stuck (F6/8)', async () => {
    const th = home();
    let calls = 0;
    const racy: Adapter = {
      ...cursorAdapter,
      validateConfigFile(absPath, content): SelfCheckResult {
        calls += 1;
        if (calls === 1) return { ok: true };
        const cfg = JSON.parse(content) as { mcpServers: Record<string, JsonLike> };
        cfg.mcpServers.good = { command: 'edited-by-someone-else' };
        writeFileSync(absPath, `${JSON.stringify(cfg, null, 2)}\n`);
        return { ok: false, detail: `${absPath}: rejected by the test validator` };
      },
    };
    const { paths, realHome, env } = scenario(th, 'good:\n  transport: stdio\n  command: y\n');
    await run(['use', 'writing', '--global'], { env, adapters: [racy] });

    // The key could not be removed, so the MANIFEST must still record that we own it —
    // that record is what the next invocation has to consult before blaming the user.
    const mcpFile = join(realHome, 'mcp.json');
    const owned = (await readState(paths)).items.filter(
      (i): i is ConfigKeysItem => i.surface === 'config-keys' && i.path === mcpFile,
    );
    expect(owned.map((i) => i.keyPath.join('.'))).toEqual(['mcpServers.good']);
  });

  it('does not blame a PRE-EXISTING entry when the stuck key is ours (F6/8)', async () => {
    const th = home();
    let calls = 0;
    const racy: Adapter = {
      ...cursorAdapter,
      validateConfigFile(absPath, content): SelfCheckResult {
        calls += 1;
        if (calls === 1) return { ok: true };
        const cfg = JSON.parse(content) as { mcpServers: Record<string, JsonLike> };
        cfg.mcpServers.good = { command: 'edited-by-someone-else' };
        writeFileSync(absPath, `${JSON.stringify(cfg, null, 2)}\n`);
        return { ok: false, detail: `${absPath}: rejected by the test validator` };
      },
    };
    const { env } = scenario(th, 'good:\n  transport: stdio\n  command: y\n');
    await run(['use', 'writing', '--global'], { env, adapters: [racy] });

    // Second invocation: the file is STILL rejected, and the manifest says the key in it
    // is ours. Blaming "a pre-existing entry, not ours" would send the user hunting for
    // an offender that does not exist.
    const stubborn: Adapter = {
      ...cursorAdapter,
      validateConfigFile(absPath): SelfCheckResult {
        return { ok: false, detail: `${absPath}: rejected by the test validator` };
      },
    };
    const res = await run(['use', 'writing', '--global'], { env, adapters: [stubborn] });
    const stderr = res.stderr ?? '';
    expect(stderr).toContain('validation-baseline');
    expect(stderr).not.toContain('not ours');
    expect(stderr).toMatch(/agentenv still owns/i);
    expect(stderr).toContain('mcpServers.good');
  });

  it('an ALREADY-ABSENT key is not reported as stuck (F6/10)', async () => {
    const th = home();
    let calls = 0;
    // The validator DELETES our key and then rejects: `removeKey` finds nothing to
    // remove. Nothing is left behind, so telling the user to "remove it by hand" sends
    // them after a key that is not there.
    const deleter: Adapter = {
      ...cursorAdapter,
      validateConfigFile(absPath, content): SelfCheckResult {
        calls += 1;
        if (calls === 1) return { ok: true };
        const cfg = JSON.parse(content) as { mcpServers: Record<string, JsonLike> };
        delete cfg.mcpServers.good;
        writeFileSync(absPath, `${JSON.stringify(cfg, null, 2)}\n`);
        return { ok: false, detail: `${absPath}: rejected by the test validator` };
      },
    };
    const { env } = scenario(th, 'good:\n  transport: stdio\n  command: y\n');
    const res = await run(['use', 'writing', '--global'], { env, adapters: [deleter] });
    const stderr = res.stderr ?? '';
    expect(stderr).toContain('validation-failed');
    expect(stderr).not.toMatch(/could not (be )?remove/i);
    expect(stderr).not.toMatch(/by hand/i);
  });

  it('does not count an ALREADY-ABSENT key as still applied (F6/11)', async () => {
    const th = home();
    let calls = 0;
    const deleter: Adapter = {
      ...cursorAdapter,
      validateConfigFile(absPath, content): SelfCheckResult {
        calls += 1;
        if (calls === 1) return { ok: true };
        const cfg = JSON.parse(content) as { mcpServers: Record<string, JsonLike> };
        delete cfg.mcpServers.good;
        writeFileSync(absPath, `${JSON.stringify(cfg, null, 2)}\n`);
        return { ok: false, detail: `${absPath}: rejected by the test validator` };
      },
    };
    const { paths, env } = scenario(th, 'good:\n  transport: stdio\n  command: y\n');
    const result = await materialiseGlobal({
      paths,
      adapters: [deleter],
      envs: ['writing'],
      env,
      onWarn: () => {},
    });
    // The key is not in the file. Counting it as applied claims a server the harness
    // will never see.
    expect(result.applied).toBe(0);
  });
});

/** A loose stand-in for the JSON shapes this test file pokes at. */
type JsonLike = Record<string, unknown>;
