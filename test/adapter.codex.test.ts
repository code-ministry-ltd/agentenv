import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateAdapter, type ConfigKeysSurface, type SelfCheckContext } from '../src/adapter.js';
import { renderSessionLaunch } from '../src/adapter-v2.js';
import { codexAdapter } from '../src/adapters/codex.js';
import type { JsonValue } from '../src/config-keys.js';
import { driftKinds } from './helpers.js';

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'agentenv-codex-'));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The MCP surface declaration (the single config-keys surface). */
const MCP_SURFACE = codexAdapter.surfaces.find((s) => s.id === 'mcp') as ConfigKeysSurface;

/** Write `mcp/servers.yaml` under a fresh env content dir; return the dir. */
function envWithServers(yaml: string): string {
  const dir = tmp();
  mkdirSync(join(dir, 'mcp'), { recursive: true });
  writeFileSync(join(dir, 'mcp', 'servers.yaml'), yaml);
  return dir;
}

describe('adapter.codex — identity & declarations', () => {
  it('is a well-formed adapter (validateAdapter passes)', () => {
    expect(validateAdapter(codexAdapter)).toBeNull();
  });

  it('declares Codex identity and its v2 CODEX_HOME launch', () => {
    expect(codexAdapter.id).toBe('codex');
    expect(codexAdapter.binaryName).toBe('codex');
    expect(codexAdapter.sessionSupported).toBe(true);
    expect(codexAdapter.configRootEnv).toBe('CODEX_HOME');
    expect(codexAdapter.overrideEnv('/v/root')).toEqual({ CODEX_HOME: '/v/root' });
    expect(codexAdapter.definition).toBeDefined();
    expect(renderSessionLaunch(codexAdapter.definition!, '/v/root', ['--model', 'gpt-5'])).toEqual({
      args: ['--model', 'gpt-5'],
      env: { CODEX_HOME: '/v/root' },
    });
  });

  it('realConfigRoot honours a set CODEX_HOME, else ~/.codex', () => {
    expect(codexAdapter.realConfigRoot({ CODEX_HOME: '/custom' })).toBe('/custom');
    expect(codexAdapter.realConfigRoot({ HOME: '/fixture-home' })).toBe('/fixture-home/.codex');
    expect(codexAdapter.realConfigRoot({ CODEX_HOME: '   ' })).toMatch(/\.codex$/);
    expect(codexAdapter.realConfigRoot({})).toMatch(/\.codex$/);
  });

  it('declares skills and commands-as-skills plus inline AGENTS.md and TOML MCP', () => {
    const byId = new Map(codexAdapter.surfaces.map((s) => [s.id, s]));
    expect(byId.get('skills')).toMatchObject({
      mechanism: 'dir-merge',
      rootRelativePath: 'skills',
      mode: 'symlink',
      supported: true,
    });
    expect(byId.get('commands')).toMatchObject({
      mechanism: 'dir-merge',
      rootRelativePath: 'skills',
      storeKind: 'commands',
      layout: 'command-skill',
      supported: true,
    });
    // Instructions are a file-block on AGENTS.md in INLINE mode (Codex has no @import).
    expect(byId.get('instructions')).toMatchObject({
      mechanism: 'file-block',
      rootRelativePath: 'AGENTS.md',
      layering: 'inline',
      storeKind: 'instructions',
    });
    // MCP is config-keys into config.toml's [mcp_servers.*] tables — TOML, keyed,
    // substitute rung (Codex can't interpolate ${VAR} in mcp values).
    expect(byId.get('mcp')).toMatchObject({
      mechanism: 'config-keys',
      rootRelativePath: 'config.toml',
      format: 'toml',
      style: 'keyed',
      keyPath: ['mcp_servers'],
      substitutePlaceholders: true,
    });
  });
});

describe('adapter.codex — classifyEntry (D15 two-bucket)', () => {
  it('classifies the surface targets as managed (bucket-2)', () => {
    for (const name of ['config.toml', 'AGENTS.md', 'skills']) {
      expect(codexAdapter.classifyEntry(name)).toBe('managed');
    }
  });

  it('classifies auth.json AND every unknown entry as state (bucket-1, the safe unknown)', () => {
    // auth.json is the single pass-through that keeps the view logged in (D15).
    expect(codexAdapter.classifyEntry('auth.json')).toBe('state');
    for (const name of [
      'hooks.json',
      'prompts',
      'agents',
      'tmp',
      'AGENTS.override.md',
      'history.jsonl',
      'a-file-a-future-codex-update-introduced',
    ]) {
      expect(codexAdapter.classifyEntry(name)).toBe('state');
    }
  });
});

describe('adapter.codex — compileConfigKeys (MCP → native indirections, D6)', () => {
  it('returns [] when the env contributes no servers.yaml and no projectRoot', async () => {
    const dir = tmp();
    const out = await codexAdapter.compileConfigKeys(MCP_SURFACE, {
      envContentDir: dir,
      projectRoot: null,
    });
    expect(out).toEqual([]);
  });

  it('maps a stdio ${VAR} env (key==var) to the env_vars allowlist — no secret in the file', async () => {
    const dir = envWithServers(
      'github:\n' +
        '  transport: stdio\n' +
        '  command: npx\n' +
        '  args: ["-y", "@modelcontextprotocol/server-github"]\n' +
        '  env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" }\n',
    );
    const out = await codexAdapter.compileConfigKeys(MCP_SURFACE, {
      envContentDir: dir,
      projectRoot: null,
    });
    expect(out).toHaveLength(1);
    const inj = out[0]!;
    if (inj.style !== 'keyed') throw new Error('unreachable');
    expect(inj.keyPath).toEqual(['mcp_servers', 'github']);
    expect(inj.value).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env_vars: ['GITHUB_TOKEN'],
    });
    // No placeholder survives → no secretField (native indirection removed it).
    expect(inj.secretFields).toBeUndefined();
  });

  it('keeps a literal stdio env in `env`, and a renamed ${VAR} as a flagged placeholder', async () => {
    const dir = envWithServers(
      'srv:\n' +
        '  transport: stdio\n' +
        '  command: c\n' +
        '  env: { FOO: bar, TOKEN: "${GITHUB_TOKEN}" }\n',
    );
    const out = await codexAdapter.compileConfigKeys(MCP_SURFACE, {
      envContentDir: dir,
      projectRoot: null,
    });
    const inj = out[0]!;
    if (inj.style !== 'keyed') throw new Error('unreachable');
    // FOO is a literal; TOKEN != GITHUB_TOKEN so it can't use env_vars — it stays
    // in `env` and is flagged for the substitute rung.
    expect(inj.value).toEqual({ command: 'c', env: { FOO: 'bar', TOKEN: '${GITHUB_TOKEN}' } });
    expect(inj.secretFields).toEqual({ 'env.TOKEN': '${GITHUB_TOKEN}' });
  });

  it('maps http auth.bearer_env to bearer_token_env_var — native, no secret', async () => {
    const dir = envWithServers(
      'linear:\n  transport: http\n  url: https://mcp.linear.app/mcp\n  auth: { bearer_env: LINEAR_TOKEN }\n',
    );
    const out = await codexAdapter.compileConfigKeys(MCP_SURFACE, {
      envContentDir: dir,
      projectRoot: null,
    });
    const inj = out[0]!;
    if (inj.style !== 'keyed') throw new Error('unreachable');
    expect(inj.value).toEqual({
      url: 'https://mcp.linear.app/mcp',
      bearer_token_env_var: 'LINEAR_TOKEN',
    });
    expect(inj.secretFields).toBeUndefined();
  });

  it('maps a whole-value ${VAR} header to env_http_headers, keeps a literal header', async () => {
    const dir = envWithServers(
      'x:\n' +
        '  transport: http\n' +
        '  url: https://x\n' +
        '  headers: { X-Api-Key: "${API_KEY}", X-Client: acme }\n',
    );
    const out = await codexAdapter.compileConfigKeys(MCP_SURFACE, {
      envContentDir: dir,
      projectRoot: null,
    });
    const inj = out[0]!;
    if (inj.style !== 'keyed') throw new Error('unreachable');
    expect(inj.value).toEqual({
      url: 'https://x',
      http_headers: { 'X-Client': 'acme' },
      env_http_headers: { 'X-Api-Key': 'API_KEY' },
    });
    expect(inj.secretFields).toBeUndefined();
  });

  it('flags a secret embedded in a url (no native indirection) for the substitute rung', async () => {
    const dir = envWithServers('z:\n  transport: http\n  url: "https://x?key=${API_KEY}"\n');
    const out = await codexAdapter.compileConfigKeys(MCP_SURFACE, {
      envContentDir: dir,
      projectRoot: null,
    });
    const inj = out[0]!;
    if (inj.style !== 'keyed') throw new Error('unreachable');
    expect(inj.value).toEqual({ url: 'https://x?key=${API_KEY}' });
    expect(inj.secretFields).toEqual({ url: 'https://x?key=${API_KEY}' });
  });

  it('does not grant project trust automatically when a projectRoot is present', async () => {
    const dir = envWithServers('a:\n  transport: stdio\n  command: a-cmd\n');
    const out = await codexAdapter.compileConfigKeys(MCP_SURFACE, {
      envContentDir: dir,
      projectRoot: '/home/jim/repo',
    });
    expect(out).toHaveLength(1);
    expect(out.some((i) => i.style === 'keyed' && i.keyPath[0] === 'projects')).toBe(false);
  });

  it('emits nothing when only projectRoot is set and no servers.yaml exists', async () => {
    const out = await codexAdapter.compileConfigKeys(MCP_SURFACE, {
      envContentDir: tmp(),
      projectRoot: '/repo',
    });
    expect(out).toEqual([]);
  });
});

describe('adapter.codex — describeConfigKeysDrift (report only, store untouched)', () => {
  /** Classify one drifted Codex table against the env's canonical servers.yaml. */
  function report(dir: string, name: string, value: JsonValue) {
    return codexAdapter.describeConfigKeysDrift!(
      MCP_SURFACE,
      { style: 'keyed', keyPath: ['mcp_servers', name], canonicalValue: value },
      { envContentDir: dir, projectRoot: null },
    );
  }

  it('names the canonical fields that differ, translating the native indirections away', async () => {
    const dir = envWithServers(
      'keep:\n  transport: stdio\n  command: keep-cmd\nlinear:\n  transport: http\n  url: https://old\n',
    );
    const before = readFileSync(join(dir, 'mcp', 'servers.yaml'));

    // `bearer_token_env_var` is Codex's native, EXACT bearer indirection → auth.bearer_env.
    const out = await report(dir, 'linear', {
      url: 'https://new',
      bearer_token_env_var: 'LINEAR_TOKEN',
    });

    expect(out!.entry).toBe('linear');
    expect(out!.storeRelativePath).toBe(join('mcp', 'servers.yaml'));
    // The canonical entry had no `auth` at all, so the whole subtree is the addition —
    // a report names the parent when the parent itself is new, and the LEAF when only
    // one key inside an existing object changed.
    expect(driftKinds(out)).toEqual({ url: 'changed', auth: 'added' });
    expect(JSON.stringify(out)).not.toContain('keep');
    expect(readFileSync(join(dir, 'mcp', 'servers.yaml')).equals(before)).toBe(true);
  });

  it('reports env_vars / env_http_headers under their CANONICAL field names', async () => {
    // The user must be told to edit `env.EXTRA` / `headers.X-New` in servers.yaml, not
    // Codex's `env_vars` / `env_http_headers` — those key paths do not exist there.
    const dir = envWithServers(
      'gh:\n  transport: stdio\n  command: npx\n  env:\n    GITHUB_TOKEN: "${GITHUB_TOKEN}"\n' +
        'x:\n  transport: http\n  url: https://x\n  headers:\n    X-Api-Key: "${API_KEY}"\n',
    );
    expect(
      driftKinds(await report(dir, 'gh', { command: 'npx', env_vars: ['GITHUB_TOKEN', 'EXTRA'] })),
    ).toEqual({ 'env.EXTRA': 'added' });
    expect(
      driftKinds(
        await report(dir, 'x', {
          url: 'https://x',
          env_http_headers: { 'X-Api-Key': 'API_KEY', 'X-New': 'NEW_VAR' },
        }),
      ),
    ).toEqual({ 'headers.X-New': 'added' });
  });

  it('ignores a drifted trust entry (launch-derived, no canonical counterpart)', async () => {
    const dir = envWithServers('a:\n  transport: stdio\n  command: a\n');
    const out = await codexAdapter.describeConfigKeysDrift!(
      MCP_SURFACE,
      { style: 'keyed', keyPath: ['projects', '/repo'], canonicalValue: { trust_level: 'trusted' } },
      { envContentDir: dir, projectRoot: null },
    );
    expect(out).toBeNull();
  });
});

describe('adapter.codex — selfCheck (injected capture, no real harness)', () => {
  /** A view dir with an authored config.toml declaring the given server names. */
  function viewWith(servers: string[]): string {
    const view = tmp();
    const toml = servers.map((n) => `[mcp_servers.${n}]\ncommand = "x"\n`).join('\n');
    writeFileSync(join(view, 'config.toml'), toml);
    return view;
  }

  function ctxCapturing(output: string, code = 0): SelfCheckContext {
    return {
      resolveBinary: async () => '/fake/codex',
      capture: async () => ({ code, stdout: output, stderr: '' }),
      env: {},
    };
  }

  it('ok when the child gets a view server by exact NAME (connect/auth status irrelevant)', async () => {
    const view = viewWith(['agentenv_probe']);
    const ctx = ctxCapturing('{"name":"agentenv_probe","enabled":true}');
    expect(await codexAdapter.selfCheck(view, ctx)).toEqual({ ok: true });
  });

  it('targets one server and passes the CODEX_HOME override to the probe', async () => {
    const view = viewWith(['srv']);
    let seenEnv: NodeJS.ProcessEnv = {};
    let seenArgs: readonly string[] = [];
    const ctx: SelfCheckContext = {
      resolveBinary: async () => '/fake/codex',
      capture: async (_bin, args, env) => {
        seenArgs = args;
        seenEnv = env;
        return { code: 0, stdout: '{"name":"srv"}', stderr: '' };
      },
      env: { EXISTING: '1' },
    };
    await codexAdapter.selfCheck(view, ctx);
    expect(seenArgs).toEqual(['mcp', 'get', 'srv', '--json']);
    expect(seenEnv.CODEX_HOME).toBe(view);
    expect(seenEnv.EXISTING).toBe('1');
  });

  it('fails when NONE of the view servers appear (child did not observe the view)', async () => {
    const view = viewWith(['agentenv_probe']);
    const ctx = ctxCapturing('{"name":"context7"}'); // only the real server
    const res = await codexAdapter.selfCheck(view, ctx);
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('agentenv_probe');
  });

  it('does not match a name that is only a prefix of a listed server', async () => {
    const view = viewWith(['probe']);
    const ctx = ctxCapturing('{"name":"probe_other"}'); // 'probe' must NOT match 'probe_other'
    expect((await codexAdapter.selfCheck(view, ctx)).ok).toBe(false);
  });

  it('fails when codex cannot be resolved', async () => {
    const view = viewWith(['srv']);
    const ctx: SelfCheckContext = {
      resolveBinary: async () => null,
      capture: async () => ({ code: 0, stdout: '', stderr: '' }),
      env: {},
    };
    expect(await codexAdapter.selfCheck(view, ctx)).toEqual({
      ok: false,
      detail: 'codex not found on PATH',
    });
  });

  it('with no view servers, falls back to a mechanism check on the exit code', async () => {
    const view = tmp(); // no config.toml → zero declared servers
    expect(
      await codexAdapter.selfCheck(view, ctxCapturing('[]', 0)),
    ).toEqual({ ok: true });
    const bad = await codexAdapter.selfCheck(view, ctxCapturing('', 1));
    expect(bad.ok).toBe(false);
  });
});

describe('adapter.codex — detect', () => {
  it('is false when no codex binary is on PATH (hermetic)', async () => {
    expect(await codexAdapter.detect({ PATH: '/nonexistent-dir-xyz' })).toBe(false);
  });
});
