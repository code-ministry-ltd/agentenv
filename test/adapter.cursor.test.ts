import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateAdapter, type ConfigKeysSurface } from '../src/adapter.js';
import { cursorAdapter } from '../src/adapters/cursor.js';
import { driftKinds } from './helpers.js';

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'agentenv-cursor-'));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The MCP surface declaration (the single config-keys surface). */
const MCP_SURFACE = cursorAdapter.surfaces.find((s) => s.id === 'mcp') as ConfigKeysSurface;

/** Write `mcp/servers.yaml` under a fresh env content dir; return the dir. */
function envWithServers(yaml: string): string {
  const dir = tmp();
  mkdirSync(join(dir, 'mcp'), { recursive: true });
  writeFileSync(join(dir, 'mcp', 'servers.yaml'), yaml);
  return dir;
}

describe('adapter.cursor — identity & declarations', () => {
  it('is a well-formed adapter (validateAdapter passes)', () => {
    expect(validateAdapter(cursorAdapter)).toBeNull();
  });

  it('declares Cursor identity, session-UNSUPPORTED, and the config-root override', () => {
    expect(cursorAdapter.id).toBe('cursor');
    expect(cursorAdapter.binaryName).toBe('agent');
    // The whole reason for sessionSupported:false in the frozen contract.
    expect(cursorAdapter.sessionSupported).toBe(false);
    expect(cursorAdapter.sessionUnsupportedReason).toMatch(/--global/);
    expect(cursorAdapter.sessionUnsupportedReason).toMatch(/CURSOR_CONFIG_DIR/);
    expect(cursorAdapter.configRootEnv).toBe('CURSOR_CONFIG_DIR');
    expect(cursorAdapter.overrideEnv('/v/root')).toEqual({ CURSOR_CONFIG_DIR: '/v/root' });
  });

  it('realConfigRoot honours a set CURSOR_CONFIG_DIR, else ~/.cursor', () => {
    expect(cursorAdapter.realConfigRoot({ CURSOR_CONFIG_DIR: '/custom' })).toBe('/custom');
    expect(cursorAdapter.realConfigRoot({ CURSOR_CONFIG_DIR: '   ' })).toMatch(/\.cursor$/);
    expect(cursorAdapter.realConfigRoot({})).toMatch(/\.cursor$/);
  });

  it('declares skills (dir-merge), mcp (config-keys, passthrough), and an UNSUPPORTED instructions surface', () => {
    const byId = new Map(cursorAdapter.surfaces.map((s) => [s.id, s]));
    expect(byId.get('skills')).toMatchObject({
      mechanism: 'dir-merge',
      rootRelativePath: 'skills',
      supported: true,
    });
    // The global-instructions gap: Cursor has no clean surface, so status reports it.
    const instructions = byId.get('instructions')!;
    expect(instructions.supported).toBe(false);
    expect(instructions.unsupportedReason).toMatch(/no global-instructions surface/i);
    // MCP: keyed config-keys into mcp.json, PASSTHROUGH (Cursor interpolates ${env:VAR}).
    expect(byId.get('mcp')).toMatchObject({
      mechanism: 'config-keys',
      rootRelativePath: 'mcp.json',
      format: 'json',
      style: 'keyed',
      keyPath: ['mcpServers'],
      substitutePlaceholders: false,
    });
  });
});

describe('adapter.cursor — classifyEntry (D15 two-bucket)', () => {
  it('classifies the surface targets as managed (bucket-2)', () => {
    for (const name of ['skills', 'mcp.json', 'rules']) {
      expect(cursorAdapter.classifyEntry(name)).toBe('managed');
    }
  });

  it('classifies credentials/auth AND every unknown entry as state (bucket-1, the safe unknown)', () => {
    for (const name of [
      'cli-config.json',
      'hooks.json',
      'commands',
      'sessions',
      'worktrees',
      'statsig-cache.json',
      'a-file-a-future-cursor-update-introduced',
    ]) {
      expect(cursorAdapter.classifyEntry(name)).toBe('state');
    }
  });
});

describe('adapter.cursor — compileConfigKeys (MCP → Cursor mcpServers, ${env:VAR} passthrough, D6)', () => {
  it('returns [] when the env contributes no servers.yaml', async () => {
    const out = await cursorAdapter.compileConfigKeys(MCP_SURFACE, {
      envContentDir: tmp(),
      projectRoot: null,
    });
    expect(out).toEqual([]);
  });

  it('shapes a canonical stdio server into Cursor form and rewrites ${VAR} → ${env:VAR}', async () => {
    const dir = envWithServers(
      'github:\n' +
        '  transport: stdio\n' +
        '  command: npx\n' +
        '  args: ["-y", "@modelcontextprotocol/server-github"]\n' +
        '  env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" }\n',
    );
    const out = await cursorAdapter.compileConfigKeys(MCP_SURFACE, {
      envContentDir: dir,
      projectRoot: null,
    });
    expect(out).toHaveLength(1);
    const inj = out[0]!;
    if (inj.style !== 'keyed') throw new Error('unreachable');
    expect(inj.keyPath).toEqual(['mcpServers', 'github']);
    // Cursor stdio: no `type`, and the secret placeholder is rewritten to ${env:VAR}.
    expect(inj.value).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: '${env:GITHUB_TOKEN}' },
    });
    // The placeholder-bearing field is flagged with the CURSOR-syntax placeholder, so a
    // drift write-back restores ${env:VAR} and keeps the real mcp.json interpolatable.
    expect(inj.secretFields).toEqual({ 'env.GITHUB_TOKEN': '${env:GITHUB_TOKEN}' });
  });

  it('folds http auth.bearer_env into an Authorization header with ${env:VAR}', async () => {
    const dir = envWithServers(
      'linear:\n  transport: http\n  url: https://mcp.linear.app/mcp\n  auth: { bearer_env: LINEAR_TOKEN }\n',
    );
    const out = await cursorAdapter.compileConfigKeys(MCP_SURFACE, {
      envContentDir: dir,
      projectRoot: null,
    });
    const inj = out[0]!;
    if (inj.style !== 'keyed') throw new Error('unreachable');
    expect(inj.value).toEqual({
      type: 'http',
      url: 'https://mcp.linear.app/mcp',
      headers: { Authorization: 'Bearer ${env:LINEAR_TOKEN}' },
    });
    expect(inj.secretFields).toEqual({ 'headers.Authorization': 'Bearer ${env:LINEAR_TOKEN}' });
  });

  it('leaves Cursor-native ${userHome} / ${workspaceFolder} untouched', async () => {
    const dir = envWithServers(
      'fs:\n  command: mcp-fs\n  args: ["${userHome}/notes", "${workspaceFolder}"]\n',
    );
    const out = await cursorAdapter.compileConfigKeys(MCP_SURFACE, {
      envContentDir: dir,
      projectRoot: null,
    });
    const inj = out[0]!;
    if (inj.style !== 'keyed') throw new Error('unreachable');
    expect(inj.value).toEqual({ command: 'mcp-fs', args: ['${userHome}/notes', '${workspaceFolder}'] });
  });

  it('emits one independent injection per server', async () => {
    const dir = envWithServers('a:\n  command: a-cmd\nb:\n  url: https://b\n');
    const out = await cursorAdapter.compileConfigKeys(MCP_SURFACE, {
      envContentDir: dir,
      projectRoot: null,
    });
    expect(out.map((i) => (i.style === 'keyed' ? i.keyPath : []))).toEqual([
      ['mcpServers', 'a'],
      ['mcpServers', 'b'],
    ]);
  });

  it('is idempotent: an already-Cursor-shaped entry (with ${env:VAR}) re-compiles unchanged', async () => {
    const dir = envWithServers(
      'linear:\n  type: http\n  url: https://mcp.linear.app/mcp\n  headers: { Authorization: "Bearer ${env:LINEAR_TOKEN}" }\n',
    );
    const out = await cursorAdapter.compileConfigKeys(MCP_SURFACE, {
      envContentDir: dir,
      projectRoot: null,
    });
    const inj = out[0]!;
    if (inj.style !== 'keyed') throw new Error('unreachable');
    expect(inj.value).toEqual({
      type: 'http',
      url: 'https://mcp.linear.app/mcp',
      headers: { Authorization: 'Bearer ${env:LINEAR_TOKEN}' },
    });
  });
});

describe('adapter.cursor — describeConfigKeysDrift (report only, store untouched)', () => {
  it('names the canonical fields that differ, translating Cursor\'s ${env:} shape away', async () => {
    // servers.yaml is D6-canonical; the drift value is Cursor's harness shape (F1). The
    // report must speak CANONICAL (`auth.bearer_env`), not Cursor's `headers`/`${env:}`.
    const dir = envWithServers(
      'keep:\n  transport: stdio\n  command: keep-cmd\nlinear:\n  transport: http\n  url: https://old\n',
    );
    const before = readFileSync(join(dir, 'mcp', 'servers.yaml'));

    const out = await cursorAdapter.describeConfigKeysDrift!(
      MCP_SURFACE,
      {
        style: 'keyed',
        keyPath: ['mcpServers', 'linear'],
        canonicalValue: {
          type: 'http',
          url: 'https://new',
          headers: { Authorization: 'Bearer ${env:LINEAR_TOKEN}' },
        },
      },
      { envContentDir: dir, projectRoot: null },
    );

    expect(out!.entry).toBe('linear');
    expect(out!.storeRelativePath).toBe(join('mcp', 'servers.yaml'));
    // The canonical entry had no `auth` at all, so the whole subtree is the addition —
    // a report names the parent when the parent itself is new, and the LEAF when only
    // one key inside an existing object changed.
    expect(driftKinds(out)).toEqual({ url: 'changed', auth: 'added' });
    // The sibling is never mentioned, and the canonical file is byte-identical.
    expect(JSON.stringify(out)).not.toContain('keep');
    expect(readFileSync(join(dir, 'mcp', 'servers.yaml')).equals(before)).toBe(true);
  });

  it('reports a server with no canonical entry as a whole-entry addition', async () => {
    const dir = envWithServers('other:\n  transport: stdio\n  command: x\n');
    const out = await cursorAdapter.describeConfigKeysDrift!(
      MCP_SURFACE,
      { style: 'keyed', keyPath: ['mcpServers', 'fresh'], canonicalValue: { type: 'sse', url: 'https://x/sse' } },
      { envContentDir: dir, projectRoot: null },
    );
    expect(out!.changes).toEqual([{ field: '', kind: 'added' }]);
  });
});

describe('adapter.cursor — validateConfigFile (whole-file rejection guard, M5)', () => {
  const P = '/some/where/mcp.json';

  it('accepts a whole file where every server is a valid object with command or url', () => {
    const content = JSON.stringify({
      mcpServers: {
        stdioSrv: { command: '/bin/echo', args: ['hi'] },
        httpSrv: { type: 'http', url: 'https://x/mcp' },
        urlOnly: { url: 'https://y/mcp' },
      },
    });
    expect(cursorAdapter.validateConfigFile!(P, content)).toEqual({ ok: true });
  });

  it('rejects the WHOLE file when one entry is a non-object (Cursor drops all servers)', () => {
    const content = JSON.stringify({
      mcpServers: { good: { command: '/bin/echo' }, bad: 'not-an-object' },
    });
    const res = cursorAdapter.validateConfigFile!(P, content);
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("'bad'");
    expect(res.detail).toMatch(/WHOLE file|whole file/i);
  });

  it('rejects the WHOLE file when one entry has neither command nor url (empty object)', () => {
    const content = JSON.stringify({
      mcpServers: { good: { command: '/bin/echo' }, bad: {} },
    });
    expect(cursorAdapter.validateConfigFile!(P, content).ok).toBe(false);
  });

  it('rejects a file that is not parseable as JSON/JSONC', () => {
    expect(cursorAdapter.validateConfigFile!(P, '{ this is : not json').ok).toBe(false);
  });

  it('tolerates JSONC (trailing comma) — matching the live CLI', () => {
    expect(cursorAdapter.validateConfigFile!(P, '{ "mcpServers": { "good": { "command": "x" }, } }')).toEqual({
      ok: true,
    });
  });

  it('accepts a file with no mcpServers block (nothing for Cursor to reject)', () => {
    expect(cursorAdapter.validateConfigFile!(P, '{ "other": 1 }')).toEqual({ ok: true });
    expect(cursorAdapter.validateConfigFile!(P, '')).toEqual({ ok: true });
  });

  it('rejects mcpServers that is not an object', () => {
    expect(cursorAdapter.validateConfigFile!(P, '{ "mcpServers": [1,2,3] }').ok).toBe(false);
  });
});

describe('adapter.cursor — selfCheck (offline, fail-closed: session never composes Cursor)', () => {
  it('returns ok:false without spawning anything (session mode unsupported)', async () => {
    let spawned = false;
    const res = await cursorAdapter.selfCheck('/view/root', {
      resolveBinary: async () => {
        spawned = true;
        return '/fake/agent';
      },
      capture: async () => {
        spawned = true;
        return { code: 0, stdout: '', stderr: '' };
      },
      env: {},
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/CURSOR_CONFIG_DIR|--global/);
    expect(spawned).toBe(false); // safe/offline — never touches the CLI
  });
});

describe('adapter.cursor — detect', () => {
  it('is false when no agent binary is on PATH (hermetic)', async () => {
    expect(await cursorAdapter.detect({ PATH: '/nonexistent-dir-xyz' })).toBe(false);
  });
});
