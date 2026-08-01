import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import type { Adapter, ConfigKeysSurface } from '../src/adapter.js';
import { claudeAdapter } from '../src/adapters/claude.js';
import { codexAdapter } from '../src/adapters/codex.js';
import { cursorAdapter } from '../src/adapters/cursor.js';
import { opencodeAdapter } from '../src/adapters/opencode.js';
import { piAdapter } from '../src/adapters/pi.js';
import type { JsonValue } from '../src/config-keys.js';

/**
 * F1/F5 — the cross-adapter round-trip guarantee (Phase-4 decision D6): the canonical
 * `mcp/servers.yaml` stays D6-canonical across EVERY adapter, and a drift write-back
 * NEVER destroys canonical data the writing harness cannot express.
 *
 * The production trigger for `syncBackConfigKeys` is a USER EDIT to the harness's own
 * config file — never the identity `unshape(shape(canonical))`. So every cell here
 * mutates the compiled harness shape first (a real edit: add a field, change a URL)
 * and only then folds it back, with the env's PRIOR canonical `servers.yaml` in place
 * exactly as production has it. That is what makes the matrix able to fail on:
 *
 *  - F1  a bespoke `transport` (`websocket`) re-inferred to `http` and destroyed;
 *  - F3  a field the unshape whitelist drops (`timeout`, and the user's own addition);
 *  - F4  `sse` collapsed to `http` because OpenCode/Codex cannot express the difference;
 *  - F11 `auth.bearer_env` dropped when a hand-authored `Authorization` header shadows it.
 *
 * The fix is OVERLAY-AND-PRESERVE: the new canonical def is the PRIOR canonical def with
 * only the genuinely-changed fields written over it, so anything the shaper never touched
 * survives verbatim.
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

/** The canonical D6 shape of the pristine corpus (parsed once, for the expectations). */
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
 * A REAL user edit to a harness entry: append a key the harness config did not have,
 * and (where there is one) change the URL. Both are edits a user makes directly in
 * `.claude.json` / `opencode.json` / `mcp.json` / `config.toml` — the ONLY thing that
 * ever triggers `syncBackConfigKeys` in production.
 */
function userEdit(value: JsonValue): JsonValue {
  if (!isObj(value)) return value;
  const out: Record<string, JsonValue> = { ...value, userAdded: 'kept' };
  if (typeof out.url === 'string') out.url = `${out.url}?edited=1`;
  return out;
}

/** The canonical def each server must hold AFTER the user edit is folded back. */
function expectedCanonical(): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [name, def] of Object.entries(CANONICAL_SHAPE)) {
    const next: Record<string, JsonValue> = { ...def, userAdded: 'kept' };
    if (typeof next.url === 'string') next.url = `${next.url}?edited=1`;
    out[name] = next;
  }
  return out;
}

/**
 * Simulate `writer`'s harness holding the compiled servers, the USER EDITING them, then
 * a drift sweep folding each back via `syncBackConfigKeys`. The output dir starts with
 * the PRIOR canonical servers.yaml in place — exactly as `ctx.envContentDir` does in
 * production. Returns the dir whose servers.yaml is the post-write-back file.
 */
async function driftWriteBack(writer: Adapter): Promise<string> {
  const outDir = envWith(CANONICAL_YAML);
  const harnessShape = await compileMap(writer, outDir); // what the harness config holds
  const surface = mcpSurface(writer);
  const keyPrefix = surface.keyPath; // ['mcpServers'] | ['mcp'] | ['mcp_servers']
  for (const [name, value] of Object.entries(harnessShape)) {
    const mutations = await writer.syncBackConfigKeys!(
      surface,
      { style: 'keyed', keyPath: [...keyPrefix, name], canonicalValue: userEdit(value) },
      { envContentDir: outDir, projectRoot: null },
    );
    // Accumulate: each write-back reads the current servers.yaml and folds one server.
    writeFileSync(join(outDir, 'mcp', 'servers.yaml'), mutations[0]!.content);
  }
  return outDir;
}

function readYaml(dir: string): Record<string, JsonValue> {
  return parseYaml(readFileSync(join(dir, 'mcp', 'servers.yaml'), 'utf8')) as Record<
    string,
    JsonValue
  >;
}

describe('F1: canonical servers.yaml round-trips across every adapter', () => {
  it('Pi has no MCP write path (its MCP surface is declared unsupported)', () => {
    const pi = piAdapter.surfaces.find((s) => s.id === 'mcp');
    expect(pi?.supported).toBe(false);
  });

  it('every adapter compiles the pristine canonical servers.yaml to a valid native config', async () => {
    const dir = envWith(CANONICAL_YAML);
    for (const reader of MCP_ADAPTERS) {
      const map = await compileMap(reader, dir);
      expect(Object.keys(map).sort()).toEqual(Object.keys(CANONICAL_SHAPE).sort());
    }
  });

  // The cross-adapter matrix: every writer × every reader, over a USER-EDITED harness value.
  for (const writer of MCP_ADAPTERS) {
    describe(`after ${writer.id} drift + syncBackConfigKeys`, () => {
      it('preserves the whole prior canonical def, overlaying only the user edit', async () => {
        const written = readYaml(await driftWriteBack(writer));
        expect(written).toEqual(expectedCanonical());
      });

      it('keeps a bespoke transport verbatim (F1: `websocket` must not become `http`)', async () => {
        const written = readYaml(await driftWriteBack(writer));
        expect((written.bespoke as Record<string, JsonValue>).transport).toBe('websocket');
      });

      it('keeps `sse` distinct from `http` (F4: the shape is not injective)', async () => {
        const written = readYaml(await driftWriteBack(writer));
        expect((written.linear as Record<string, JsonValue>).transport).toBe('sse');
      });

      it('keeps fields the shaper never touched (F3: `timeout`, `enabled:false`)', async () => {
        const written = readYaml(await driftWriteBack(writer));
        expect((written.docs as Record<string, JsonValue>).timeout).toBe(30000);
        expect((written.offswitch as Record<string, JsonValue>).enabled).toBe(false);
      });

      it("keeps the user's own harness addition (F3: no unshape whitelist)", async () => {
        const written = readYaml(await driftWriteBack(writer));
        for (const name of Object.keys(CANONICAL_SHAPE)) {
          expect((written[name] as Record<string, JsonValue>).userAdded).toBe('kept');
        }
      });

      it('keeps auth.bearer_env shadowed by a hand-authored Authorization header (F11)', async () => {
        const written = readYaml(await driftWriteBack(writer));
        expect((written.shadow as Record<string, JsonValue>).auth).toEqual({
          bearer_env: 'SHADOW_TOKEN',
        });
      });

      for (const reader of MCP_ADAPTERS) {
        it(`still compiles to a faithful ${reader.id} config`, async () => {
          // NOT `compileMap(reader, out) === compileMap(reader, expectedCanonical())` —
          // the first cell already asserts `out === expectedCanonical()`, so that
          // comparison is `f(x) === f(x)` and can never fail independently. These are
          // HAND-WRITTEN facts about what each harness must end up seeing, so a
          // write-back that corrupts the store in a way the deep-equality cell somehow
          // tolerated still fails here.
          assertReaderFacts(reader, await compileMap(reader, await driftWriteBack(writer)));
        });
      }
    });
  }
});

/**
 * What each harness must SEE after any writer's drift write-back, written out by hand
 * rather than derived from the canonical expectation. These are the cross-adapter
 * properties the shared store exists to guarantee: the sse/http distinction survives for
 * the harnesses that can express it, a disabled server stays disabled, a bespoke transport
 * is never turned into http, and no secret is ever baked into a compiled value.
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
    // A bearer SHADOWED by an Authorization header is never re-emitted (F6/3).
    expect((map.shadow as Record<string, JsonValue>).bearer_token_env_var).toBeUndefined();
    expect(map.bespoke).toMatchObject({ transport: 'websocket' });
  }

  // No compiled value anywhere may carry a baked secret: every credential is an
  // indirection in one of the three placeholder syntaxes.
  expect(JSON.stringify(map)).not.toMatch(/Bearer [A-Za-z0-9]{8,}/);
}

// ---------------------------------------------------------------------------
// Every KIND of user edit, not just an addition
// ---------------------------------------------------------------------------

/** Fold ONE harness value for `name` onto the pristine canonical corpus. */
async function foldInto(
  writer: Adapter,
  name: string,
  harnessValue: JsonValue,
): Promise<Record<string, Record<string, JsonValue>>> {
  const dir = envWith(CANONICAL_YAML);
  const surface = mcpSurface(writer);
  const mutations = await writer.syncBackConfigKeys!(
    surface,
    { style: 'keyed', keyPath: [...surface.keyPath, name], canonicalValue: harnessValue },
    { envContentDir: dir, projectRoot: null, onWarn: () => {} },
  );
  return parseYaml(mutations[0]!.content) as Record<string, Record<string, JsonValue>>;
}

/** What `writer` compiles server `name` to from the pristine corpus. */
async function compiled(writer: Adapter, name: string): Promise<Record<string, JsonValue>> {
  const map = await compileMap(writer, envWith(CANONICAL_YAML));
  return map[name] as Record<string, JsonValue>;
}

describe('F1: every KIND of user edit propagates, and only that edit', () => {
  for (const writer of MCP_ADAPTERS) {
    describe(`after a ${writer.id} edit`, () => {
      it('DELETING a field deletes it from canonical (siblings untouched)', async () => {
        const value = { ...(await compiled(writer, 'gh')) };
        // Whichever way this harness spells the stdio env, drop it.
        delete value.env;
        delete value.env_vars;
        const written = await foldInto(writer, 'gh', value);
        expect(written.gh!.env).toBeUndefined();
        expect(written.gh!.command).toBe('npx');
        expect(written.gh!.args).toEqual(['-y', '@modelcontextprotocol/server-github']);
        // Every other server is byte-for-byte what it was.
        for (const other of Object.keys(CANONICAL_SHAPE)) {
          if (other === 'gh') continue;
          expect(written[other]).toEqual(CANONICAL_SHAPE[other]);
        }
      });

      it('changing the TRANSPORT discriminator lands the right canonical transport', async () => {
        const value = { ...(await compiled(writer, 'linear')) };
        if (typeof value.type === 'string' && value.type !== 'remote') {
          // Claude/Cursor record http-vs-sse natively: the edit must propagate.
          value.type = 'http';
          expect((await foldInto(writer, 'linear', value)).linear!.transport).toBe('http');
        } else {
          // OpenCode/Codex cannot express the difference, so an unrelated edit here must
          // NOT collapse the canonical `sse` into `http`.
          value.url = 'https://mcp.linear.app/sse?v=2';
          expect((await foldInto(writer, 'linear', value)).linear!.transport).toBe('sse');
        }
      });

      it('changing COMMAND/ARGS propagates the new command line', async () => {
        const value = { ...(await compiled(writer, 'gh')) };
        if (Array.isArray(value.command)) value.command = ['pnpx', '-y', 'other-server'];
        else {
          value.command = 'pnpx';
          value.args = ['-y', 'other-server'];
        }
        const written = await foldInto(writer, 'gh', value);
        expect(written.gh!.command).toBe('pnpx');
        expect(written.gh!.args).toEqual(['-y', 'other-server']);
        // The canonical-only `env` this branch never emits is still preserved.
        expect(written.gh!.env).toEqual({ TOKEN: '${TOKEN}' });
      });

      it('changing FAMILY (stdio → remote) drops the stdio-only keys', async () => {
        const remote: Record<string, JsonValue> = { url: 'https://gh.example.com/mcp' };
        if (writer.id === 'opencode') {
          remote.type = 'remote';
          remote.enabled = true;
        } else if (writer.id !== 'codex') {
          remote.type = 'http';
        }
        const written = await foldInto(writer, 'gh', remote);
        expect(written.gh).toEqual({ transport: 'http', url: 'https://gh.example.com/mcp' });
      });
    });
  }
});

describe('F4: a server with NO prior canonical entry falls back to inference', () => {
  /**
   * The overlay needs a prior canonical def to preserve. With none (a server the user
   * added directly to the harness config), the ambiguity is IRREDUCIBLE: OpenCode's
   * `type:'remote'` and Codex's bare `url` table each map from BOTH `http` and `sse`,
   * so the write-back must guess, and it guesses `http`. Claude/Cursor keep their
   * native `type`, so they recover `sse` exactly. Documented, not fixable.
   */
  async function foldNew(writer: Adapter, harnessValue: JsonValue): Promise<JsonValue> {
    const dir = envWith('other:\n  transport: stdio\n  command: x\n');
    const surface = mcpSurface(writer);
    const mutations = await writer.syncBackConfigKeys!(
      surface,
      { style: 'keyed', keyPath: [...surface.keyPath, 'fresh'], canonicalValue: harnessValue },
      { envContentDir: dir, projectRoot: null },
    );
    return (parseYaml(mutations[0]!.content) as Record<string, JsonValue>).fresh!;
  }

  it('Claude recovers sse from its native `type`', async () => {
    expect(await foldNew(claudeAdapter, { type: 'sse', url: 'https://x/sse' })).toEqual({
      transport: 'sse',
      url: 'https://x/sse',
    });
  });

  it('Cursor recovers sse from its native `type`', async () => {
    expect(await foldNew(cursorAdapter, { type: 'sse', url: 'https://x/sse' })).toEqual({
      transport: 'sse',
      url: 'https://x/sse',
    });
  });

  it('OpenCode cannot: `remote` collapses http|sse, so a new server infers http', async () => {
    expect(
      await foldNew(opencodeAdapter, { type: 'remote', url: 'https://x/sse', enabled: true }),
    ).toEqual({ transport: 'http', url: 'https://x/sse' });
  });

  it('Codex cannot: a bare url table collapses http|sse, so a new server infers http', async () => {
    expect(await foldNew(codexAdapter, { url: 'https://x/sse' })).toEqual({
      transport: 'http',
      url: 'https://x/sse',
    });
  });
});
