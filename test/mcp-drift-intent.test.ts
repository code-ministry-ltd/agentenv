import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Adapter, ConfigKeysDriftReport, ConfigKeysSurface } from '../src/adapter.js';
import { claudeAdapter } from '../src/adapters/claude.js';
import { codexAdapter } from '../src/adapters/codex.js';
import { cursorAdapter } from '../src/adapters/cursor.js';
import { opencodeAdapter } from '../src/adapters/opencode.js';
import type { JsonValue } from '../src/config-keys.js';
import { driftKinds } from './helpers.js';

/**
 * The drift REPORT must name what the harness expresses unambiguously, and must not invent
 * a difference where the harness shape is lossy — the same classification the abandoned
 * write-back needed, now used to DESCRIBE rather than to DECIDE.
 *
 * These are the cases that broke earlier rounds, re-pinned as report-correctness cases:
 *
 *  1. `transport` is reported changed only from a NATIVE discriminator (Claude/Cursor
 *     `type`); where the shape is non-injective (OpenCode `type:'remote'`, Codex's bare
 *     `url` table) an unrelated edit must NOT report a transport change.
 *  2. Authority is FAMILY-AWARE: an edit on a remote server must not report `command`/
 *     `args`/`env` as removed, nor a stdio edit report `url`/`headers` — unless the FAMILY
 *     genuinely changed, when the departed family's keys go with it.
 *  3. A field the shaper DEFAULTED (OpenCode `enabled:true`) is only reported when the
 *     harness value differs from what the shaper actually emitted for the prior def.
 *  4. Contradictory discriminators are reported as an ambiguity NOTE, never as a resolved
 *     change.
 *
 * Every case also asserts `mcp/servers.yaml` is byte-identical afterwards: classification
 * READS it, and nothing on this path may write it.
 */

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'agentenv-drift-intent-'));
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
 * Classify ONE harness-shaped value for `name` against the prior canonical `yaml`, exactly
 * as the drift sweep does for a server the user edited in the harness's own config file.
 * Asserts on the way out that `servers.yaml` is byte-identical — the whole point.
 */
async function describeOne(
  adapter: Adapter,
  yaml: string,
  name: string,
  harnessValue: JsonValue,
): Promise<ConfigKeysDriftReport | null> {
  const dir = envWith(yaml);
  const surface = mcpSurface(adapter);
  const storeFile = join(dir, 'mcp', 'servers.yaml');
  const before = readFileSync(storeFile);
  const report = await adapter.describeConfigKeysDrift!(
    surface,
    { style: 'keyed', keyPath: [...surface.keyPath, name], canonicalValue: harnessValue },
    { envContentDir: dir, projectRoot: null },
  );
  expect(readFileSync(storeFile).equals(before)).toBe(true);
  return report;
}

/** `describeOne` reduced to the `field → kind` map the assertions read. */
async function kinds(
  adapter: Adapter,
  yaml: string,
  name: string,
  harnessValue: JsonValue,
): Promise<Record<string, string>> {
  return driftKinds(await describeOne(adapter, yaml, name, harnessValue));
}

function obj(v: JsonValue): Record<string, JsonValue> {
  return v as Record<string, JsonValue>;
}

const ALL: Adapter[] = [claudeAdapter, cursorAdapter, opencodeAdapter, codexAdapter];

// ---------------------------------------------------------------------------
// 1. transport: report a NATIVE discriminator change; stay silent where lossy
// ---------------------------------------------------------------------------

describe('a native `type` edit is reported; a lossy shape reports no transport change', () => {
  const PRIOR_SSE = 'linear:\n  transport: sse\n  url: https://mcp.linear.app/sse\n';

  for (const adapter of [claudeAdapter, cursorAdapter]) {
    it(`${adapter.id}: user changes \`type\` sse → http — reported as a transport change`, async () => {
      const compiled = obj(await compileOne(adapter, PRIOR_SSE, 'linear'));
      expect(compiled.type).toBe('sse'); // the harness expresses it NATIVELY
      expect(await kinds(adapter, PRIOR_SSE, 'linear', { ...compiled, type: 'http' })).toEqual({
        transport: 'changed',
      });
    });

    it(`${adapter.id}: an UNTOUCHED \`type\` beside a url edit reports only the url`, async () => {
      const compiled = obj(await compileOne(adapter, PRIOR_SSE, 'linear'));
      expect(
        await kinds(adapter, PRIOR_SSE, 'linear', {
          ...compiled,
          url: 'https://mcp.linear.app/sse?v=2',
        }),
      ).toEqual({ url: 'changed' });
    });
  }

  for (const adapter of [opencodeAdapter, codexAdapter]) {
    it(`${adapter.id}: the shape cannot express sse|http, so no transport change is claimed`, async () => {
      // Claiming `transport: changed` here would send the user to "fix" an sse endpoint
      // into http — the F4 collapse, now as a false report instead of a false write.
      const compiled = obj(await compileOne(adapter, PRIOR_SSE, 'linear'));
      expect(
        await kinds(adapter, PRIOR_SSE, 'linear', {
          ...compiled,
          url: 'https://mcp.linear.app/sse?v=2',
        }),
      ).toEqual({ url: 'changed' });
    });
  }
});

describe("agentenv's own normalisation is never reported as the user's change", () => {
  // A servers.yaml a user wrote in harness shape: `type` is the transport, there is no
  // `transport` key. Every shaper honours it as the transport hint, so the two spellings
  // are equivalent and a `type` → `transport` rewrite is not a difference to act on.
  const PRIOR_TYPE_SSE = 'linear:\n  type: sse\n  url: https://mcp.linear.app/sse\n';

  it('codex: a url edit over a hand-authored `type: sse` reports only the url', async () => {
    expect(obj(await compileOne(codexAdapter, PRIOR_TYPE_SSE, 'linear'))).toEqual({
      url: 'https://mcp.linear.app/sse',
    }); // Codex has no `type` of its own
    expect(
      await kinds(codexAdapter, PRIOR_TYPE_SSE, 'linear', {
        url: 'https://mcp.linear.app/sse?v=2',
      }),
    ).toEqual({ url: 'changed' });
  });

  it('a BESPOKE `type` is left alone by every adapter (not a canonical transport)', async () => {
    const priorWs = 'ws:\n  type: websocket\n  url: wss://bespoke.example.com/ws\n';
    const bespoke = { type: 'websocket', url: 'wss://bespoke.example.com/ws' };
    // Claude treats `type` as the transport hint, so `websocket` is bespoke → passthrough.
    expect(await compileOne(claudeAdapter, priorWs, 'ws')).toEqual(bespoke);
    // Codex must not silently read the same entry as a plain HTTP table.
    expect(await compileOne(codexAdapter, priorWs, 'ws')).toEqual(bespoke);

    expect(
      await kinds(codexAdapter, priorWs, 'ws', {
        ...bespoke,
        url: 'wss://bespoke.example.com/ws2',
      }),
    ).toEqual({ url: 'changed' });
  });
});

// ---------------------------------------------------------------------------
// 2. family-aware authority
// ---------------------------------------------------------------------------

describe('authority is family-aware — a branch only speaks for what it emits', () => {
  // `env` on a REMOTE canonical server: no adapter's remote branch emits it, so no adapter
  // may report it as removed.
  const PRIOR_REMOTE_WITH_ENV =
    'docs:\n' +
    '  transport: http\n' +
    '  url: https://docs.example.com/mcp\n' +
    '  env:\n' +
    '    PROXY: http://localhost:3128\n' +
    '  timeout: 30000\n';

  for (const adapter of ALL) {
    it(`${adapter.id}: a url edit on a remote server says nothing about \`env\`/\`timeout\``, async () => {
      const compiled = obj(await compileOne(adapter, PRIOR_REMOTE_WITH_ENV, 'docs'));
      expect(
        await kinds(adapter, PRIOR_REMOTE_WITH_ENV, 'docs', {
          ...compiled,
          url: 'https://docs.example.com/mcp?v=2',
        }),
      ).toEqual({ url: 'changed' });
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

  for (const adapter of ALL) {
    it(`${adapter.id}: a command edit on a stdio server says nothing about \`headers\``, async () => {
      const edited = obj(await compileOne(adapter, PRIOR_STDIO_WITH_HEADERS, 'gh'));
      // Each harness spells the command line differently; edit whichever it emitted.
      if (Array.isArray(edited.command)) edited.command = ['npx', '-y', 'srv2'];
      else edited.command = 'npx2';
      const reported = await kinds(adapter, PRIOR_STDIO_WITH_HEADERS, 'gh', edited);
      expect(reported.headers).toBeUndefined();
      // The command line itself IS reported, however this harness spells it.
      expect(reported.command ?? reported.args).toBe('changed');
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

  it('claude-code: stdio → remote reports command/args/env as removed', async () => {
    expect(
      await kinds(claudeAdapter, PRIOR_STDIO, 'gh', {
        type: 'http',
        url: 'https://gh.example.com/mcp',
      }),
    ).toEqual({
      transport: 'changed',
      command: 'removed',
      args: 'removed',
      env: 'removed',
      url: 'added',
    });
  });

  it('claude-code: remote → stdio reports url/auth as removed', async () => {
    const priorRemote =
      'linear:\n' +
      '  transport: http\n' +
      '  url: https://mcp.linear.app/mcp\n' +
      '  auth:\n' +
      '    bearer_env: TOKEN\n';
    expect(
      await kinds(claudeAdapter, priorRemote, 'linear', { type: 'stdio', command: 'linear-mcp' }),
    ).toEqual({ transport: 'changed', url: 'removed', auth: 'removed', command: 'added' });
  });

  it('claude-code: DELETING `env` in the harness is reported as a removal', async () => {
    const compiled = obj(await compileOne(claudeAdapter, PRIOR_STDIO, 'gh'));
    delete compiled.env;
    expect(await kinds(claudeAdapter, PRIOR_STDIO, 'gh', compiled)).toEqual({ env: 'removed' });
  });
});

// ---------------------------------------------------------------------------
// 2b. the bespoke PASSTHROUGH is authoritative for everything it emits
// ---------------------------------------------------------------------------

describe('a bespoke passthrough reports deletions too', () => {
  const PRIOR_BESPOKE =
    'ws:\n' +
    '  transport: websocket\n' +
    '  url: wss://bespoke.example.com/ws\n' +
    '  timeout: 30000\n';

  for (const adapter of ALL) {
    it(`${adapter.id}: deleting a field from the passed-through entry is reported`, async () => {
      const compiled = obj(await compileOne(adapter, PRIOR_BESPOKE, 'ws'));
      // The passthrough emits the canonical def VERBATIM, so it saw `timeout` and wrote
      // it — its absence from the harness config is a real user deletion.
      expect(compiled.timeout).toBe(30000);
      const edited = { ...compiled };
      delete edited.timeout;
      expect(await kinds(adapter, PRIOR_BESPOKE, 'ws', edited)).toEqual({ timeout: 'removed' });
    });
  }

  it('claude-code: the un-inferable fallback reports the whole gutted entry', async () => {
    // Neither a Claude discriminator nor an inferable one — the entry the user gutted.
    const prior = 'x:\n  transport: http\n  url: https://x.example.com/mcp\n  timeout: 5\n';
    expect(await kinds(claudeAdapter, prior, 'x', { note: 'wip' })).toEqual({
      transport: 'removed',
      url: 'removed',
      timeout: 'removed',
      note: 'added',
    });
  });
});

// ---------------------------------------------------------------------------
// 2c. contradictory discriminators are an ambiguity NOTE, never a resolved change
// ---------------------------------------------------------------------------

describe('a hand-written canonical `transport` beside a harness `type`', () => {
  const PRIOR_STDIO_SPLIT = 'gh:\n  transport: stdio\n  command: x\n  args: ["a"]\n';

  it('opencode: reports the transport as ambiguous, not as both shapes at once', async () => {
    const compiled = obj(await compileOne(opencodeAdapter, PRIOR_STDIO_SPLIT, 'gh'));
    expect(compiled).toEqual({ type: 'local', command: ['x', 'a'], enabled: true });
    // The user hand-writes a canonical `transport` into opencode.json beside `type`.
    const report = await describeOne(opencodeAdapter, PRIOR_STDIO_SPLIT, 'gh', {
      ...compiled,
      transport: 'websocket',
    });
    // NOT `command:['x','a']` + `args:['a']` (the arg duplicated) + `type` + `enabled`.
    expect(driftKinds(report)).toEqual({ transport: 'changed (noted)' });
    const note = report!.changes.find((c) => c.field === 'transport')!.note!;
    expect(note).toMatch(/cannot tell/);
    // A report is a VALUE-FREE channel (D6): it names the conflicting fields, never the
    // drifted value. `type` is safe to echo (it is one of the shaper's own fixed
    // discriminators); the hand-written `transport` is an arbitrary user string, so it
    // must not reach stderr — the same reason a diff says `changed url`, not the URLs.
    expect(note).not.toMatch(/websocket/);
    expect(note).toMatch(/transport/);
  });

  it('claude-code: reports the transport as ambiguous', async () => {
    // Claude's stdio shape DOES carry `type: 'stdio'`, so a hand-written `transport`
    // beside it is a genuine contradiction.
    const compiled = obj(await compileOne(claudeAdapter, PRIOR_STDIO_SPLIT, 'gh'));
    expect(compiled.type).toBe('stdio');
    expect(
      await kinds(claudeAdapter, PRIOR_STDIO_SPLIT, 'gh', { ...compiled, transport: 'websocket' }),
    ).toEqual({ transport: 'changed (noted)' });
  });

  it('cursor: reports the transport as ambiguous on a remote entry', async () => {
    // Cursor's stdio shape carries no `type` at all, so the contradiction can only arise
    // on a remote entry — where `type` IS Cursor's own discriminator.
    const priorRemote = 'docs:\n  transport: http\n  url: https://docs.example.com/mcp\n';
    const compiled = obj(await compileOne(cursorAdapter, priorRemote, 'docs'));
    expect(compiled.type).toBe('http');
    expect(
      await kinds(cursorAdapter, priorRemote, 'docs', { ...compiled, transport: 'websocket' }),
    ).toEqual({ transport: 'changed (noted)' });
  });

  it('cursor: a `transport` with NO competing discriminator is taken at face value', async () => {
    // Cursor's stdio entry has no `type`, so nothing contradicts the user's `transport`:
    // this is the ordinary bespoke passthrough, reported plainly and with no caveat.
    const compiled = obj(await compileOne(cursorAdapter, PRIOR_STDIO_SPLIT, 'gh'));
    expect(
      await kinds(cursorAdapter, PRIOR_STDIO_SPLIT, 'gh', {
        ...compiled,
        transport: 'websocket',
      }),
    ).toEqual({ transport: 'changed' });
  });
});

// ---------------------------------------------------------------------------
// 3. OpenCode `enabled`: a shaper DEFAULT is not a user statement
// ---------------------------------------------------------------------------

describe('OpenCode `enabled` is only reported when the user actually changed it', () => {
  const PRIOR_MAYBE = 'weird:\n  transport: stdio\n  command: echo\n  enabled: maybe\n';

  it('a non-boolean canonical `enabled` is not reported for an unrelated edit', async () => {
    const compiled = obj(await compileOne(opencodeAdapter, PRIOR_MAYBE, 'weird'));
    expect(compiled.enabled).toBe(true); // the shaper's default, not the user's word
    expect(
      await kinds(opencodeAdapter, PRIOR_MAYBE, 'weird', { ...compiled, userAdded: 'x' }),
    ).toEqual({ userAdded: 'added' });
  });

  it('a real `enabled:false` edit IS reported', async () => {
    const compiled = obj(await compileOne(opencodeAdapter, PRIOR_MAYBE, 'weird'));
    expect(
      await kinds(opencodeAdapter, PRIOR_MAYBE, 'weird', { ...compiled, enabled: false }),
    ).toEqual({ enabled: 'changed' });
  });

  it('re-enabling a canonically disabled server IS reported', async () => {
    const priorOff = 'off:\n  transport: stdio\n  command: echo\n  enabled: false\n';
    const compiled = obj(await compileOne(opencodeAdapter, priorOff, 'off'));
    expect(compiled.enabled).toBe(false);
    expect(await kinds(opencodeAdapter, priorOff, 'off', { ...compiled, enabled: true })).toEqual({
      enabled: 'changed',
    });
  });
});

// ---------------------------------------------------------------------------
// 4. degenerate harness values
// ---------------------------------------------------------------------------

describe('a harness entry that is no longer an object', () => {
  for (const adapter of ALL) {
    it(`${adapter.id}: reports the whole entry, with a note`, async () => {
      const prior = 'gh:\n  transport: stdio\n  command: npx\n';
      const report = await describeOne(adapter, prior, 'gh', 'not-an-object');
      expect(report!.changes).toHaveLength(1);
      expect(report!.changes[0]!).toMatchObject({ field: '', kind: 'changed' });
      expect(report!.changes[0]!.note).toMatch(/no longer holds an object/);
    });
  }
});
