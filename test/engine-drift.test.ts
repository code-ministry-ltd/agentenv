import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Adapter } from '../src/adapter.js';
import { run } from '../src/cli.js';
import type { ConfigKeysItem } from '../src/config-keys.js';
import { driftSweep } from '../src/drift.js';
import { resolvePaths } from '../src/paths.js';
import { readState } from '../src/state.js';
import { FIXTURE_CONFIG_ENV, makeFixtureAdapter } from './fixtures/fixture-adapter.js';
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

function scenario(th: TempHome) {
  const paths = resolvePaths(th.env);
  const realHome = join(th.home, 'real');
  mkdirSync(realHome, { recursive: true });
  writeFileSync(join(realHome, 'INSTRUCTIONS.md'), '# user\n');
  writeFileSync(join(realHome, 'config.json'), '{}\n');

  const envDir = paths.envDir('writing');
  mkdirSync(join(envDir, 'instructions'), { recursive: true });
  writeFileSync(join(envDir, 'instructions', 'base.md'), 'ORIGINAL body\n');
  mkdirSync(join(envDir, 'mcp'), { recursive: true });
  writeFileSync(join(envDir, 'mcp', 'servers.yaml'), 'linear:\n  url: https://original\n');

  const env: NodeJS.ProcessEnv = { ...th.env, [FIXTURE_CONFIG_ENV]: realHome };
  return { paths, realHome, env };
}

describe('engine: drift sweep', () => {
  it('AC: a config key edited in the real file is captured on the next command', async () => {
    const th = home();
    const { paths, realHome, env } = scenario(th);
    const opts = { env, adapters: [makeFixtureAdapter()] };
    await run(['use', 'writing', '--global'], opts);

    const cfgPath = join(realHome, 'config.json');
    const key = async (): Promise<ConfigKeysItem | undefined> =>
      (await readState(paths)).items.find(
        (i) => i.surface === 'config-keys' && i.ownerEnv === 'writing',
      ) as ConfigKeysItem | undefined;
    const hashBefore = (await key())?.hash;

    // The harness/user edits the injected value in the REAL file between invocations.
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.mcpServers.linear.url = 'https://EDITED';
    writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);

    // The next command sweeps drift: the manifest reconciles to the edited value.
    const result = await driftSweep({ paths, adapters: [makeFixtureAdapter()], env });
    expect(result.configKeysDrifted).toBe(1);
    expect((await key())?.hash).not.toBe(hashBefore);
  });

  it('AC: an inline instruction edit in the real file is written back to the store', async () => {
    const th = home();
    const { paths, realHome, env } = scenario(th);
    const opts = { env, adapters: [makeFixtureAdapter()] };
    await run(['use', 'writing', '--global'], opts);

    // Edit inside the managed region of the real instruction file.
    const instrPath = join(realHome, 'INSTRUCTIONS.md');
    const instr = readFileSync(instrPath, 'utf8').replace('ORIGINAL body', 'EDITED body');
    expect(instr).toContain('EDITED body');
    writeFileSync(instrPath, instr);

    const result = await driftSweep({ paths, adapters: [makeFixtureAdapter()], env });
    expect(result.fileBlockDrifted).toContain('base.md');
    // The store file now carries the edit (the durable home).
    expect(readFileSync(join(paths.envDir('writing'), 'instructions', 'base.md'), 'utf8')).toContain(
      'EDITED body',
    );
  });

  it('a drifted config key is REPORTED against the env store, never written into it', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const realHome = join(th.home, 'real');
    mkdirSync(realHome, { recursive: true });
    writeFileSync(join(realHome, 'INSTRUCTIONS.md'), '# user\n');
    writeFileSync(join(realHome, 'config.json'), '{}\n');
    const envDir = paths.envDir('writing');
    mkdirSync(join(envDir, 'mcp'), { recursive: true });
    // A server whose token is a ${VAR} placeholder — never a baked literal (D6).
    writeFileSync(
      join(envDir, 'mcp', 'servers.yaml'),
      'linear:\n  url: https://original\n  env:\n    TOKEN: "${GH_TOKEN}"\n',
    );
    const env: NodeJS.ProcessEnv = { ...th.env, [FIXTURE_CONFIG_ENV]: realHome };
    await run(['use', 'writing', '--global'], { env, adapters: [makeFixtureAdapter()] });

    const storePath = join(envDir, 'mcp', 'servers.yaml');
    const storeBefore = readFileSync(storePath);

    // The harness edits the real file: change the url AND bake a literal over the
    // secret placeholder (as a leaked token would).
    const cfgPath = join(realHome, 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.mcpServers.linear.url = 'https://EDITED';
    cfg.mcpServers.linear.env.TOKEN = 'ghp_LEAKED_LITERAL';
    writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);

    const result = await driftSweep({ paths, adapters: [makeFixtureAdapter()], env });
    expect(result.configKeysDrifted).toBe(1);

    // The store is byte-identical: the edit is REPORTED, not applied.
    expect(readFileSync(storePath).equals(storeBefore)).toBe(true);
    expect(result.storePathsChanged).not.toContain(storePath);
    const report = result.configKeysDriftReports.join('\n');
    expect(report).toContain("'linear'");
    expect(report).toMatch(/changed\s+url/);
    // The baked literal is neither written nor printed.
    expect(readFileSync(storePath, 'utf8')).toContain('${GH_TOKEN}');
    expect(report).not.toContain('ghp_LEAKED_LITERAL');
  });

  it('an adapter WITHOUT the drift classifier still reconciles config drift (no store write)', async () => {
    const th = home();
    const { paths, realHome, env } = scenario(th);
    // Strip the optional classifier: reconciliation must still be non-lossy.
    const noHook: Adapter = { ...makeFixtureAdapter(), describeConfigKeysDrift: undefined };
    await run(['use', 'writing', '--global'], { env, adapters: [noHook] });

    const storePath = join(paths.envDir('writing'), 'mcp', 'servers.yaml');
    const storeBefore = readFileSync(storePath, 'utf8');

    const cfgPath = join(realHome, 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.mcpServers.linear.url = 'https://EDITED';
    writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);

    const result = await driftSweep({ paths, adapters: [noHook], env });
    expect(result.configKeysDrifted).toBe(1); // hash still reconciled
    expect(readFileSync(storePath, 'utf8')).toBe(storeBefore); // store untouched
    expect(result.storePathsChanged).not.toContain(storePath);
    expect(result.configKeysDriftReports).toEqual([]); // nothing to say without a classifier
  });

  it('is a clean no-op when nothing has drifted', async () => {
    const th = home();
    const { paths, env } = scenario(th);
    await run(['use', 'writing', '--global'], { env, adapters: [makeFixtureAdapter()] });
    const result = await driftSweep({ paths, adapters: [makeFixtureAdapter()], env });
    expect(result.configKeysDrifted).toBe(0);
    expect(result.fileBlockDrifted).toEqual([]);
    expect(result.storePathsChanged).toEqual([]);
    expect(result.configKeysDriftReports).toEqual([]);
  });

  it('writes back drift from a session-generated instruction file on disk (D15)', async () => {
    const th = home();
    const { paths } = scenario(th);
    // A session view generated on disk with an edited inline sub-block.
    const adapter = makeFixtureAdapter();
    const viewRoot = join(paths.live, 'S1', adapter.id);
    mkdirSync(viewRoot, { recursive: true });
    const open = '<!-- >>> agentenv:writing/base.md >>> managed — do not edit between markers -->';
    const close = '<!-- <<< agentenv:writing/base.md <<< -->';
    // The composer renders `open\n<body>\nclose`; a body of "SESSION EDIT\n" (the
    // edited store content, trailing newline included) leaves a blank line here.
    writeFileSync(join(viewRoot, 'INSTRUCTIONS.md'), `# user\n\n${open}\nSESSION EDIT\n\n${close}\n`);

    const result = await driftSweep({ paths, adapters: [adapter], env: th.env });
    expect(result.sessionInstructionsSynced).toBe(1);
    expect(readFileSync(join(paths.envDir('writing'), 'instructions', 'base.md'), 'utf8')).toBe(
      'SESSION EDIT\n',
    );
  });
});
