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
 * F6/3+4 (SECURITY) — an `Authorization` header that does NOT unambiguously correspond to
 * canonical `auth.bearer_env` is an AMBIGUOUS drift. agentenv must not keep it, must not
 * drop it, and must not guess: it leaves canonical `auth` UNCHANGED and warns.
 *
 * Round 2 guessed in both directions, and both guesses were unsafe:
 *
 *  - replacing a `Bearer ${OLD}` header with something else KEPT `auth.bearer_env: OLD`
 *    alongside the new header. `shapeCodexServer` maps `auth.bearer_env` →
 *    `bearer_token_env_var` unconditionally, so Codex went on authenticating with the
 *    token the user believed they had just revoked — in a harness they were not looking at.
 *  - deleting a SHADOWING header (a `Basic` one, say) silently dropped an unrelated
 *    `auth.bearer_env` the user never saw, because `hadAuthorization` was treated as a
 *    statement about `auth`.
 */

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'agentenv-wbauth-'));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function mcpSurface(adapter: Adapter): ConfigKeysSurface {
  return adapter.surfaces.find((s) => s.id === 'mcp') as ConfigKeysSurface;
}

function envWith(yaml: string): string {
  const dir = tmp();
  mkdirSync(join(dir, 'mcp'), { recursive: true });
  writeFileSync(join(dir, 'mcp', 'servers.yaml'), yaml);
  return dir;
}

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

interface Folded {
  def: Record<string, JsonValue>;
  warnings: string[];
}

async function foldOne(
  adapter: Adapter,
  yaml: string,
  name: string,
  harnessValue: JsonValue,
): Promise<Folded> {
  const dir = envWith(yaml);
  const surface = mcpSurface(adapter);
  const warnings: string[] = [];
  const mutations = await adapter.syncBackConfigKeys!(
    surface,
    { style: 'keyed', keyPath: [...surface.keyPath, name], canonicalValue: harnessValue },
    { envContentDir: dir, projectRoot: null, onWarn: (m) => warnings.push(m) },
  );
  const all = parseYaml(mutations[0]!.content) as Record<string, Record<string, JsonValue>>;
  return { def: all[name]!, warnings };
}

function obj(v: JsonValue): Record<string, JsonValue> {
  return v as Record<string, JsonValue>;
}

/** Set the drifted entry's `Authorization` header in whatever shape `adapter` compiles. */
function withAuthorization(
  adapter: Adapter,
  compiled: Record<string, JsonValue>,
  value: JsonValue | undefined,
): Record<string, JsonValue> {
  const out = { ...compiled };
  if (adapter.id === 'codex') {
    const headers = { ...(obj(out.http_headers ?? {}) as Record<string, JsonValue>) };
    if (value === undefined) delete headers.Authorization;
    else headers.Authorization = value;
    if (Object.keys(headers).length > 0) out.http_headers = headers;
    else delete out.http_headers;
    return out;
  }
  const headers = { ...(obj(out.headers ?? {}) as Record<string, JsonValue>) };
  if (value === undefined) delete headers.Authorization;
  else headers.Authorization = value;
  if (Object.keys(headers).length > 0) out.headers = headers;
  else delete out.headers;
  return out;
}

/** The harness's own spelling of a `${VAR}` placeholder. */
function placeholder(adapter: Adapter, name: string): string {
  if (adapter.id === 'cursor') return `\${env:${name}}`;
  if (adapter.id === 'opencode') return `{env:${name}}`;
  return `\${${name}}`;
}

const HEADER_ADAPTERS: Adapter[] = [claudeAdapter, cursorAdapter, opencodeAdapter];

// ---------------------------------------------------------------------------
// F6/3 — replacing a bearer header must NOT leave the old credential live
// ---------------------------------------------------------------------------

const PRIOR_BEARER =
  'linear:\n' +
  '  transport: http\n' +
  '  url: https://mcp.linear.app/mcp\n' +
  '  auth:\n' +
  '    bearer_env: OLD_TOKEN\n';

describe('F6/3: replacing a bearer credential is AMBIGUOUS, never a silent keep', () => {
  for (const adapter of HEADER_ADAPTERS) {
    it(`${adapter.id}: a non-bearer replacement leaves auth unchanged AND warns`, async () => {
      const compiled = obj(await compileOne(adapter, PRIOR_BEARER, 'linear'));
      const replaced = withAuthorization(
        adapter,
        compiled,
        `Basic ${placeholder(adapter, 'NEW_CREDS')}`,
      );
      const { def, warnings } = await foldOne(adapter, PRIOR_BEARER, 'linear', replaced);

      // Unchanged — agentenv does not decide whether this was a revocation.
      expect(def.auth).toEqual({ bearer_env: 'OLD_TOKEN' });
      // …but the user is TOLD, by server name and field, so they can act.
      expect(warnings.join('\n')).toMatch(/linear/);
      expect(warnings.join('\n')).toMatch(/auth/i);
      expect(warnings.join('\n')).toMatch(/OLD_TOKEN/);
      // The warning must never carry the header value itself.
      expect(warnings.join('\n')).not.toMatch(/NEW_CREDS/);
    });
  }

  it('codex refuses to reuse a bearer that an Authorization header shadows', async () => {
    // The canonical entry that F6/3 produces: a live `auth.bearer_env` PLUS a header the
    // user just wrote. Codex must not go on sending the old token behind their back.
    const shadowed =
      'linear:\n' +
      '  transport: http\n' +
      '  url: https://mcp.linear.app/mcp\n' +
      '  auth:\n' +
      '    bearer_env: OLD_TOKEN\n' +
      '  headers:\n' +
      '    Authorization: "Basic ${NEW_CREDS}"\n';
    const compiled = obj(await compileOne(codexAdapter, shadowed, 'linear'));
    expect(compiled.bearer_token_env_var).toBeUndefined();
    expect(compiled.http_headers).toEqual({ Authorization: 'Basic ${NEW_CREDS}' });
  });

  it('a bearer VAR RENAME is unambiguous and still propagates', async () => {
    for (const adapter of HEADER_ADAPTERS) {
      const compiled = obj(await compileOne(adapter, PRIOR_BEARER, 'linear'));
      const renamed = withAuthorization(
        adapter,
        compiled,
        `Bearer ${placeholder(adapter, 'NEW_TOKEN')}`,
      );
      const { def, warnings } = await foldOne(adapter, PRIOR_BEARER, 'linear', renamed);
      expect(def.auth).toEqual({ bearer_env: 'NEW_TOKEN' });
      expect(def.headers).toBeUndefined();
      expect(warnings).toEqual([]);
    }
  });

  it('DELETING an unshadowed bearer header is unambiguous and still removes auth', async () => {
    for (const adapter of HEADER_ADAPTERS) {
      const compiled = obj(await compileOne(adapter, PRIOR_BEARER, 'linear'));
      const removed = withAuthorization(adapter, compiled, undefined);
      const { def, warnings } = await foldOne(adapter, PRIOR_BEARER, 'linear', removed);
      expect(def.auth).toBeUndefined();
      expect(warnings).toEqual([]);
    }
  });

  it('an UNTOUCHED bearer header round-trips with no warning', async () => {
    for (const adapter of HEADER_ADAPTERS) {
      const compiled = obj(await compileOne(adapter, PRIOR_BEARER, 'linear'));
      const { def, warnings } = await foldOne(adapter, PRIOR_BEARER, 'linear', {
        ...compiled,
        url: 'https://mcp.linear.app/mcp?v=2',
      });
      expect(def.auth).toEqual({ bearer_env: 'OLD_TOKEN' });
      expect(def.headers).toBeUndefined();
      expect(warnings).toEqual([]);
    }
  });

  it('a NEW bearer header where canonical had none is unambiguous', async () => {
    const priorNoAuth = 'plain:\n  transport: http\n  url: https://plain.example.com/mcp\n';
    for (const adapter of HEADER_ADAPTERS) {
      const compiled = obj(await compileOne(adapter, priorNoAuth, 'plain'));
      const added = withAuthorization(
        adapter,
        compiled,
        `Bearer ${placeholder(adapter, 'FRESH_TOKEN')}`,
      );
      const { def, warnings } = await foldOne(adapter, priorNoAuth, 'plain', added);
      expect(def.auth).toEqual({ bearer_env: 'FRESH_TOKEN' });
      expect(warnings).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// F6/4 — deleting a SHADOWING header must not silently drop an unrelated auth
// ---------------------------------------------------------------------------

const PRIOR_SHADOWED =
  'shadow:\n' +
  '  transport: http\n' +
  '  url: https://shadow.example.com/mcp\n' +
  '  auth:\n' +
  '    bearer_env: SHADOW_TOKEN\n' +
  '  headers:\n' +
  '    Authorization: "Basic ${SHADOW_BASIC}"\n';

describe('F6/4: touching a SHADOWING header says nothing about auth', () => {
  for (const adapter of [...HEADER_ADAPTERS, codexAdapter]) {
    it(`${adapter.id}: deleting it leaves auth unchanged AND warns`, async () => {
      const compiled = obj(await compileOne(adapter, PRIOR_SHADOWED, 'shadow'));
      const removed = withAuthorization(adapter, compiled, undefined);
      const { def, warnings } = await foldOne(adapter, PRIOR_SHADOWED, 'shadow', removed);
      expect(def.auth).toEqual({ bearer_env: 'SHADOW_TOKEN' });
      expect(warnings.join('\n')).toMatch(/shadow/);
      expect(warnings.join('\n')).toMatch(/SHADOW_TOKEN/);
      expect(warnings.join('\n')).not.toMatch(/SHADOW_BASIC/);
    });

    it(`${adapter.id}: leaving it alone keeps auth and stays quiet`, async () => {
      const compiled = obj(await compileOne(adapter, PRIOR_SHADOWED, 'shadow'));
      const { def, warnings } = await foldOne(adapter, PRIOR_SHADOWED, 'shadow', {
        ...compiled,
        url: 'https://shadow.example.com/mcp?v=2',
      });
      expect(def.auth).toEqual({ bearer_env: 'SHADOW_TOKEN' });
      expect(def.headers).toEqual({ Authorization: 'Basic ${SHADOW_BASIC}' });
      expect(warnings).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// Codex's own exact mapping is unaffected
// ---------------------------------------------------------------------------

describe('codex `bearer_token_env_var` remains an exact, unambiguous mapping', () => {
  it('removing it removes canonical auth', async () => {
    const compiled = obj(await compileOne(codexAdapter, PRIOR_BEARER, 'linear'));
    expect(compiled.bearer_token_env_var).toBe('OLD_TOKEN');
    const { def, warnings } = await foldOne(codexAdapter, PRIOR_BEARER, 'linear', {
      url: 'https://mcp.linear.app/mcp',
    });
    expect(def.auth).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('renaming it renames canonical auth', async () => {
    const { def, warnings } = await foldOne(codexAdapter, PRIOR_BEARER, 'linear', {
      url: 'https://mcp.linear.app/mcp',
      bearer_token_env_var: 'NEW_TOKEN',
    });
    expect(def.auth).toEqual({ bearer_env: 'NEW_TOKEN' });
    expect(warnings).toEqual([]);
  });
});
