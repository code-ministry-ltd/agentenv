import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import type { Adapter, ConfigKeysDriftReport, ConfigKeysSurface } from '../src/adapter.js';
import { claudeAdapter } from '../src/adapters/claude.js';
import { codexAdapter } from '../src/adapters/codex.js';
import { cursorAdapter } from '../src/adapters/cursor.js';
import { opencodeAdapter } from '../src/adapters/opencode.js';
import { piAdapter } from '../src/adapters/pi.js';
import type { JsonValue } from '../src/config-keys.js';
import { driftKinds } from './helpers.js';

/**
 * The cross-adapter guarantee, under the v1 "detect and report, never write" contract.
 *
 * `mcp/servers.yaml` is the ONE canonical model every adapter's `compileConfigKeys` reads.
 * Previously a drift write-back by one harness could destroy canonical data another harness
 * needed — a bespoke `transport` re-inferred to `http`, an `sse` collapsed into `http`, a
 * `timeout`/`enabled` dropped, an `auth.bearer_env` lost behind a shadowing header. Three
 * review rounds fixed those one at a time and introduced fresh ones of the same shape.
 *
 * They are all gone by construction now, and this file proves it in two halves:
 *
 *  1. NO harness-side edit can change what any OTHER harness sees, because the sweep does
 *     not write the store at all: `servers.yaml` is byte-identical afterwards, and every
 *     reader compiles exactly what it compiled before.
 *  2. The REPORT is still precise: it names the edited server and exactly the canonical
 *     fields the user touched — no more (over-reporting is the residual form of the old
 *     over-writing bugs) and no less.
 */

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'agentenv-xadapter-'));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * The canonical (D6) servers.yaml every adapter must read. Deliberately wider than the
 * happy path: an `sse` transport, a disabled server, a bespoke transport, a
 * non-`Authorization` header, an `Authorization` header SHADOWING `auth.bearer_env`, a
 * canonical-only extra field (`timeout`), and a `command` authored as an array with
 * an empty `args`.
 */
const CANONICAL_YAML =
  'gh:\n' +
  '  transport: stdio\n' +
  '  command: npx\n' +
  '  args: ["-y", "@modelcontextprotocol/server-github"]\n' +
  '  env:\n' +
  '    TOKEN: "${TOKEN}"\n' +
  'linear:\n' +
  '  transport: sse\n' +
  '  url: https://mcp.linear.app/sse\n' +
  '  auth:\n' +
  '    bearer_env: TOKEN\n' +
  'docs:\n' +
  '  transport: http\n' +
  '  url: https://docs.example.com/mcp\n' +
  '  headers:\n' +
  '    X-Api-Key: "${API_KEY}"\n' +
  '  timeout: 30000\n' +
  'shadow:\n' +
  '  transport: http\n' +
  '  url: https://shadow.example.com/mcp\n' +
  '  auth:\n' +
  '    bearer_env: SHADOW_TOKEN\n' +
  '  headers:\n' +
  '    Authorization: "Basic ${SHADOW_BASIC}"\n' +
  'offswitch:\n' +
  '  transport: stdio\n' +
  '  command: echo\n' +
  '  enabled: false\n' +
  'bespoke:\n' +
  '  transport: websocket\n' +
  '  url: wss://bespoke.example.com/ws\n' +
  'wrapped:\n' +
  '  transport: stdio\n' +
  '  command: ["bash", "-c", "echo hi"]\n' +
  '  args: []\n';

/** The canonical D6 shape of the corpus (parsed once, for the expectations). */
const CANONICAL_SHAPE = parseYaml(CANONICAL_YAML) as Record<string, Record<string, JsonValue>>;

/** The 4 adapters that own an MCP config-keys surface (Pi's MCP is unsupported). */
const MCP_ADAPTERS: Adapter[] = [claudeAdapter, opencodeAdapter, cursorAdapter, codexAdapter];

function mcpSurface(adapter: Adapter): ConfigKeysSurface {
  return adapter.surfaces.find((s) => s.id === 'mcp') as ConfigKeysSurface;
}

function isObj(v: unknown): v is Record<string, JsonValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Write a servers.yaml into a fresh env content dir; return the dir. */
function envWith(yaml: string): string {
  const dir = tmp();
  mkdirSync(join(dir, 'mcp'), { recursive: true });
  writeFileSync(join(dir, 'mcp', 'servers.yaml'), yaml);
  return dir;
}

/** Compile one adapter's MCP surface from a servers.yaml dir into a name→value map. */
async function compileMap(adapter: Adapter, dir: string): Promise<Record<string, JsonValue>> {
  const out = await adapter.compileConfigKeys(mcpSurface(adapter), {
    envContentDir: dir,
    projectRoot: null,
  });
  const map: Record<string, JsonValue> = {};
  for (const inj of out) {
    if (inj.style !== 'keyed') continue;
    const name = inj.keyPath[inj.keyPath.length - 1];
    if (typeof name === 'string') map[name] = inj.value;
  }
  return map;
}

/**
 * A REAL user edit to a harness entry: append a key the harness config did not have, and
 * (where there is one) change the URL. Both are edits a user makes directly in
 * `.claude.json` / `opencode.json` / `mcp.json` / `config.toml` — the only thing that ever
 * triggers a drift classification in production.
 */
function userEdit(value: JsonValue): JsonValue {
  if (!isObj(value)) return value;
  const out: Record<string, JsonValue> = { ...value, userAdded: 'kept' };
  if (typeof out.url === 'string') out.url = `${out.url}?edited=1`;
  return out;
}

/**
 * Simulate `writer`'s harness holding the compiled servers, the USER EDITING every one of
 * them, and the drift sweep classifying each edit. Returns the env dir (whose servers.yaml
 * must be untouched) plus each server's report.
 */
async function driftAll(
  writer: Adapter,
): Promise<{ dir: string; reports: Record<string, ConfigKeysDriftReport> }> {
  const dir = envWith(CANONICAL_YAML);
  const harnessShape = await compileMap(writer, dir); // what the harness config holds
  const surface = mcpSurface(writer);
  const reports: Record<string, ConfigKeysDriftReport> = {};
  for (const [name, value] of Object.entries(harnessShape)) {
    const report = await writer.describeConfigKeysDrift!(
      surface,
      {
        style: 'keyed',
        keyPath: [...surface.keyPath, name],
        canonicalValue: userEdit(value),
      },
      { envContentDir: dir, projectRoot: null },
    );
    reports[name] = report!;
  }
  return { dir, reports };
}

describe('a harness-side MCP edit cannot change what any other harness sees', () => {
  it('Pi has no MCP path at all (its MCP surface is declared unsupported)', () => {
    const pi = piAdapter.surfaces.find((s) => s.id === 'mcp');
    expect(pi?.supported).toBe(false);
  });

  it('every adapter compiles the pristine canonical servers.yaml to a valid native config', async () => {
    const dir = envWith(CANONICAL_YAML);
    for (const reader of MCP_ADAPTERS) {
      const map = await compileMap(reader, dir);
      expect(Object.keys(map).sort()).toEqual(Object.keys(CANONICAL_SHAPE).sort());
      assertReaderFacts(reader, map);
    }
  });

  for (const writer of MCP_ADAPTERS) {
    describe(`after a ${writer.id} user edit to every server`, () => {
      it('leaves mcp/servers.yaml byte-identical', async () => {
        const dir = envWith(CANONICAL_YAML);
        const file = join(dir, 'mcp', 'servers.yaml');
        const before = readFileSync(file);
        await driftAll(writer);
        // driftAll builds its own dir; classify against THIS one too, to pin that the
        // hook never writes the dir it was handed either.
        const surface = mcpSurface(writer);
        for (const [name, value] of Object.entries(await compileMap(writer, dir))) {
          await writer.describeConfigKeysDrift!(
            surface,
            {
              style: 'keyed',
              keyPath: [...surface.keyPath, name],
              canonicalValue: userEdit(value),
            },
            { envContentDir: dir, projectRoot: null },
          );
        }
        expect(readFileSync(file).equals(before)).toBe(true);
      });

      for (const reader of MCP_ADAPTERS) {
        it(`still compiles to the same faithful ${reader.id} config`, async () => {
          // The cross-adapter guarantee, now structural: the store did not move, so every
          // other harness sees exactly what it saw. These are HAND-WRITTEN facts about
          // what each harness must end up seeing — an `sse` that stayed distinct from
          // `http`, a disabled server still disabled, a bespoke transport never turned
          // into http, and no baked secret anywhere.
          const { dir } = await driftAll(writer);
          assertReaderFacts(reader, await compileMap(reader, dir));
        });
      }

      it('reports the edited server and EXACTLY the fields the user touched', async () => {
        const { reports } = await driftAll(writer);
        expect(Object.keys(reports).sort()).toEqual(Object.keys(CANONICAL_SHAPE).sort());
        for (const [name, def] of Object.entries(CANONICAL_SHAPE)) {
          const kinds = driftKinds(reports[name]!);
          expect(reports[name]!.entry).toBe(name);
          expect(reports[name]!.storeRelativePath).toBe(join('mcp', 'servers.yaml'));
          // The edit adds `userAdded` and, where there is one, changes the url.
          const expected: Record<string, string> = { userAdded: 'added' };
          if (typeof def.url === 'string') expected.url = 'changed';
          expect(kinds).toEqual(expected);
        }
      });

      it('never puts a value — least of all a credential — in a report', async () => {
        const { reports } = await driftAll(writer);
        const text = JSON.stringify(reports);
        // Every URL, placeholder and credential in the corpus, plus the edit's own value.
        for (const secretish of [
          '${TOKEN}',
          '${API_KEY}',
          '${SHADOW_BASIC}',
          'mcp.linear.app',
          'docs.example.com',
          'bespoke.example.com',
          'edited=1',
          'kept',
          'echo hi',
        ]) {
          expect(text).not.toContain(secretish);
        }
        expect(text).not.toMatch(/Bearer\s+\S/);
      });
    });
  }
});

/**
 * What each harness must SEE from the corpus. Written out by hand rather than derived, so
 * a store that somehow moved still fails here even if a deep-equality cell tolerated it.
 */
function assertReaderFacts(reader: Adapter, map: Record<string, JsonValue>): void {
  expect(Object.keys(map).sort()).toEqual(Object.keys(CANONICAL_SHAPE).sort());

  if (reader.id === 'claude-code') {
    expect(map.gh).toMatchObject({ type: 'stdio', command: 'npx', env: { TOKEN: '${TOKEN}' } });
    expect(map.linear).toMatchObject({ type: 'sse' });
    expect(map.docs).toMatchObject({ type: 'http', headers: { 'X-Api-Key': '${API_KEY}' } });
    expect(map.shadow).toMatchObject({ headers: { Authorization: 'Basic ${SHADOW_BASIC}' } });
    expect(map.bespoke).toMatchObject({ transport: 'websocket' });
    expect(map.wrapped).toMatchObject({ type: 'stdio', command: ['bash', '-c', 'echo hi'] });
  } else if (reader.id === 'cursor') {
    // Cursor's stdio shape carries no `type`; every placeholder is `${env:VAR}`.
    expect(map.gh).toMatchObject({ command: 'npx', env: { TOKEN: '${env:TOKEN}' } });
    expect(map.linear).toMatchObject({ type: 'sse' });
    expect(map.docs).toMatchObject({ type: 'http', headers: { 'X-Api-Key': '${env:API_KEY}' } });
    expect(map.bespoke).toMatchObject({ transport: 'websocket' });
  } else if (reader.id === 'opencode') {
    // OpenCode flattens command+args and cannot express sse — but MUST keep `enabled`.
    expect(map.gh).toMatchObject({
      type: 'local',
      command: ['npx', '-y', '@modelcontextprotocol/server-github'],
      enabled: true,
      env: { TOKEN: '{env:TOKEN}' },
    });
    expect(map.linear).toMatchObject({ type: 'remote', enabled: true });
    expect(map.offswitch).toMatchObject({ enabled: false });
    expect(map.docs).toMatchObject({ headers: { 'X-Api-Key': '{env:API_KEY}' } });
    expect(map.bespoke).toMatchObject({ transport: 'websocket' });
  } else {
    // Codex: native indirections, so `${TOKEN}` becomes an `env_vars` allowlist entry.
    expect(map.gh).toMatchObject({ command: 'npx', env_vars: ['TOKEN'] });
    expect(map.linear).toMatchObject({ bearer_token_env_var: 'TOKEN' });
    expect(map.docs).toMatchObject({ env_http_headers: { 'X-Api-Key': 'API_KEY' } });
    // A bearer SHADOWED by an Authorization header is never re-emitted.
    expect((map.shadow as Record<string, JsonValue>).bearer_token_env_var).toBeUndefined();
    expect(map.bespoke).toMatchObject({ transport: 'websocket' });
  }

  // No compiled value anywhere may carry a baked secret: every credential is an
  // indirection in one of the three placeholder syntaxes.
  expect(JSON.stringify(map)).not.toMatch(/Bearer [A-Za-z0-9]{8,}/);
}

// ---------------------------------------------------------------------------
// Every KIND of user edit reports precisely, and only, that edit
// ---------------------------------------------------------------------------

/** Classify ONE harness value for `name` against the pristine canonical corpus. */
async function reportOne(
  writer: Adapter,
  name: string,
  harnessValue: JsonValue,
): Promise<Record<string, string>> {
  const dir = envWith(CANONICAL_YAML);
  const surface = mcpSurface(writer);
  const file = join(dir, 'mcp', 'servers.yaml');
  const before = readFileSync(file);
  const report = await writer.describeConfigKeysDrift!(
    surface,
    { style: 'keyed', keyPath: [...surface.keyPath, name], canonicalValue: harnessValue },
    { envContentDir: dir, projectRoot: null },
  );
  expect(readFileSync(file).equals(before)).toBe(true);
  return driftKinds(report);
}

/** What `writer` compiles server `name` to from the pristine corpus. */
async function compiled(writer: Adapter, name: string): Promise<Record<string, JsonValue>> {
  const map = await compileMap(writer, envWith(CANONICAL_YAML));
  return map[name] as Record<string, JsonValue>;
}

describe('every KIND of user edit is reported, and only that edit', () => {
  for (const writer of MCP_ADAPTERS) {
    describe(`after a ${writer.id} edit`, () => {
      it('DELETING a field is reported as a removal (siblings unmentioned)', async () => {
        const value = { ...(await compiled(writer, 'gh')) };
        // Whichever way this harness spells the stdio env, drop it.
        delete value.env;
        delete value.env_vars;
        expect(await reportOne(writer, 'gh', value)).toEqual({ env: 'removed' });
      });

      it('changing the TRANSPORT discriminator reports it only where the harness records it', async () => {
        const value = { ...(await compiled(writer, 'linear')) };
        if (typeof value.type === 'string' && value.type !== 'remote') {
          // Claude/Cursor record http-vs-sse natively: the edit must be reported.
          value.type = 'http';
          expect(await reportOne(writer, 'linear', value)).toEqual({ transport: 'changed' });
        } else {
          // OpenCode/Codex cannot express the difference, so an unrelated edit here must
          // NOT be reported as collapsing the canonical `sse` into `http`.
          value.url = 'https://mcp.linear.app/sse?v=2';
          expect(await reportOne(writer, 'linear', value)).toEqual({ url: 'changed' });
        }
      });

      it('changing COMMAND/ARGS reports the command line and nothing else', async () => {
        const value = { ...(await compiled(writer, 'gh')) };
        if (Array.isArray(value.command)) value.command = ['pnpx', '-y', 'other-server'];
        else {
          value.command = 'pnpx';
          value.args = ['-y', 'other-server'];
        }
        expect(await reportOne(writer, 'gh', value)).toEqual({
          command: 'changed',
          args: 'changed',
        });
      });

      it('changing FAMILY (stdio → remote) reports the stdio-only keys as removed', async () => {
        const remote: Record<string, JsonValue> = { url: 'https://gh.example.com/mcp' };
        if (writer.id === 'opencode') {
          remote.type = 'remote';
          remote.enabled = true;
        } else if (writer.id !== 'codex') {
          remote.type = 'http';
        }
        expect(await reportOne(writer, 'gh', remote)).toEqual({
          transport: 'changed',
          command: 'removed',
          args: 'removed',
          env: 'removed',
          url: 'added',
        });
      });
    });
  }
});

describe('a server with NO canonical entry is reported as a whole-entry addition', () => {
  /**
   * The classification needs a prior canonical def to diff against. With none — a server
   * the user added directly to the harness config — there is nothing to compare field by
   * field, and the irreducible sse-vs-http ambiguity of OpenCode/Codex would make any
   * per-field claim a guess. So the report says the entry is missing from canonical and
   * stops, which is exactly the action the user must take.
   */
  async function reportNew(writer: Adapter, harnessValue: JsonValue) {
    const dir = envWith('other:\n  transport: stdio\n  command: x\n');
    const surface = mcpSurface(writer);
    const file = join(dir, 'mcp', 'servers.yaml');
    const before = readFileSync(file);
    const report = await writer.describeConfigKeysDrift!(
      surface,
      { style: 'keyed', keyPath: [...surface.keyPath, 'fresh'], canonicalValue: harnessValue },
      { envContentDir: dir, projectRoot: null },
    );
    expect(readFileSync(file).equals(before)).toBe(true);
    return report!;
  }

  for (const writer of MCP_ADAPTERS) {
    it(`${writer.id}: names the new server without guessing its canonical fields`, async () => {
      const value: Record<string, JsonValue> = { url: 'https://x/sse' };
      if (writer.id === 'opencode') {
        value.type = 'remote';
        value.enabled = true;
      } else if (writer.id !== 'codex') {
        value.type = 'sse';
      }
      const report = await reportNew(writer, value);
      expect(report.entry).toBe('fresh');
      expect(report.changes).toEqual([{ field: '', kind: 'added' }]);
    });
  }
});
