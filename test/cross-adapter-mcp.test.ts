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
 * F1 — the cross-adapter round-trip guarantee (Phase-4 decision D6): the canonical
 * `mcp/servers.yaml` stays D6-canonical across EVERY adapter. A drift write-back by
 * ANY adapter must leave servers.yaml in the pure canonical shape
 * (`transport`/`command`/`url`/`args`/`env:{VAR:"${VAR}"}`/`auth:{bearer_env:VAR}`),
 * NEVER that adapter's harness-normalised shape — otherwise the write-back poisons
 * the server for every OTHER harness (Claude's `type`/`headers`, OpenCode's
 * `{env:VAR}`/`type:'local'`/command-array, Cursor's `${env:VAR}`).
 *
 * The matrix: author a canonical servers.yaml with a stdio + an http server; for EACH
 * MCP-bearing adapter simulate drift (its own harness-shaped value) + `syncBackConfigKeys`,
 * then assert the resulting servers.yaml `compileConfigKeys`-es to EXACTLY the same valid
 * native config for ALL adapters that it would have from the pristine canonical. Pre-fix,
 * Claude/OpenCode/Cursor rows have BROKEN cells (verbatim harness-shape write-back);
 * post-fix every cell is green.
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

/** The canonical (D6) servers.yaml every adapter must read. */
const CANONICAL_YAML =
  'gh:\n' +
  '  transport: stdio\n' +
  '  command: npx\n' +
  '  args: ["-y", "@modelcontextprotocol/server-github"]\n' +
  '  env:\n' +
  '    TOKEN: "${TOKEN}"\n' +
  'linear:\n' +
  '  transport: http\n' +
  '  url: https://mcp.linear.app/mcp\n' +
  '  auth:\n' +
  '    bearer_env: TOKEN\n';

/** The canonical D6 shape each server must round-trip back to, whoever wrote it. */
const CANONICAL_SHAPE: Record<string, JsonValue> = {
  gh: {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { TOKEN: '${TOKEN}' },
  },
  linear: {
    transport: 'http',
    url: 'https://mcp.linear.app/mcp',
    auth: { bearer_env: 'TOKEN' },
  },
};

/** The 4 adapters that own an MCP config-keys surface (Pi's MCP is unsupported). */
const MCP_ADAPTERS: Adapter[] = [claudeAdapter, opencodeAdapter, cursorAdapter, codexAdapter];

function mcpSurface(adapter: Adapter): ConfigKeysSurface {
  return adapter.surfaces.find((s) => s.id === 'mcp') as ConfigKeysSurface;
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
 * Simulate `writer`'s harness holding the compiled (native-shaped) servers, then a
 * drift sweep folding each back via `syncBackConfigKeys`. Returns a NEW env dir whose
 * servers.yaml is the post-write-back file.
 */
async function driftWriteBack(writer: Adapter): Promise<string> {
  const canonicalDir = envWith(CANONICAL_YAML);
  const harnessShape = await compileMap(writer, canonicalDir); // what the harness config holds
  const outDir = tmp();
  mkdirSync(join(outDir, 'mcp'), { recursive: true });
  const surface = mcpSurface(writer);
  const keyPrefix = surface.keyPath; // ['mcpServers'] | ['mcp'] | ['mcp_servers']
  for (const [name, value] of Object.entries(harnessShape)) {
    const mutations = await writer.syncBackConfigKeys!(
      surface,
      { style: 'keyed', keyPath: [...keyPrefix, name], canonicalValue: value },
      { envContentDir: outDir, projectRoot: null },
    );
    // Accumulate: each write-back reads the current servers.yaml and folds one server.
    writeFileSync(join(outDir, 'mcp', 'servers.yaml'), mutations[0]!.content);
  }
  return outDir;
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
      expect(Object.keys(map).sort()).toEqual(['gh', 'linear']);
    }
  });

  // The cross-adapter matrix (spec: BROKEN cells pre-fix, all green after).
  for (const writer of MCP_ADAPTERS) {
    describe(`after ${writer.id} drift + syncBackConfigKeys`, () => {
      it('leaves servers.yaml in the pure D6-canonical shape', async () => {
        const outDir = await driftWriteBack(writer);
        const written = parseYaml(readFileSync(join(outDir, 'mcp', 'servers.yaml'), 'utf8')) as Record<
          string,
          JsonValue
        >;
        expect(written.gh).toEqual(CANONICAL_SHAPE.gh);
        expect(written.linear).toEqual(CANONICAL_SHAPE.linear);
      });

      for (const reader of MCP_ADAPTERS) {
        it(`compiles to a valid config for ${reader.id}`, async () => {
          const outDir = await driftWriteBack(writer);
          const pristine = await compileMap(reader, envWith(CANONICAL_YAML));
          const afterDrift = await compileMap(reader, outDir);
          expect(afterDrift).toEqual(pristine);
        });
      }
    });
  }
});
