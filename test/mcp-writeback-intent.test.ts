import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import type { Adapter, ConfigKeysSurface } from '../src/adapter.js';
import { claudeAdapter } from '../src/adapters/claude.js';
import { codexAdapter } from '../src/adapters/codex.js';
import { cursorAdapter } from '../src/adapters/cursor.js';
import { opencodeAdapter } from '../src/adapters/opencode.js';
import type { JsonValue } from '../src/config-keys.js';

/**
 * F6 — MCP drift write-back must PROPAGATE what the harness expresses unambiguously and
 * must NOT invent an answer where the harness shape is lossy. Round 2's overlay fixed the
 * "reconstruction destroys data" bug by preserving too much: it also preserved values the
 * user had just deliberately CHANGED, and it let one branch's `supersedes` delete fields
 * that branch never emits.
 *
 * The rules these tests pin down:
 *
 *  1. `transport` propagates from a NATIVE discriminator (Claude/Cursor `type`) and is
 *     preserved from the prior def only where the harness shape is genuinely
 *     non-injective (OpenCode `type:'remote'`, Codex's bare `url` table).
 *  2. `supersedes` is FAMILY-AWARE: the remote branch may not delete `command`/`args`/`env`
 *     and the stdio branch may not delete `url`/`headers` — unless the FAMILY changed, when
 *     the departed family's keys go with it.
 *  3. A field the shaper defaulted (OpenCode `enabled:true`) is only written back when the
 *     harness value differs from what the shaper actually emitted for the prior def.
 */

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'agentenv-wbintent-'));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function mcpSurface(adapter: Adapter): ConfigKeysSurface {
  return adapter.surfaces.find((s) => s.id === 'mcp') as ConfigKeysSurface;
}

/** Write a prior canonical servers.yaml into a fresh env content dir; return the dir. */
function envWith(yaml: string): string {
  const dir = tmp();
  mkdirSync(join(dir, 'mcp'), { recursive: true });
  writeFileSync(join(dir, 'mcp', 'servers.yaml'), yaml);
  return dir;
}

/** What `adapter` compiles server `name` to from the prior canonical `yaml`. */
async function compileOne(adapter: Adapter, yaml: string, name: string): Promise<JsonValue> {
  const injections = await adapter.compileConfigKeys(mcpSurface(adapter), {
    envContentDir: envWith(yaml),
    projectRoot: null,
  });
  const hit = injections.find(
    (i) => i.style === 'keyed' && i.keyPath[i.keyPath.length - 1] === name,
  );
  if (!hit || hit.style !== 'keyed') throw new Error(`no injection for ${name}`);
  return hit.value;
}

/**
 * Fold ONE harness-shaped value for `name` back onto the prior canonical `yaml` and return
 * the resulting canonical def. This is exactly what the drift sweep does for a server the
 * user edited in the harness's own config file.
 */
async function foldOne(
  adapter: Adapter,
  yaml: string,
  name: string,
  harnessValue: JsonValue,
  warnings: string[] = [],
): Promise<Record<string, JsonValue>> {
  const dir = envWith(yaml);
  const surface = mcpSurface(adapter);
  const mutations = await adapter.syncBackConfigKeys!(
    surface,
    { style: 'keyed', keyPath: [...surface.keyPath, name], canonicalValue: harnessValue },
    { envContentDir: dir, projectRoot: null, onWarn: (m) => warnings.push(m) },
  );
  const all = parseYaml(mutations[0]!.content) as Record<string, Record<string, JsonValue>>;
  return all[name]!;
}

function obj(v: JsonValue): Record<string, JsonValue> {
  return v as Record<string, JsonValue>;
}

// ---------------------------------------------------------------------------
// 1. transport: propagate a NATIVE discriminator; preserve only where lossy
// ---------------------------------------------------------------------------

describe('F6/1: a native `type` edit propagates; a lossy shape preserves the prior', () => {
  const PRIOR_SSE = 'linear:\n  transport: sse\n  url: https://mcp.linear.app/sse\n';

  for (const adapter of [claudeAdapter, cursorAdapter]) {
    it(`${adapter.id}: user changes \`type\` sse → http, canonical follows`, async () => {
      const compiled = obj(await compileOne(adapter, PRIOR_SSE, 'linear'));
      expect(compiled.type).toBe('sse'); // the harness expresses it NATIVELY
      const edited = { ...compiled, type: 'http' }; // the user's own edit
      const written = await foldOne(adapter, PRIOR_SSE, 'linear', edited);
      expect(written.transport).toBe('http');
    });

    it(`${adapter.id}: an UNTOUCHED \`type\` still round-trips as sse`, async () => {
      const compiled = obj(await compileOne(adapter, PRIOR_SSE, 'linear'));
      const written = await foldOne(adapter, PRIOR_SSE, 'linear', {
        ...compiled,
        url: 'https://mcp.linear.app/sse?v=2',
      });
      expect(written.transport).toBe('sse');
    });
  }

  for (const adapter of [opencodeAdapter, codexAdapter]) {
    it(`${adapter.id}: the shape cannot express sse|http, so the prior sse survives`, async () => {
      const compiled = obj(await compileOne(adapter, PRIOR_SSE, 'linear'));
      const edited = { ...compiled, url: 'https://mcp.linear.app/sse?v=2' };
      const written = await foldOne(adapter, PRIOR_SSE, 'linear', edited);
      expect(written.transport).toBe('sse');
    });
  }
});

// ---------------------------------------------------------------------------
// 1b. Codex must read a hand-authored `type` exactly like the other three
// ---------------------------------------------------------------------------

describe('F6/2: Codex honours a hand-authored `type` and never leaves a stale one', () => {
  // A servers.yaml a user wrote in harness shape: `type` is the transport, there is no
  // `transport` key. Claude/Cursor/OpenCode all read it as the transport hint.
  const PRIOR_TYPE_SSE = 'linear:\n  type: sse\n  url: https://mcp.linear.app/sse\n';

  it('a Codex url edit leaves NO `type` beside a freshly-inferred `transport`', async () => {
    const compiled = obj(await compileOne(codexAdapter, PRIOR_TYPE_SSE, 'linear'));
    expect(compiled).toEqual({ url: 'https://mcp.linear.app/sse' }); // Codex has no `type`
    const written = await foldOne(codexAdapter, PRIOR_TYPE_SSE, 'linear', {
      url: 'https://mcp.linear.app/sse?v=2',
    });
    // A stale `type: sse` beside `transport: http` is self-contradicting: Claude would
    // then compile `type: http` and call an SSE endpoint as HTTP.
    expect(written).toEqual({ transport: 'sse', url: 'https://mcp.linear.app/sse?v=2' });
  });

  it('a BESPOKE `type` is passed through by Codex, exactly as Claude passes it', async () => {
    const priorWs = 'ws:\n  type: websocket\n  url: wss://bespoke.example.com/ws\n';
    const bespoke = { type: 'websocket', url: 'wss://bespoke.example.com/ws' };
    // Claude treats `type` as the transport hint, so `websocket` is bespoke → passthrough.
    expect(await compileOne(claudeAdapter, priorWs, 'ws')).toEqual(bespoke);
    // Codex must not silently compile the same entry to a plain HTTP table.
    expect(await compileOne(codexAdapter, priorWs, 'ws')).toEqual(bespoke);

    const written = await foldOne(codexAdapter, priorWs, 'ws', {
      ...bespoke,
      url: 'wss://bespoke.example.com/ws2',
    });
    expect(written).toEqual({ type: 'websocket', url: 'wss://bespoke.example.com/ws2' });
  });
});

// ---------------------------------------------------------------------------
// 2. family-aware supersedes
// ---------------------------------------------------------------------------

describe('F6/2: `supersedes` is family-aware — a branch only claims what it emits', () => {
  // `env` on a REMOTE canonical server: no adapter's remote branch emits it, so no
  // adapter's remote branch may delete it.
  const PRIOR_REMOTE_WITH_ENV =
    'docs:\n' +
    '  transport: http\n' +
    '  url: https://docs.example.com/mcp\n' +
    '  env:\n' +
    '    PROXY: http://localhost:3128\n' +
    '  timeout: 30000\n';

  for (const adapter of [claudeAdapter, cursorAdapter, opencodeAdapter, codexAdapter]) {
    it(`${adapter.id}: a url edit on a remote server keeps canonical \`env\``, async () => {
      const compiled = obj(await compileOne(adapter, PRIOR_REMOTE_WITH_ENV, 'docs'));
      const edited = { ...compiled, url: 'https://docs.example.com/mcp?v=2' };
      const written = await foldOne(adapter, PRIOR_REMOTE_WITH_ENV, 'docs', edited);
      expect(written.env).toEqual({ PROXY: 'http://localhost:3128' });
      expect(written.timeout).toBe(30000);
      expect(written.url).toBe('https://docs.example.com/mcp?v=2');
    });
  }

  // `headers` on a STDIO canonical server: symmetrical — the stdio branch emits none.
  const PRIOR_STDIO_WITH_HEADERS =
    'gh:\n' +
    '  transport: stdio\n' +
    '  command: npx\n' +
    '  args: ["-y", "srv"]\n' +
    '  headers:\n' +
    '    X-Legacy: keep-me\n';

  for (const adapter of [claudeAdapter, cursorAdapter, opencodeAdapter, codexAdapter]) {
    it(`${adapter.id}: a command edit on a stdio server keeps canonical \`headers\``, async () => {
      const compiled = obj(await compileOne(adapter, PRIOR_STDIO_WITH_HEADERS, 'gh'));
      const edited = { ...compiled };
      // Each harness spells the command line differently; edit whichever it emitted.
      if (Array.isArray(edited.command)) edited.command = ['npx', '-y', 'srv2'];
      else edited.command = 'npx2';
      const written = await foldOne(adapter, PRIOR_STDIO_WITH_HEADERS, 'gh', edited);
      expect(written.headers).toEqual({ 'X-Legacy': 'keep-me' });
    });
  }

  // A genuine FAMILY change still takes the departed family's keys with it.
  const PRIOR_STDIO =
    'gh:\n' +
    '  transport: stdio\n' +
    '  command: npx\n' +
    '  args: ["-y", "srv"]\n' +
    '  env:\n' +
    '    TOKEN: "${TOKEN}"\n';

  it('claude-code: stdio → remote drops command/args/env', async () => {
    const written = await foldOne(claudeAdapter, PRIOR_STDIO, 'gh', {
      type: 'http',
      url: 'https://gh.example.com/mcp',
    });
    expect(written).toEqual({ transport: 'http', url: 'https://gh.example.com/mcp' });
  });

  it('claude-code: remote → stdio drops url/headers/auth', async () => {
    const priorRemote =
      'linear:\n' +
      '  transport: http\n' +
      '  url: https://mcp.linear.app/mcp\n' +
      '  auth:\n' +
      '    bearer_env: TOKEN\n';
    const written = await foldOne(claudeAdapter, priorRemote, 'linear', {
      type: 'stdio',
      command: 'linear-mcp',
    });
    expect(written).toEqual({ transport: 'stdio', command: 'linear-mcp' });
  });

  it('claude-code: DELETING `env` in the harness still deletes it from canonical', async () => {
    const compiled = obj(await compileOne(claudeAdapter, PRIOR_STDIO, 'gh'));
    delete compiled.env;
    const written = await foldOne(claudeAdapter, PRIOR_STDIO, 'gh', compiled);
    expect(written.env).toBeUndefined();
    expect(written.command).toBe('npx');
  });
});

// ---------------------------------------------------------------------------
// 3. OpenCode `enabled`: a shaper DEFAULT is not a user statement
// ---------------------------------------------------------------------------

describe('F6/3: OpenCode `enabled` only propagates when the user actually changed it', () => {
  const PRIOR_MAYBE = 'weird:\n  transport: stdio\n  command: echo\n  enabled: maybe\n';

  it('a non-boolean canonical `enabled` survives an unrelated edit', async () => {
    const compiled = obj(await compileOne(opencodeAdapter, PRIOR_MAYBE, 'weird'));
    expect(compiled.enabled).toBe(true); // the shaper's default, not the user's word
    const written = await foldOne(opencodeAdapter, PRIOR_MAYBE, 'weird', {
      ...compiled,
      userAdded: 'x',
    });
    expect(written.enabled).toBe('maybe');
  });

  it('a real `enabled:false` edit still propagates', async () => {
    const compiled = obj(await compileOne(opencodeAdapter, PRIOR_MAYBE, 'weird'));
    const written = await foldOne(opencodeAdapter, PRIOR_MAYBE, 'weird', {
      ...compiled,
      enabled: false,
    });
    expect(written.enabled).toBe(false);
  });

  it('re-enabling a canonically disabled server propagates `enabled:true`', async () => {
    const priorOff = 'off:\n  transport: stdio\n  command: echo\n  enabled: false\n';
    const compiled = obj(await compileOne(opencodeAdapter, priorOff, 'off'));
    expect(compiled.enabled).toBe(false);
    const written = await foldOne(opencodeAdapter, priorOff, 'off', {
      ...compiled,
      enabled: true,
    });
    expect(written.enabled).toBe(true);
  });
});
