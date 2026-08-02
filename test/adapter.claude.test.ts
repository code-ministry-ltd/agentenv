import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateAdapter, type ConfigKeysSurface, type SelfCheckContext } from '../src/adapter.js';
import { renderSessionLaunch } from '../src/adapter-v2.js';
import { claudeAdapter } from '../src/adapters/claude.js';
import type { JsonValue } from '../src/config-keys.js';
import { driftKinds } from './helpers.js';

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

  it('declares Claude identity and the additional-directory session launch', () => {
    expect(claudeAdapter.id).toBe('claude-code');
    expect(claudeAdapter.binaryName).toBe('claude');
    expect(claudeAdapter.sessionSupported).toBe(true);
    expect(claudeAdapter.definition).toBeDefined();
    expect(renderSessionLaunch(claudeAdapter.definition!, '/v/root', ['--model', 'sonnet'])).toEqual({
      args: [
        '--add-dir=/v/root',
        '--mcp-config=/v/root/.mcp.json',
        '--model',
        'sonnet',
      ],
      env: { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1' },
    });
  });

  it('realConfigRoot honours a set CLAUDE_CONFIG_DIR, else ~/.claude', () => {
    expect(claudeAdapter.realConfigRoot({ CLAUDE_CONFIG_DIR: '/custom' })).toBe('/custom');
    expect(claudeAdapter.realConfigRoot({ HOME: '/fixture-home' })).toBe('/fixture-home/.claude');
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

  it('honours a hand-authored `type: sse` — an SSE endpoint must not compile to http (F5/2)', async () => {
    // A user may author the harness shape directly in servers.yaml. Re-inferring the
    // transport from the bare `url` would silently call an SSE endpoint as HTTP.
    const dir = envWithServers('linear:\n  type: sse\n  url: https://mcp.linear.app/sse\n');
    const out = await claudeAdapter.compileConfigKeys(MCP_SURFACE, {
      envContentDir: dir,
      projectRoot: null,
    });
    const inj = out[0]!;
    if (inj.style !== 'keyed') throw new Error('unreachable');
    expect(inj.value).toEqual({ type: 'sse', url: 'https://mcp.linear.app/sse' });
  });

});

describe('adapter.claude — describeConfigKeysDrift (report only, store untouched)', () => {
  /** Classify one drifted Claude value against the env's canonical servers.yaml. */
  function report(dir: string, name: string, value: JsonValue) {
    return claudeAdapter.describeConfigKeysDrift!(
      MCP_SURFACE,
      { style: 'keyed', keyPath: ['mcpServers', name], canonicalValue: value },
      { envContentDir: dir, projectRoot: null },
    );
  }

  it('names the drifted server and the canonical fields that differ, leaving the store alone', async () => {
    // servers.yaml is D6-canonical; the drift value is Claude's harness shape (F1). The
    // report must speak CANONICAL (`auth.bearer_env`), not Claude's `headers`.
    const dir = envWithServers(
      'keep:\n  transport: stdio\n  command: keep-cmd\nlinear:\n  transport: http\n  url: https://old\n',
    );
    const before = readFileSync(join(dir, 'mcp', 'servers.yaml'));

    const out = await report(dir, 'linear', {
      type: 'http',
      url: 'https://new',
      headers: { Authorization: 'Bearer ${LINEAR_TOKEN}' },
    });

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

  it('says nothing about a canonical field Claude cannot express (`enabled`, F5/3)', async () => {
    // Claude's shape carries no `enabled`, so the drifted entry says nothing about it —
    // reporting it as removed would send the user to change something they did not touch.
    const dir = envWithServers(
      'echo:\n  transport: stdio\n  command: /bin/echo\n  enabled: false\n',
    );
    const out = await report(dir, 'echo', { type: 'stdio', command: '/bin/echo-v2' });
    expect(driftKinds(out)).toEqual({ command: 'changed' });
  });

  it('reports a server with no canonical entry as a whole-entry addition', async () => {
    const dir = envWithServers('other:\n  transport: stdio\n  command: x\n');
    const out = await report(dir, 'fresh', { type: 'sse', url: 'https://x/sse' });
    expect(out!.changes).toEqual([{ field: '', kind: 'added' }]);
  });

  it('returns null for a key path that is not one server (never a bogus entry)', async () => {
    const dir = envWithServers('a:\n  command: x\n');
    expect(
      await claudeAdapter.describeConfigKeysDrift!(
        MCP_SURFACE,
        { style: 'keyed', keyPath: ['mcpServers'], canonicalValue: {} },
        { envContentDir: dir, projectRoot: null },
      ),
    ).toBeNull();
  });
});

describe('adapter.claude — selfCheck (injected capture, no real harness)', () => {
  /** A view dir with an authored explicit `.mcp.json` mcpServers set. */
  function viewWith(servers: Record<string, unknown>): string {
    const view = tmp();
    writeFileSync(join(view, '.mcp.json'), JSON.stringify({ mcpServers: servers }));
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

  it('passes the additional-directory arguments and environment to the probe', async () => {
    const view = viewWith({ srv: {} });
    let seenEnv: NodeJS.ProcessEnv = {};
    let seenArgs: readonly string[] = [];
    const ctx: SelfCheckContext = {
      resolveBinary: async () => '/fake/claude',
      capture: async (_bin, args, env) => {
        seenArgs = args;
        seenEnv = env;
        return { code: 0, stdout: 'srv: ...\n', stderr: '' };
      },
      env: { EXISTING: '1' },
    };
    await claudeAdapter.selfCheck(view, ctx);
    expect(seenArgs).toEqual([
      `--add-dir=${view}`,
      `--mcp-config=${join(view, '.mcp.json')}`,
      'mcp',
      'list',
    ]);
    expect(seenEnv.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(seenEnv.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe('1');
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
    const view = tmp(); // no .mcp.json → zero declared servers
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
