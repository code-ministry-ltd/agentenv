import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { driftSweep } from '../src/drift.js';
import { resolvePaths } from '../src/paths.js';
import { composeView } from '../src/session/composer.js';
import { FIXTURE_CONFIG_ENV, makeFixtureAdapter } from './fixtures/fixture-adapter.js';
import { makeTempHome, type TempHome } from './helpers.js';

/**
 * The v1 MCP drift contract: **detect and report, never write**.
 *
 * `mcp/servers.yaml` is the canonical model; the adapters shape it into each harness's
 * native config. When a user edits that harness config, agentenv tells them exactly what
 * disagrees with canonical and leaves `mcp/servers.yaml` completely alone — the user makes
 * the change permanent by editing the canonical file themselves.
 *
 * The two load-bearing assertions in every case below are:
 *   1. `mcp/servers.yaml` is BYTE-IDENTICAL to what it was before the sweep, and
 *   2. the report names the right server and the right canonical fields.
 *
 * Plus one hard security property: a report never contains a VALUE, so a credential the
 * user pasted into their harness config cannot reach stderr, a log, or a terminal buffer.
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

/** A leaked-looking credential the user pastes into the harness config. */
const LEAKED = 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

const CANONICAL =
  'linear:\n' +
  '  transport: http\n' +
  '  url: https://mcp.linear.app/mcp\n' +
  '  env:\n' +
  '    TOKEN: "${GH_TOKEN}"\n';

/** A store env + a real config root, with the env already materialised globally. */
async function materialised(th: TempHome): Promise<{
  paths: ReturnType<typeof resolvePaths>;
  realHome: string;
  env: NodeJS.ProcessEnv;
  storePath: string;
  cfgPath: string;
}> {
  const paths = resolvePaths(th.env);
  const realHome = join(th.home, 'real');
  mkdirSync(realHome, { recursive: true });
  writeFileSync(join(realHome, 'INSTRUCTIONS.md'), '# user\n');
  writeFileSync(join(realHome, 'config.json'), '{}\n');

  const envDir = paths.envDir('writing');
  mkdirSync(join(envDir, 'mcp'), { recursive: true });
  writeFileSync(join(envDir, 'mcp', 'servers.yaml'), CANONICAL);

  const env: NodeJS.ProcessEnv = { ...th.env, [FIXTURE_CONFIG_ENV]: realHome };
  await run(['use', 'writing', '--global'], { env, adapters: [makeFixtureAdapter()] });
  return {
    paths,
    realHome,
    env,
    storePath: join(envDir, 'mcp', 'servers.yaml'),
    cfgPath: join(realHome, 'config.json'),
  };
}

/** Edit the real harness config the way a user would, mid-session. */
function editRealConfig(cfgPath: string, edit: (srv: Record<string, unknown>) => void): void {
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as {
    mcpServers: Record<string, Record<string, unknown>>;
  };
  edit(cfg.mcpServers.linear!);
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
}

describe('MCP drift is REPORTED, never written back to the canonical store', () => {
  it('leaves mcp/servers.yaml byte-identical and names the server + field', async () => {
    const th = home();
    const { paths, env, storePath, cfgPath } = await materialised(th);
    const before = readFileSync(storePath);

    editRealConfig(cfgPath, (srv) => {
      srv.url = 'https://mcp.linear.app/mcp?edited=1';
    });

    const notices: string[] = [];
    const result = await driftSweep({
      paths,
      adapters: [makeFixtureAdapter()],
      env,
      onWarn: (m) => notices.push(m),
    });

    // 1. the canonical store is untouched, byte for byte.
    expect(readFileSync(storePath).equals(before)).toBe(true);
    expect(result.storePathsChanged).not.toContain(storePath);

    // 2. the drift is still DETECTED (the manifest hash is reconciled as before) …
    expect(result.configKeysDrifted).toBe(1);

    // … and REPORTED, naming the server, the field, the harness config file, and the
    // canonical file the user must edit themselves.
    expect(result.configKeysDriftReports).toHaveLength(1);
    const report = result.configKeysDriftReports[0]!;
    expect(report).toContain("'linear'");
    expect(report).toContain('url');
    expect(report).toContain(cfgPath);
    expect(report).toContain(storePath);
    expect(report).toContain('NOT');
    expect(notices.join('\n')).toContain(report);
  });

  it('classifies added / removed / changed fields separately', async () => {
    const th = home();
    const { paths, env, storePath, cfgPath } = await materialised(th);
    const before = readFileSync(storePath);

    editRealConfig(cfgPath, (srv) => {
      srv.url = 'https://elsewhere.example.com/mcp'; // changed
      srv.timeout = 30000; // added
      delete srv.env; // removed
    });

    const result = await driftSweep({ paths, adapters: [makeFixtureAdapter()], env });
    expect(readFileSync(storePath).equals(before)).toBe(true);

    const report = result.configKeysDriftReports.join('\n');
    expect(report).toMatch(/changed\s+url/);
    expect(report).toMatch(/added\s+timeout/);
    expect(report).toMatch(/removed\s+env/);
  });

  it('never prints a value, so a pasted credential cannot reach the report', async () => {
    const th = home();
    const { paths, env, storePath, cfgPath } = await materialised(th);
    const before = readFileSync(storePath);

    // The user pastes a real token over the ${VAR} placeholder AND into a new field.
    editRealConfig(cfgPath, (srv) => {
      (srv.env as Record<string, unknown>).TOKEN = LEAKED;
      srv.headers = { Authorization: `Bearer ${LEAKED}` };
    });

    const notices: string[] = [];
    const result = await driftSweep({
      paths,
      adapters: [makeFixtureAdapter()],
      env,
      onWarn: (m) => notices.push(m),
    });

    // The store never gains the literal — because the store is never written at all.
    expect(readFileSync(storePath).equals(before)).toBe(true);
    expect(readFileSync(storePath, 'utf8')).toContain('${GH_TOKEN}');

    const everything = [...result.configKeysDriftReports, ...notices].join('\n');
    expect(everything).not.toContain(LEAKED);
    expect(everything).not.toMatch(/Bearer\s+\S{8,}/);
    // The field NAMES are still reported, which is what the user needs.
    expect(everything).toContain('headers.Authorization');
  });

  it('reaches the user on stderr through the engine path (`use --global`)', async () => {
    const th = home();
    const { env, storePath, cfgPath } = await materialised(th);
    const before = readFileSync(storePath);

    editRealConfig(cfgPath, (srv) => {
      srv.url = 'https://mcp.linear.app/mcp?edited=1';
    });

    const res = await run(['use', 'writing', '--global'], {
      env,
      adapters: [makeFixtureAdapter()],
    });
    expect(res.code).toBe(0);
    expect(res.stderr).toContain("'linear'");
    expect(res.stderr).toContain('url');
    expect(res.stderr).toContain(storePath);
    expect(readFileSync(storePath).equals(before)).toBe(true);
  });

  it('reaches the user through the session composer path (a user entry that disagrees)', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const realRoot = join(th.home, 'real');
    mkdirSync(realRoot, { recursive: true });
    writeFileSync(join(realRoot, 'INSTRUCTIONS.md'), '# user\n');
    // The user's OWN `linear` entry in the real config disagrees with canonical: the
    // composer keeps theirs (D7) and must say exactly how the two differ.
    writeFileSync(
      join(realRoot, 'config.json'),
      `${JSON.stringify({ mcpServers: { linear: { transport: 'http', url: 'https://user.example.com/mcp' } } }, null, 2)}\n`,
    );
    const envDir = paths.envDir('writing');
    mkdirSync(join(envDir, 'mcp'), { recursive: true });
    writeFileSync(join(envDir, 'mcp', 'servers.yaml'), CANONICAL);
    const storePath = join(envDir, 'mcp', 'servers.yaml');
    const before = readFileSync(storePath);

    const notices: string[] = [];
    await composeView({
      paths,
      adapter: makeFixtureAdapter(),
      envs: ['writing'],
      session: 'sess-drift',
      realConfigRoot: realRoot,
      onWarn: (m) => notices.push(m),
    });

    const all = notices.join('\n');
    expect(all).toContain("'linear'");
    expect(all).toMatch(/changed\s+url/);
    expect(all).toMatch(/removed\s+env/);
    expect(all).toContain(storePath);
    expect(readFileSync(storePath).equals(before)).toBe(true);
  });
});
