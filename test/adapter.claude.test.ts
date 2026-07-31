import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { validateAdapter, type ConfigKeysSurface, type SelfCheckContext } from '../src/adapter.js';
import { claudeAdapter } from '../src/adapters/claude.js';
import type { JsonValue } from '../src/config-keys.js';

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'agentenv-claude-'));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The MCP surface declaration (the single config-keys surface). */
const MCP_SURFACE = claudeAdapter.surfaces.find((s) => s.id === 'mcp') as ConfigKeysSurface;

/** Write `mcp/servers.yaml` under a fresh env content dir; return the dir. */
function envWithServers(yaml: string): string {
  const dir = tmp();
  mkdirSync(join(dir, 'mcp'), { recursive: true });
  writeFileSync(join(dir, 'mcp', 'servers.yaml'), yaml);
  return dir;
}

describe('adapter.claude — identity & declarations', () => {
  it('is a well-formed adapter (validateAdapter passes)', () => {
    expect(validateAdapter(claudeAdapter)).toBeNull();
  });

  it('declares Claude identity and the config-root override', () => {
    expect(claudeAdapter.id).toBe('claude-code');
    expect(claudeAdapter.binaryName).toBe('claude');
    expect(claudeAdapter.sessionSupported).toBe(true);
    expect(claudeAdapter.configRootEnv).toBe('CLAUDE_CONFIG_DIR');
    expect(claudeAdapter.overrideEnv('/v/root')).toEqual({ CLAUDE_CONFIG_DIR: '/v/root' });
  });

  it('realConfigRoot honours a set CLAUDE_CONFIG_DIR, else ~/.claude', () => {
    expect(claudeAdapter.realConfigRoot({ CLAUDE_CONFIG_DIR: '/custom' })).toBe('/custom');
    expect(claudeAdapter.realConfigRoot({ CLAUDE_CONFIG_DIR: '   ' })).toMatch(/\.claude$/);
    expect(claudeAdapter.realConfigRoot({})).toMatch(/\.claude$/);
  });

  it('declares all five surfaces with the right mechanisms (D2: rules dir-merge, not file-block)', () => {
    const byId = new Map(claudeAdapter.surfaces.map((s) => [s.id, s]));
    expect(byId.get('skills')).toMatchObject({ mechanism: 'dir-merge', rootRelativePath: 'skills' });
    expect(byId.get('agents')).toMatchObject({ mechanism: 'dir-merge', rootRelativePath: 'agents' });
    expect(byId.get('commands')).toMatchObject({ mechanism: 'dir-merge', rootRelativePath: 'commands' });
    // Global instructions are a SYMLINK into rules/, never a file-block on CLAUDE.md.
    expect(byId.get('instructions')).toMatchObject({
      mechanism: 'dir-merge',
      rootRelativePath: 'rules',
      storeKind: 'instructions',
    });
    expect(byId.get('mcp')).toMatchObject({
      mechanism: 'config-keys',
      rootRelativePath: '.claude.json',
      format: 'json',
      style: 'keyed',
      keyPath: ['mcpServers'],
    });
  });
});

describe('adapter.claude — classifyEntry (D15 two-bucket)', () => {
  it('classifies the surface targets as managed (bucket-2)', () => {
    for (const name of ['skills', 'agents', 'commands', 'rules', '.claude.json']) {
      expect(claudeAdapter.classifyEntry(name)).toBe('managed');
    }
  });

  it('classifies credentials AND every unknown entry as state (bucket-1, the safe unknown)', () => {
    // .credentials.json is the single pass-through that keeps the view logged in.
    expect(claudeAdapter.classifyEntry('.credentials.json')).toBe('state');
    for (const name of [
      'history.jsonl',
      'projects',
      'todos',
      'statsig',
      'cache',
      'plugins',
      'shell-snapshots',
      'settings.json',
      'a-file-a-future-claude-update-introduced',
    ]) {
      expect(claudeAdapter.classifyEntry(name)).toBe('state');
    }
  });
});

describe('adapter.claude — compileConfigKeys (MCP → Claude mcpServers, D6)', () => {
  it('returns [] when the env contributes no servers.yaml', async () => {
    const dir = tmp();
    const out = await claudeAdapter.compileConfigKeys(MCP_SURFACE, {
      envContentDir: dir,
      projectRoot: null,
    });
    expect(out).toEqual([]);
  });

  it('shapes a canonical stdio server into Claude form (transport→type), one keyed injection', async () => {
    const dir = envWithServers(
      'github:\n' +
        '  transport: stdio\n' +
        '  command: npx\n' +
        '  args: ["-y", "@modelcontextprotocol/server-github"]\n' +
        '  env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" }\n',
    );
    const out = await claudeAdapter.compileConfigKeys(MCP_SURFACE, {
      envContentDir: dir,
      projectRoot: null,
    });
    expect(out).toHaveLength(1);
    const inj = out[0]!;
    expect(inj.style).toBe('keyed');
    if (inj.style !== 'keyed') throw new Error('unreachable');
    expect(inj.keyPath).toEqual(['mcpServers', 'github']);
    expect(inj.value).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
    });
    // The ${VAR}-bearing field is flagged for placeholder-preserving write-back (D6).
    expect(inj.secretFields).toEqual({ 'env.GITHUB_TOKEN': '${GITHUB_TOKEN}' });
  });

  it('folds http auth.bearer_env into an Authorization header with a ${VAR} placeholder', async () => {
    const dir = envWithServers('linear:\n  transport: http\n  url: https://mcp.linear.app/mcp\n  auth: { bearer_env: LINEAR_TOKEN }\n');
    const out = await claudeAdapter.compileConfigKeys(MCP_SURFACE, {
      envContentDir: dir,
      projectRoot: null,
    });
    const inj = out[0]!;
    if (inj.style !== 'keyed') throw new Error('unreachable');
    expect(inj.value).toEqual({
      type: 'http',
      url: 'https://mcp.linear.app/mcp',
      headers: { Authorization: 'Bearer ${LINEAR_TOKEN}' },
    });
    expect(inj.secretFields).toEqual({ 'headers.Authorization': 'Bearer ${LINEAR_TOKEN}' });
  });

  it('emits one independent injection per server', async () => {
    const dir = envWithServers('a:\n  command: a-cmd\nb:\n  url: https://b\n');
    const out = await claudeAdapter.compileConfigKeys(MCP_SURFACE, {
      envContentDir: dir,
      projectRoot: null,
    });
    expect(out.map((i) => (i.style === 'keyed' ? i.keyPath : []))).toEqual([
      ['mcpServers', 'a'],
      ['mcpServers', 'b'],
    ]);
  });

  it('passes an already-Claude-shaped entry through unchanged (idempotent)', async () => {
    const dir = envWithServers('echo:\n  type: stdio\n  command: /bin/echo\n  args: ["hi"]\n');
    const out = await claudeAdapter.compileConfigKeys(MCP_SURFACE, {
      envContentDir: dir,
      projectRoot: null,
    });
    const inj = out[0]!;
    if (inj.style !== 'keyed') throw new Error('unreachable');
    expect(inj.value).toEqual({ type: 'stdio', command: '/bin/echo', args: ['hi'] });
  });
});

describe('adapter.claude — syncBackConfigKeys (criterion 4)', () => {
  it('folds one drifted server back into servers.yaml canonical shape, siblings intact', async () => {
    // servers.yaml is D6-canonical; the drift value is Claude's harness shape (F1).
    const dir = envWithServers('keep:\n  transport: stdio\n  command: keep-cmd\nlinear:\n  transport: http\n  url: https://old\n');
    const mutations = await claudeAdapter.syncBackConfigKeys!(
      MCP_SURFACE,
      {
        style: 'keyed',
        keyPath: ['mcpServers', 'linear'],
        canonicalValue: { type: 'http', url: 'https://new', headers: { Authorization: 'Bearer ${LINEAR_TOKEN}' } },
      },
      { envContentDir: dir, projectRoot: null },
    );
    expect(mutations).toHaveLength(1);
    expect(mutations[0]!.storeRelativePath).toBe(join('mcp', 'servers.yaml'));
    const written = parseYaml(mutations[0]!.content) as Record<string, JsonValue>;
    // Sibling preserved verbatim (already canonical).
    expect(written.keep).toEqual({ transport: 'stdio', command: 'keep-cmd' });
    // Drifted server reverse-mapped to canonical D6 (Authorization → auth.bearer_env).
    expect(written.linear).toEqual({
      transport: 'http',
      url: 'https://new',
      auth: { bearer_env: 'LINEAR_TOKEN' },
    });
  });

  it('round-trips: compile(syncBack(drift)) reproduces the drifted value (stable)', async () => {
    const dir = envWithServers('linear:\n  type: http\n  url: https://old\n');
    const drifted: JsonValue = {
      type: 'http',
      url: 'https://new',
      headers: { Authorization: 'Bearer ${LINEAR_TOKEN}' },
    };
    const mutations = await claudeAdapter.syncBackConfigKeys!(
      MCP_SURFACE,
      { style: 'keyed', keyPath: ['mcpServers', 'linear'], canonicalValue: drifted },
      { envContentDir: dir, projectRoot: null },
    );
    // Persist the write-back, then re-compile: the value must be identical.
    writeFileSync(join(dir, 'mcp', 'servers.yaml'), mutations[0]!.content);
    const recompiled = await claudeAdapter.compileConfigKeys(MCP_SURFACE, {
      envContentDir: dir,
      projectRoot: null,
    });
    const inj = recompiled.find((i) => i.style === 'keyed' && i.keyPath[1] === 'linear')!;
    if (inj.style !== 'keyed') throw new Error('unreachable');
    expect(inj.value).toEqual(drifted);
    // And the restored placeholder is re-flagged as a secret field.
    expect(inj.secretFields).toEqual({ 'headers.Authorization': 'Bearer ${LINEAR_TOKEN}' });
  });
});

describe('adapter.claude — selfCheck (injected capture, no real harness)', () => {
  /** A view dir with an authored `.claude.json` mcpServers set. */
  function viewWith(servers: Record<string, unknown>): string {
    const view = tmp();
    writeFileSync(join(view, '.claude.json'), JSON.stringify({ mcpServers: servers }));
    return view;
  }

  function ctxCapturing(output: string, code = 0): SelfCheckContext {
    return {
      resolveBinary: async () => '/fake/claude',
      capture: async () => ({ code, stdout: output, stderr: '' }),
      env: {},
    };
  }

  it('ok when the child lists a view server by NAME (connect status irrelevant)', async () => {
    const view = viewWith({ 'agentenv-probe': { type: 'stdio', command: '/bin/echo' } });
    // A fake stdio server appears even though it "Failed to connect" (live-verified).
    const ctx = ctxCapturing('agentenv-probe: /bin/echo - ✘ Failed to connect\n');
    expect(await claudeAdapter.selfCheck(view, ctx)).toEqual({ ok: true });
  });

  it('passes the CLAUDE_CONFIG_DIR override to the probe', async () => {
    const view = viewWith({ srv: {} });
    let seenEnv: NodeJS.ProcessEnv = {};
    const ctx: SelfCheckContext = {
      resolveBinary: async () => '/fake/claude',
      capture: async (_bin, _args, env) => {
        seenEnv = env;
        return { code: 0, stdout: 'srv: ...\n', stderr: '' };
      },
      env: { EXISTING: '1' },
    };
    await claudeAdapter.selfCheck(view, ctx);
    expect(seenEnv.CLAUDE_CONFIG_DIR).toBe(view);
    expect(seenEnv.EXISTING).toBe('1');
  });

  it('fails when NONE of the view servers appear (child did not observe the view)', async () => {
    const view = viewWith({ 'agentenv-probe': {} });
    const ctx = ctxCapturing('context7: https://... - ✔ Connected\n'); // only the real server
    const res = await claudeAdapter.selfCheck(view, ctx);
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('agentenv-probe');
  });

  it('fails when claude cannot be resolved', async () => {
    const view = viewWith({ srv: {} });
    const ctx: SelfCheckContext = {
      resolveBinary: async () => null,
      capture: async () => ({ code: 0, stdout: '', stderr: '' }),
      env: {},
    };
    expect(await claudeAdapter.selfCheck(view, ctx)).toEqual({
      ok: false,
      detail: 'claude not found on PATH',
    });
  });

  it('with no view servers, falls back to a mechanism check on the exit code', async () => {
    const view = tmp(); // no .claude.json → zero declared servers
    expect(await claudeAdapter.selfCheck(view, ctxCapturing('No MCP servers configured.', 0))).toEqual({
      ok: true,
    });
    const bad = await claudeAdapter.selfCheck(view, ctxCapturing('', 1));
    expect(bad.ok).toBe(false);
  });
});

describe('adapter.claude — detect', () => {
  it('is false when no claude binary is on PATH (hermetic)', async () => {
    expect(await claudeAdapter.detect({ PATH: '/nonexistent-dir-xyz' })).toBe(false);
  });
});
