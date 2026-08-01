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
 * SECURITY — an `Authorization` header that does NOT unambiguously correspond to canonical
 * `auth.bearer_env` is an AMBIGUOUS drift. Under the v1 contract nothing is written either
 * way, so the question is what the report SAYS: it must point at `auth.bearer_env`, say
 * plainly that agentenv cannot tell what the edit meant, and name the env VAR — never a
 * credential value.
 *
 * The two unsafe guesses an earlier round made are the reason this must never be resolved
 * automatically:
 *
 *  - replacing a `Bearer ${OLD}` header with something else KEPT `auth.bearer_env: OLD`
 *    alongside the new header. `shapeCodexServer` maps `auth.bearer_env` →
 *    `bearer_token_env_var` unconditionally, so Codex went on authenticating with the token
 *    the user believed they had just revoked — in a harness they were not looking at.
 *  - deleting a SHADOWING header (a `Basic` one, say) silently dropped an unrelated
 *    `auth.bearer_env` the user never saw.
 *
 * Both are now the user's call, made with the report in front of them.
 */

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'agentenv-drift-auth-'));
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

/** Classify one drifted harness value; assert `servers.yaml` came through untouched. */
async function describeOne(
  adapter: Adapter,
  yaml: string,
  name: string,
  harnessValue: JsonValue,
): Promise<ConfigKeysDriftReport> {
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
  return report!;
}

/** Every note in a report, joined — what the user actually reads about an ambiguity. */
function notes(report: ConfigKeysDriftReport): string {
  return report.changes
    .map((c) => c.note ?? '')
    .filter((n) => n !== '')
    .join('\n');
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
// Replacing a bearer header is AMBIGUOUS — reported as such, never resolved
// ---------------------------------------------------------------------------

const PRIOR_BEARER =
  'linear:\n' +
  '  transport: http\n' +
  '  url: https://mcp.linear.app/mcp\n' +
  '  auth:\n' +
  '    bearer_env: OLD_TOKEN\n';

describe('replacing a bearer credential is reported as ambiguous', () => {
  for (const adapter of HEADER_ADAPTERS) {
    it(`${adapter.id}: a non-bearer replacement is flagged against auth.bearer_env`, async () => {
      const compiled = obj(await compileOne(adapter, PRIOR_BEARER, 'linear'));
      const replaced = withAuthorization(
        adapter,
        compiled,
        `Basic ${placeholder(adapter, 'NEW_CREDS')}`,
      );
      const report = await describeOne(adapter, PRIOR_BEARER, 'linear', replaced);

      // agentenv does not decide whether this was a revocation — it says so, by field.
      expect(driftKinds(report)).toEqual({
        headers: 'added',
        'auth.bearer_env': 'changed (noted)',
      });
      expect(report.entry).toBe('linear');
      expect(notes(report)).toMatch(/cannot tell/);
      expect(notes(report)).toMatch(/OLD_TOKEN/); // the env VAR name is safe to print
      // The report must never carry the header value itself.
      expect(JSON.stringify(report)).not.toMatch(/NEW_CREDS/);
    });
  }

  it('codex refuses to compile a bearer that an Authorization header shadows', async () => {
    // The canonical entry this ambiguity leaves behind: a live `auth.bearer_env` PLUS a
    // header the user just wrote. Codex must not go on sending the old token behind their
    // back while they decide.
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

  it('a bearer VAR RENAME is unambiguous and reported plainly', async () => {
    for (const adapter of HEADER_ADAPTERS) {
      const compiled = obj(await compileOne(adapter, PRIOR_BEARER, 'linear'));
      const renamed = withAuthorization(
        adapter,
        compiled,
        `Bearer ${placeholder(adapter, 'NEW_TOKEN')}`,
      );
      const report = await describeOne(adapter, PRIOR_BEARER, 'linear', renamed);
      expect(driftKinds(report)).toEqual({ 'auth.bearer_env': 'changed' });
    }
  });

  it('DELETING an unshadowed bearer header is unambiguous and reported as a removal', async () => {
    for (const adapter of HEADER_ADAPTERS) {
      const compiled = obj(await compileOne(adapter, PRIOR_BEARER, 'linear'));
      const removed = withAuthorization(adapter, compiled, undefined);
      expect(driftKinds(await describeOne(adapter, PRIOR_BEARER, 'linear', removed))).toEqual({
        auth: 'removed',
      });
    }
  });

  it('an UNTOUCHED bearer header is not reported at all', async () => {
    for (const adapter of HEADER_ADAPTERS) {
      const compiled = obj(await compileOne(adapter, PRIOR_BEARER, 'linear'));
      expect(
        driftKinds(
          await describeOne(adapter, PRIOR_BEARER, 'linear', {
            ...compiled,
            url: 'https://mcp.linear.app/mcp?v=2',
          }),
        ),
      ).toEqual({ url: 'changed' });
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
      expect(driftKinds(await describeOne(adapter, priorNoAuth, 'plain', added))).toEqual({
        auth: 'added',
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Touching a SHADOWING header says nothing reliable about auth
// ---------------------------------------------------------------------------

const PRIOR_SHADOWED =
  'shadow:\n' +
  '  transport: http\n' +
  '  url: https://shadow.example.com/mcp\n' +
  '  auth:\n' +
  '    bearer_env: SHADOW_TOKEN\n' +
  '  headers:\n' +
  '    Authorization: "Basic ${SHADOW_BASIC}"\n';

describe('touching a SHADOWING header is reported as ambiguous, not as an auth removal', () => {
  for (const adapter of [...HEADER_ADAPTERS, codexAdapter]) {
    it(`${adapter.id}: deleting it flags auth.bearer_env rather than dropping it`, async () => {
      const compiled = obj(await compileOne(adapter, PRIOR_SHADOWED, 'shadow'));
      const removed = withAuthorization(adapter, compiled, undefined);
      const report = await describeOne(adapter, PRIOR_SHADOWED, 'shadow', removed);
      expect(driftKinds(report)).toEqual({
        headers: 'removed',
        'auth.bearer_env': 'changed (noted)',
      });
      expect(notes(report)).toMatch(/SHADOW_TOKEN/);
      // The shadowing header's own placeholder is a value — never echoed.
      expect(JSON.stringify(report)).not.toMatch(/SHADOW_BASIC/);
    });

    it(`${adapter.id}: leaving it alone reports nothing about auth`, async () => {
      const compiled = obj(await compileOne(adapter, PRIOR_SHADOWED, 'shadow'));
      expect(
        driftKinds(
          await describeOne(adapter, PRIOR_SHADOWED, 'shadow', {
            ...compiled,
            url: 'https://shadow.example.com/mcp?v=2',
          }),
        ),
      ).toEqual({ url: 'changed' });
    });
  }
});

// ---------------------------------------------------------------------------
// Codex's own exact mapping stays exact
// ---------------------------------------------------------------------------

describe('codex `bearer_token_env_var` remains an exact, unambiguous mapping', () => {
  it('removing it is reported as an auth removal, with no caveat', async () => {
    const compiled = obj(await compileOne(codexAdapter, PRIOR_BEARER, 'linear'));
    expect(compiled.bearer_token_env_var).toBe('OLD_TOKEN');
    expect(
      driftKinds(
        await describeOne(codexAdapter, PRIOR_BEARER, 'linear', {
          url: 'https://mcp.linear.app/mcp',
        }),
      ),
    ).toEqual({ auth: 'removed' });
  });

  it('renaming it is reported as a bearer_env change, with no caveat', async () => {
    expect(
      driftKinds(
        await describeOne(codexAdapter, PRIOR_BEARER, 'linear', {
          url: 'https://mcp.linear.app/mcp',
          bearer_token_env_var: 'NEW_TOKEN',
        }),
      ),
    ).toEqual({ 'auth.bearer_env': 'changed' });
  });
});
