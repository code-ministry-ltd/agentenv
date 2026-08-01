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
 * F6/7 (SECURITY) — the write-back path must not commit a resolved secret literal to the
 * git-backed `mcp/servers.yaml`.
 *
 * `restoreSecrets` puts the `${VAR}` placeholder back into every field agentenv itself
 * flagged at COMPILE time. It cannot know about a field the user hand-created in the
 * harness config, and on a `substitutePlaceholders` surface (Codex) it cannot know about a
 * field the user pasted a resolved literal into. Round 2 carries every field over verbatim,
 * so both flow straight into the store; the pre-commit scan is a heuristic backstop that
 * misses e.g. `fallbackUrl`, and when it DOES fire it wedges every later store sync rather
 * than sanitising.
 *
 * So the guard belongs on the write-back itself: a value that looks like a resolved secret
 * is not persisted, the canonical field is left as it was, and the user is told.
 */

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'agentenv-wbsecret-'));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A synthetic opaque credential. Deliberately NOT a provider-prefixed shape (no `ghp_`,
 * no `sk-`), so this test file cannot itself trip a push-protection scanner — it exercises
 * the high-entropy rule, which is what catches a secret in a field nobody named `token`.
 */
const RESOLVED_LITERAL = 'Kf9RmZq2VtLp7XwCd4NbHs8JyGe3Uo1A';

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

async function foldOne(
  adapter: Adapter,
  yaml: string,
  name: string,
  harnessValue: JsonValue,
): Promise<{ def: Record<string, JsonValue>; yaml: string; warnings: string[] }> {
  const dir = envWith(yaml);
  const surface = mcpSurface(adapter);
  const warnings: string[] = [];
  const mutations = await adapter.syncBackConfigKeys!(
    surface,
    { style: 'keyed', keyPath: [...surface.keyPath, name], canonicalValue: harnessValue },
    { envContentDir: dir, projectRoot: null, onWarn: (m) => warnings.push(m) },
  );
  const content = mutations[0]!.content;
  const all = parseYaml(content) as Record<string, Record<string, JsonValue>>;
  return { def: all[name]!, yaml: content, warnings };
}

function obj(v: JsonValue): Record<string, JsonValue> {
  return v as Record<string, JsonValue>;
}

const ALL: Adapter[] = [claudeAdapter, cursorAdapter, opencodeAdapter, codexAdapter];

describe('F6/7: a resolved secret literal never reaches servers.yaml', () => {
  const PRIOR_REMOTE = 'docs:\n  transport: http\n  url: https://docs.example.com/mcp\n';

  for (const adapter of ALL) {
    it(`${adapter.id}: a hand-created field holding a credential is refused`, async () => {
      const compiled = obj(await compileOne(adapter, PRIOR_REMOTE, 'docs'));
      // The exact case the pre-commit heuristic misses: an innocuously-named field.
      const edited = { ...compiled, fallbackUrl: RESOLVED_LITERAL };
      const { def, yaml, warnings } = await foldOne(adapter, PRIOR_REMOTE, 'docs', edited);

      expect(yaml).not.toContain(RESOLVED_LITERAL);
      expect(def.fallbackUrl).toBeUndefined();
      expect(warnings.join('\n')).toMatch(/docs/);
      expect(warnings.join('\n')).toMatch(/fallbackUrl/);
      // The warning must never repeat the secret it is refusing.
      expect(warnings.join('\n')).not.toContain(RESOLVED_LITERAL);
    });
  }

  it('codex: a literal pasted over a placeholder leaves the placeholder in place', async () => {
    // Codex is the `substitutePlaceholders` surface — the one harness whose real config
    // legitimately holds resolved literals, so a copy-paste between fields is easy.
    const prior = 'gh:\n  transport: stdio\n  command: npx\n  env:\n    TOKEN: "${TOKEN}"\n';
    const { def, yaml, warnings } = await foldOne(codexAdapter, prior, 'gh', {
      command: 'npx',
      env: { TOKEN: RESOLVED_LITERAL },
    });
    expect(yaml).not.toContain(RESOLVED_LITERAL);
    expect(def.env).toEqual({ TOKEN: '${TOKEN}' });
    expect(warnings.join('\n')).toMatch(/env\.TOKEN/);
  });

  it('an ordinary edit is untouched and silent', async () => {
    for (const adapter of ALL) {
      const compiled = obj(await compileOne(adapter, PRIOR_REMOTE, 'docs'));
      const { def, warnings } = await foldOne(adapter, PRIOR_REMOTE, 'docs', {
        ...compiled,
        url: 'https://docs.example.com/mcp?v=2',
        userAdded: 'kept',
      });
      expect(def.url).toBe('https://docs.example.com/mcp?v=2');
      expect(def.userAdded).toBe('kept');
      expect(warnings).toEqual([]);
    }
  });

  it('a `${VAR}` placeholder is never mistaken for a literal', async () => {
    const prior = 'gh:\n  transport: stdio\n  command: npx\n';
    for (const adapter of ALL) {
      const compiled = obj(await compileOne(adapter, prior, 'gh'));
      const { def, warnings } = await foldOne(adapter, prior, 'gh', {
        ...compiled,
        env: { TOKEN: adapter.id === 'opencode' ? '{env:TOKEN}' : '${TOKEN}' },
      });
      expect(def.env).toEqual({ TOKEN: '${TOKEN}' });
      expect(warnings).toEqual([]);
    }
  });
});
