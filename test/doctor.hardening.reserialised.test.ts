import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { run } from '../src/cli.js';
import { injectKeyed, type JsonValue } from '../src/config-keys.js';
import { beginTransaction } from '../src/journal.js';
import { withLock } from '../src/lock.js';
import { resolvePaths, type Paths } from '../src/paths.js';
import {
  expectRealHomeUntouched,
  guardRealHome,
  makeTempHome,
  type RealHomeGuard,
  type TempHome,
} from './helpers.js';

/**
 * Task 5.1 — a harness that rewrites its OWN config file with agentenv's keys
 * still in it. Real harnesses re-emit their config from a parsed tree whenever
 * they change a setting, so the bytes agentenv wrote are routinely replaced:
 * keys reordered, indentation changed, quotes normalised, comments (including
 * agentenv's own TOML block markers) dropped, TOML tables re-expanded or
 * collapsed into inline tables, line endings converted.
 *
 * DETECTION MUST SURVIVE ALL OF THAT. Ownership is anchored to a hash over a
 * stable stringification of the PARSED value, so a pure reserialisation is not
 * drift and must not be reported — while a reserialisation that also CHANGES the
 * value must still be caught and reconciled.
 */

const homes: TempHome[] = [];
const guards: RealHomeGuard[] = [];

function home(): TempHome {
  guards.push(guardRealHome());
  const h = makeTempHome();
  homes.push(h);
  return h;
}

afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
  for (const g of guards.splice(0)) expectRealHomeUntouched(g);
});

interface Injected {
  paths: Paths;
  cfgFile: string;
}

/**
 * Inject one owned key through the real mechanism, then GC the backup a committed
 * transaction de-references — so any later doctor verdict is unambiguously about
 * the fault the test injects, not about post-commit housekeeping.
 */
async function inject(
  th: TempHome,
  opts: {
    fileName: string;
    initial: string;
    format: 'json' | 'toml';
    keyPath: string[];
    value: JsonValue;
    secretFields?: Record<string, string>;
  },
): Promise<Injected> {
  const paths = resolvePaths(th.env);
  mkdirSync(paths.base, { recursive: true });
  const realHome = join(th.home, 'real');
  mkdirSync(realHome, { recursive: true });
  const cfgFile = join(realHome, opts.fileName);
  writeFileSync(cfgFile, opts.initial);

  await withLock(paths, async () => {
    const tx = await beginTransaction(paths);
    await injectKeyed(paths, tx, {
      file: cfgFile,
      format: opts.format,
      keyPath: opts.keyPath,
      value: opts.value,
      ownerEnv: 'writing',
      ...(opts.secretFields ? { secretFields: opts.secretFields } : {}),
    });
    await tx.commit();
  });

  const settle = await run(['doctor', '--repair'], { env: th.env });
  expect(settle.code, `${settle.stdout}${settle.stderr ?? ''}`).toBe(0);
  return { paths, cfgFile };
}

const USER_JSON = '{\n  "theme": "dark",\n  "mcpServers": {\n    "user": { "url": "u" }\n  }\n}\n';

/** Re-emit a JSON config the way a harness does: reordered, reindented, CRLF, commented. */
function reserialiseJson(cfgFile: string, mutate: (o: Record<string, JsonValue>) => void): void {
  const parsed = JSON.parse(readFileSync(cfgFile, 'utf8')) as Record<string, JsonValue>;
  mutate(parsed);
  const reordered: Record<string, JsonValue> = {};
  for (const key of Object.keys(parsed).sort().reverse()) reordered[key] = parsed[key] as JsonValue;
  const text = `// rewritten by the harness\n${JSON.stringify(reordered, null, 4)}`;
  writeFileSync(cfgFile, text.replace(/\n/g, '\r\n'));
}

/** Re-emit a TOML config through a serialiser: comments (ours included) are lost. */
function reserialiseToml(cfgFile: string, mutate: (o: Record<string, unknown>) => void): void {
  const parsed = parseToml(readFileSync(cfgFile, 'utf8')) as Record<string, unknown>;
  mutate(parsed);
  writeFileSync(cfgFile, `${stringifyToml(parsed)}\n`);
}

describe('doctor.hardening: harness-reserialised configs', () => {
  it('a pure JSON reserialisation is NOT reported as drift', async () => {
    const th = home();
    const { cfgFile } = await inject(th, {
      fileName: 'config.json',
      initial: USER_JSON,
      format: 'json',
      keyPath: ['mcpServers', 'linear'],
      value: { url: 'https://linear', env: { A: '1' } },
    });

    // Same value, entirely different bytes: reordered keys, 4-space indent, a
    // leading comment, CRLF line endings.
    reserialiseJson(cfgFile, () => {});
    expect(readFileSync(cfgFile, 'utf8')).toContain('\r\n');

    const res = await run(['doctor'], { env: th.env });
    expect(res.code, `${res.stdout}${res.stderr ?? ''}`).toBe(0);
  });

  it('a JSON reserialisation that also changes the value is caught and reconciled', async () => {
    const th = home();
    const { cfgFile } = await inject(th, {
      fileName: 'config.json',
      initial: USER_JSON,
      format: 'json',
      keyPath: ['mcpServers', 'linear'],
      value: { url: 'https://linear' },
    });

    reserialiseJson(cfgFile, (o) => {
      const servers = o.mcpServers as Record<string, JsonValue>;
      servers.linear = { url: 'https://linear/v2', extra: true };
    });

    const res = await run(['doctor'], { env: th.env });
    expect(res.code).not.toBe(0);
    expect(`${res.stdout}${res.stderr ?? ''}`).toContain('reserialised-config');

    const repaired = await run(['doctor', '--repair'], { env: th.env });
    expect(repaired.code, `${repaired.stdout}${repaired.stderr ?? ''}`).toBe(0);

    // The harness's value stands and the user's own keys are untouched.
    const cfg = JSON.parse(
      readFileSync(cfgFile, 'utf8').replace(/\r\n/g, '\n').replace('// rewritten by the harness\n', ''),
    ) as { theme: string; mcpServers: Record<string, { url: string } | undefined> };
    expect(cfg.mcpServers.linear?.url).toBe('https://linear/v2');
    expect(cfg.mcpServers.user?.url).toBe('u');
    expect(cfg.theme).toBe('dark');

    expect((await run(['doctor'], { env: th.env })).code).toBe(0);
  });

  it('a TOML rewrite that drops agentenv block markers is NOT reported as drift', async () => {
    const th = home();
    const { cfgFile } = await inject(th, {
      fileName: 'config.toml',
      initial: 'model = "gpt-5"\n\n[mcp_servers.user]\ncommand = "u"\n',
      format: 'toml',
      keyPath: ['mcp_servers', 'linear'],
      value: { command: 'npx', args: ['linear-mcp'] },
    });
    expect(readFileSync(cfgFile, 'utf8')).toContain('>>> agentenv:config-key');

    // A harness round-trips the file through its own TOML serialiser: comments —
    // including the block markers agentenv wrote — do not survive, and the table
    // is re-emitted in the serialiser's own layout.
    reserialiseToml(cfgFile, () => {});
    const rewritten = readFileSync(cfgFile, 'utf8');
    expect(rewritten).not.toContain('agentenv:config-key');

    const res = await run(['doctor'], { env: th.env });
    expect(res.code, `${res.stdout}${res.stderr ?? ''}`).toBe(0);
  });

  it('a TOML rewrite that also changes the value is caught and reconciled', async () => {
    const th = home();
    const { cfgFile } = await inject(th, {
      fileName: 'config.toml',
      initial: 'model = "gpt-5"\n\n[mcp_servers.user]\ncommand = "u"\n',
      format: 'toml',
      keyPath: ['mcp_servers', 'linear'],
      value: { command: 'npx', args: ['linear-mcp'] },
    });

    reserialiseToml(cfgFile, (o) => {
      const servers = o.mcp_servers as Record<string, unknown>;
      servers.linear = { command: 'npx', args: ['linear-mcp', '--stdio'] };
    });

    const res = await run(['doctor'], { env: th.env });
    expect(res.code).not.toBe(0);
    expect(`${res.stdout}${res.stderr ?? ''}`).toContain('reserialised-config');

    const repaired = await run(['doctor', '--repair'], { env: th.env });
    expect(repaired.code, `${repaired.stdout}${repaired.stderr ?? ''}`).toBe(0);

    const cfg = parseToml(readFileSync(cfgFile, 'utf8')) as {
      model: string;
      mcp_servers: Record<string, { args?: string[] } | undefined>;
    };
    expect(cfg.mcp_servers.linear?.args).toEqual(['npx', 'linear-mcp', '--stdio'].slice(1));
    expect(cfg.mcp_servers.user).toBeDefined();
    expect(cfg.model).toBe('gpt-5');

    expect((await run(['doctor'], { env: th.env })).code).toBe(0);
  });

  it('reconciling a drifted secret-bearing key never writes the literal into the store', async () => {
    const th = home();
    const secret = 'lin_api_SUPERSECRET_VALUE';
    const { paths, cfgFile } = await inject(th, {
      fileName: 'config.json',
      initial: USER_JSON,
      format: 'json',
      keyPath: ['mcpServers', 'linear'],
      // A *substitute* surface resolved `${LINEAR_TOKEN}` to a literal for the
      // harness, while the record keeps the placeholder (D6).
      value: { url: 'https://linear', headers: { Authorization: secret } },
      secretFields: { 'headers.Authorization': '${LINEAR_TOKEN}' },
    });

    reserialiseJson(cfgFile, (o) => {
      const servers = o.mcpServers as Record<string, JsonValue>;
      servers.linear = {
        url: 'https://linear/v2',
        headers: { Authorization: secret },
      };
    });

    const repaired = await run(['doctor', '--repair'], { env: th.env });
    expect(repaired.code, `${repaired.stdout}${repaired.stderr ?? ''}`).toBe(0);
    expect(`${repaired.stdout}${repaired.stderr ?? ''}`).not.toContain(secret);

    // The manifest is the thing that gets synced: it must never carry the literal.
    const state = readFileSync(paths.state, 'utf8');
    expect(state, 'a resolved secret literal reached state.json').not.toContain(secret);
    expect(state).toContain('${LINEAR_TOKEN}');

    expect((await run(['doctor'], { env: th.env })).code).toBe(0);
  });

  it('a config a harness left UNPARSEABLE is reported, not crashed on', async () => {
    const th = home();
    const { cfgFile } = await inject(th, {
      fileName: 'config.json',
      initial: USER_JSON,
      format: 'json',
      keyPath: ['mcpServers', 'linear'],
      value: { url: 'https://linear' },
    });

    // A half-written harness rewrite: the file no longer parses at all.
    writeFileSync(cfgFile, '{\n  "mcpServers": {\n    "linear": {\n');

    const res = await run(['doctor'], { env: th.env });
    expect(res.code).not.toBe(0);
    expect(`${res.stdout}${res.stderr ?? ''}`).toContain('could not parse');

    // `--repair` cannot fix a file only a human can, but it must SAY so — not die
    // with a stack trace out of the one command whose job is broken states.
    const repaired = await run(['doctor', '--repair'], { env: th.env });
    expect(repaired.code).toBe(1);
    const out = `${repaired.stdout}${repaired.stderr ?? ''}`;
    expect(out).toContain('could not parse');
    expect(out).toContain('remain after repair');

    // And it must not have touched the broken file while failing.
    expect(readFileSync(cfgFile, 'utf8')).toBe('{\n  "mcpServers": {\n    "linear": {\n');
  });
});
