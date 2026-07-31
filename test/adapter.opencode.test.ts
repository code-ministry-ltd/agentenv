import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { validateAdapter, type ConfigKeysSurface, type SelfCheckContext } from '../src/adapter.js';
import { opencodeAdapter } from '../src/adapters/opencode.js';
import type { JsonValue } from '../src/config-keys.js';

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'agentenv-opencode-'));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The MCP config-keys surface (keyed). */
const MCP_SURFACE = opencodeAdapter.surfaces.find((s) => s.id === 'mcp') as ConfigKeysSurface;
/** The instructions config-keys surface (array-element). */
const INSTR_SURFACE = opencodeAdapter.surfaces.find(
  (s) => s.id === 'instructions',
) as ConfigKeysSurface;

/** Write `mcp/servers.yaml` under a fresh env content dir; return the dir. */
function envWithServers(yaml: string): string {
  const dir = tmp();
  mkdirSync(join(dir, 'mcp'), { recursive: true });
  writeFileSync(join(dir, 'mcp', 'servers.yaml'), yaml);
  return dir;
}

describe('adapter.opencode — identity & declarations', () => {
  it('is a well-formed adapter (validateAdapter passes)', () => {
    expect(validateAdapter(opencodeAdapter)).toBeNull();
  });

  it('declares OpenCode identity and the config-root override', () => {
    expect(opencodeAdapter.id).toBe('opencode');
    expect(opencodeAdapter.binaryName).toBe('opencode');
    expect(opencodeAdapter.sessionSupported).toBe(true);
    expect(opencodeAdapter.configRootEnv).toBe('OPENCODE_CONFIG_DIR');
  });

  it('overrideEnv sets OPENCODE_CONFIG_DIR to root AND XDG_CONFIG_HOME to its parent (the real lever)', () => {
    // XDG_CONFIG_HOME = dirname(viewRoot) is what actually isolates OpenCode (it
    // reads $XDG_CONFIG_HOME/opencode); OPENCODE_CONFIG_DIR satisfies validateAdapter.
    const view = '/x/live/sess/opencode';
    expect(opencodeAdapter.overrideEnv(view)).toEqual({
      OPENCODE_CONFIG_DIR: view,
      XDG_CONFIG_HOME: dirname(view),
    });
    // validateAdapter's invariant: the declared configRootEnv equals the given root.
    expect(opencodeAdapter.overrideEnv('/probe/root').OPENCODE_CONFIG_DIR).toBe('/probe/root');
  });

  it('realConfigRoot resolves $XDG_CONFIG_HOME/opencode, else ~/.config/opencode; ignores OPENCODE_CONFIG_DIR', () => {
    expect(opencodeAdapter.realConfigRoot({ XDG_CONFIG_HOME: '/cfg' })).toBe(join('/cfg', 'opencode'));
    expect(opencodeAdapter.realConfigRoot({ XDG_CONFIG_HOME: '  ' })).toMatch(/\.config[/\\]opencode$/);
    expect(opencodeAdapter.realConfigRoot({})).toMatch(/\.config[/\\]opencode$/);
    // OPENCODE_CONFIG_DIR is NOT a relocation lever (live-verified), so it is ignored.
    expect(opencodeAdapter.realConfigRoot({ OPENCODE_CONFIG_DIR: '/merged' })).toMatch(
      /\.config[/\\]opencode$/,
    );
  });

  it('declares all surfaces with the right mechanisms (skills symlink, instructions array-element, mcp keyed)', () => {
    const byId = new Map(opencodeAdapter.surfaces.map((s) => [s.id, s]));
    expect(byId.get('skills')).toMatchObject({
      mechanism: 'dir-merge',
      rootRelativePath: 'skills',
      mode: 'symlink',
    });
    expect(byId.get('agents')).toMatchObject({ mechanism: 'dir-merge', rootRelativePath: 'agents' });
    expect(byId.get('commands')).toMatchObject({
      mechanism: 'dir-merge',
      rootRelativePath: 'commands',
    });
    // Instructions: array-element on opencode.json's `instructions` array (D3).
    expect(byId.get('instructions')).toMatchObject({
      mechanism: 'config-keys',
      rootRelativePath: 'opencode.json',
      format: 'json',
      style: 'array-element',
      keyPath: ['instructions'],
      storeKind: 'instructions',
    });
    // MCP: keyed into the `mcp` object of the SAME opencode.json; passthrough secrets.
    expect(byId.get('mcp')).toMatchObject({
      mechanism: 'config-keys',
      rootRelativePath: 'opencode.json',
      format: 'json',
      style: 'keyed',
      keyPath: ['mcp'],
      substitutePlaceholders: false,
    });
  });
});

describe('adapter.opencode — classifyEntry (D15 two-bucket)', () => {
  it('classifies the surface targets as managed (bucket-2)', () => {
    for (const name of ['skills', 'agents', 'commands', 'opencode.json']) {
      expect(opencodeAdapter.classifyEntry(name)).toBe('managed');
    }
  });

  it('classifies plugin deps, instruction files, and every unknown entry as state (the safe unknown)', () => {
    for (const name of [
      'node_modules', // plugin deps pass through so a seeded plugin loads
      'AGENTS.md', // the user's global instructions still apply in the view
      'CLAUDE.md',
      '.gitignore',
      'auth.json', // never actually here (auth is outside the config root) — safe anyway
      'a-file-a-future-opencode-update-introduced',
    ]) {
      expect(opencodeAdapter.classifyEntry(name)).toBe('state');
    }
  });
});

describe('adapter.opencode — compileConfigKeys: MCP (canonical → OpenCode mcp, D6)', () => {
  it('returns [] when the env contributes no servers.yaml', async () => {
    const out = await opencodeAdapter.compileConfigKeys(MCP_SURFACE, {
      envContentDir: tmp(),
      projectRoot: null,
    });
    expect(out).toEqual([]);
  });

  it('shapes a canonical stdio server into OpenCode local form (command array, {env:VAR} passthrough)', async () => {
    const dir = envWithServers(
      'github:\n' +
        '  transport: stdio\n' +
        '  command: npx\n' +
        '  args: ["-y", "@modelcontextprotocol/server-github"]\n' +
        '  env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" }\n',
    );
    const out = await opencodeAdapter.compileConfigKeys(MCP_SURFACE, {
      envContentDir: dir,
      projectRoot: null,
    });
    expect(out).toHaveLength(1);
    const inj = out[0]!;
    if (inj.style !== 'keyed') throw new Error('unreachable');
    expect(inj.keyPath).toEqual(['mcp', 'github']);
    expect(inj.value).toEqual({
      type: 'local',
      command: ['npx', '-y', '@modelcontextprotocol/server-github'],
      enabled: true,
      env: { GITHUB_TOKEN: '{env:GITHUB_TOKEN}' },
    });
    // The {env:VAR}-bearing field is flagged for placeholder-preserving write-back (D6).
    expect(inj.secretFields).toEqual({ 'env.GITHUB_TOKEN': '{env:GITHUB_TOKEN}' });
  });

  it('folds http auth.bearer_env into an Authorization header with an {env:VAR} placeholder', async () => {
    const dir = envWithServers(
      'linear:\n  transport: http\n  url: https://mcp.linear.app/mcp\n  auth: { bearer_env: LINEAR_TOKEN }\n',
    );
    const out = await opencodeAdapter.compileConfigKeys(MCP_SURFACE, {
      envContentDir: dir,
      projectRoot: null,
    });
    const inj = out[0]!;
    if (inj.style !== 'keyed') throw new Error('unreachable');
    expect(inj.value).toEqual({
      type: 'remote',
      url: 'https://mcp.linear.app/mcp',
      enabled: true,
      headers: { Authorization: 'Bearer {env:LINEAR_TOKEN}' },
    });
    expect(inj.secretFields).toEqual({ 'headers.Authorization': 'Bearer {env:LINEAR_TOKEN}' });
  });

  it('emits one independent injection per server', async () => {
    const dir = envWithServers('a:\n  command: a-cmd\nb:\n  url: https://b\n');
    const out = await opencodeAdapter.compileConfigKeys(MCP_SURFACE, {
      envContentDir: dir,
      projectRoot: null,
    });
    expect(out.map((i) => (i.style === 'keyed' ? i.keyPath : []))).toEqual([
      ['mcp', 'a'],
      ['mcp', 'b'],
    ]);
  });

  it('passes an already-OpenCode-shaped entry through unchanged (idempotent)', async () => {
    const dir = envWithServers(
      'echo:\n  type: local\n  command: ["/bin/echo", "hi"]\n  enabled: true\n',
    );
    const out = await opencodeAdapter.compileConfigKeys(MCP_SURFACE, {
      envContentDir: dir,
      projectRoot: null,
    });
    const inj = out[0]!;
    if (inj.style !== 'keyed') throw new Error('unreachable');
    expect(inj.value).toEqual({ type: 'local', command: ['/bin/echo', 'hi'], enabled: true });
  });

  it('honours a hand-authored `type: sse` rather than re-inferring from the url (F5/2)', async () => {
    const dir = envWithServers('linear:\n  type: sse\n  url: https://mcp.linear.app/sse\n');
    const out = await opencodeAdapter.compileConfigKeys(MCP_SURFACE, {
      envContentDir: dir,
      projectRoot: null,
    });
    const inj = out[0]!;
    if (inj.style !== 'keyed') throw new Error('unreachable');
    expect(inj.value).toEqual({
      type: 'remote',
      url: 'https://mcp.linear.app/sse',
      enabled: true,
    });
  });

  it('never re-enables a deliberately disabled server (F5/2)', async () => {
    // Canonical form…
    const canonical = envWithServers(
      'echo:\n  transport: stdio\n  command: /bin/echo\n  enabled: false\n',
    );
    const fromCanonical = await opencodeAdapter.compileConfigKeys(MCP_SURFACE, {
      envContentDir: canonical,
      projectRoot: null,
    });
    const a = fromCanonical[0]!;
    if (a.style !== 'keyed') throw new Error('unreachable');
    expect(a.value).toEqual({ type: 'local', command: ['/bin/echo'], enabled: false });

    // …and the hand-authored OpenCode form.
    const authored = envWithServers(
      'echo:\n  type: local\n  command: ["/bin/echo"]\n  enabled: false\n',
    );
    const fromAuthored = await opencodeAdapter.compileConfigKeys(MCP_SURFACE, {
      envContentDir: authored,
      projectRoot: null,
    });
    const b = fromAuthored[0]!;
    if (b.style !== 'keyed') throw new Error('unreachable');
    expect(b.value).toEqual({ type: 'local', command: ['/bin/echo'], enabled: false });
  });
});

describe('adapter.opencode — compileConfigKeys: instructions (array-element, absolute store paths)', () => {
  function envWithInstructions(files: Record<string, string>): string {
    const dir = tmp();
    mkdirSync(join(dir, 'instructions'), { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(dir, 'instructions', name), body);
    }
    return dir;
  }

  it('returns [] when the env contributes no instruction files', async () => {
    const out = await opencodeAdapter.compileConfigKeys(INSTR_SURFACE, {
      envContentDir: tmp(),
      projectRoot: null,
    });
    expect(out).toEqual([]);
  });

  it('appends each existing store instruction file as an absolute path (base then harness order)', async () => {
    const dir = envWithInstructions({ 'base.md': 'base', 'opencode.md': 'oc' });
    const out = await opencodeAdapter.compileConfigKeys(INSTR_SURFACE, {
      envContentDir: dir,
      projectRoot: null,
    });
    expect(out).toEqual([
      { style: 'array-element', arrayPath: ['instructions'], value: join(dir, 'instructions', 'base.md') },
      { style: 'array-element', arrayPath: ['instructions'], value: join(dir, 'instructions', 'opencode.md') },
    ]);
  });

  it('skips a missing store file (only opencode.md present)', async () => {
    const dir = envWithInstructions({ 'opencode.md': 'oc' });
    const out = await opencodeAdapter.compileConfigKeys(INSTR_SURFACE, {
      envContentDir: dir,
      projectRoot: null,
    });
    expect(out).toEqual([
      {
        style: 'array-element',
        arrayPath: ['instructions'],
        value: join(dir, 'instructions', 'opencode.md'),
      },
    ]);
  });
});

describe('adapter.opencode — syncBackConfigKeys (criterion 4)', () => {
  it('folds one drifted server back into servers.yaml canonical shape, siblings intact', async () => {
    // servers.yaml is D6-canonical; the drift value is OpenCode's harness shape (F1).
    const dir = envWithServers(
      'keep:\n  transport: stdio\n  command: keep-cmd\nlinear:\n  transport: http\n  url: https://old\n',
    );
    const mutations = await opencodeAdapter.syncBackConfigKeys!(
      MCP_SURFACE,
      {
        style: 'keyed',
        keyPath: ['mcp', 'linear'],
        canonicalValue: {
          type: 'remote',
          url: 'https://new',
          enabled: true,
          headers: { Authorization: 'Bearer {env:LINEAR_TOKEN}' },
        },
      },
      { envContentDir: dir, projectRoot: null },
    );
    expect(mutations).toHaveLength(1);
    expect(mutations[0]!.storeRelativePath).toBe(join('mcp', 'servers.yaml'));
    const written = parseYaml(mutations[0]!.content) as Record<string, JsonValue>;
    // Sibling preserved verbatim (already canonical).
    expect(written.keep).toEqual({ transport: 'stdio', command: 'keep-cmd' });
    // Drifted server reverse-mapped to canonical D6 ({env:VAR} → ${VAR}, remote → http,
    // Authorization → auth.bearer_env, `enabled`/`type` dropped).
    expect(written.linear).toEqual({
      transport: 'http',
      url: 'https://new',
      auth: { bearer_env: 'LINEAR_TOKEN' },
    });
  });

  it('round-trips: compile(syncBack(drift)) reproduces the drifted value (stable)', async () => {
    const dir = envWithServers('linear:\n  type: remote\n  url: https://old\n  enabled: true\n');
    const drifted: JsonValue = {
      type: 'remote',
      url: 'https://new',
      enabled: true,
      headers: { Authorization: 'Bearer {env:LINEAR_TOKEN}' },
    };
    const mutations = await opencodeAdapter.syncBackConfigKeys!(
      MCP_SURFACE,
      { style: 'keyed', keyPath: ['mcp', 'linear'], canonicalValue: drifted },
      { envContentDir: dir, projectRoot: null },
    );
    writeFileSync(join(dir, 'mcp', 'servers.yaml'), mutations[0]!.content);
    const recompiled = await opencodeAdapter.compileConfigKeys(MCP_SURFACE, {
      envContentDir: dir,
      projectRoot: null,
    });
    const inj = recompiled.find((i) => i.style === 'keyed' && i.keyPath[1] === 'linear')!;
    if (inj.style !== 'keyed') throw new Error('unreachable');
    expect(inj.value).toEqual(drifted);
    expect(inj.secretFields).toEqual({ 'headers.Authorization': 'Bearer {env:LINEAR_TOKEN}' });
  });

  it("does not mangle Cursor's ${env:VAR} into $${VAR} on write-back (F5/9)", async () => {
    // A `servers.yaml` written by a pre-F1 Cursor drift sweep still holds Cursor's
    // `${env:VAR}`. OpenCode's compile leaves it alone (its own syntax is `{env:VAR}`),
    // so it reaches the write-back — where a `{env:…}` regex without a `$` guard also
    // matched the INNER braces and produced `$${VAR}`, which no harness interpolates.
    const dir = envWithServers('gh:\n  transport: stdio\n  command: gh-mcp\n');
    const mutations = await opencodeAdapter.syncBackConfigKeys!(
      MCP_SURFACE,
      {
        style: 'keyed',
        keyPath: ['mcp', 'gh'],
        canonicalValue: {
          type: 'local',
          command: ['gh-mcp'],
          enabled: true,
          env: { CURSOR_STYLE: '${env:GH_TOKEN}', OPENCODE_STYLE: '{env:GH_TOKEN}' },
        },
      },
      { envContentDir: dir, projectRoot: null },
    );
    const written = parseYaml(mutations[0]!.content) as Record<string, JsonValue>;
    const env = (written.gh as Record<string, JsonValue>).env as Record<string, JsonValue>;
    expect(env.CURSOR_STYLE).toBe('${env:GH_TOKEN}'); // left alone, NOT '$${GH_TOKEN}'
    expect(env.OPENCODE_STYLE).toBe('${GH_TOKEN}'); // OpenCode's own form still converts
  });

  it('ignores a non-mcp / non-keyed drift (instructions array-element carries no drift)', async () => {
    const out = await opencodeAdapter.syncBackConfigKeys!(
      INSTR_SURFACE,
      { style: 'array-element', keyPath: ['instructions'], canonicalValue: '/some/path.md' },
      { envContentDir: tmp(), projectRoot: null },
    );
    expect(out).toEqual([]);
  });
});

describe('adapter.opencode — selfCheck (injected capture, no real harness)', () => {
  /** A view dir with an authored `opencode.json` mcp set. */
  function viewWith(servers: Record<string, unknown>): string {
    const view = tmp();
    writeFileSync(join(view, 'opencode.json'), JSON.stringify({ mcp: servers }));
    return view;
  }

  function ctxCapturing(output: string, code = 0): SelfCheckContext {
    return {
      resolveBinary: async () => '/fake/opencode',
      capture: async () => ({ code, stdout: output, stderr: '' }),
      env: {},
    };
  }

  it('ok when the child lists a view server by NAME (connect status irrelevant)', async () => {
    const view = viewWith({ 'agentenv-probe': { type: 'local', command: ['/bin/echo'] } });
    // A fake local server appears even though it "✗ failed" (live-verified format).
    const ctx = ctxCapturing('●  ✗ agentenv-probe [90mfailed\n');
    expect(await opencodeAdapter.selfCheck(view, ctx)).toEqual({ ok: true });
  });

  it('passes the XDG_CONFIG_HOME + OPENCODE_CONFIG_DIR overrides to the probe', async () => {
    const view = tmp();
    writeFileSync(join(view, 'opencode.json'), JSON.stringify({ mcp: { srv: {} } }));
    let seenEnv: NodeJS.ProcessEnv = {};
    const ctx: SelfCheckContext = {
      resolveBinary: async () => '/fake/opencode',
      capture: async (_bin, _args, env) => {
        seenEnv = env;
        return { code: 0, stdout: '●  ✓ srv [90mconnected\n', stderr: '' };
      },
      env: { EXISTING: '1' },
    };
    await opencodeAdapter.selfCheck(view, ctx);
    expect(seenEnv.OPENCODE_CONFIG_DIR).toBe(view);
    expect(seenEnv.XDG_CONFIG_HOME).toBe(dirname(view));
    expect(seenEnv.EXISTING).toBe('1');
  });

  it('fails when NONE of the view servers appear (child did not observe the view)', async () => {
    const view = viewWith({ 'agentenv-probe': {} });
    const ctx = ctxCapturing('●  ✓ context7 [90mconnected\n'); // only some other server
    const res = await opencodeAdapter.selfCheck(view, ctx);
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('agentenv-probe');
  });

  it('fails when opencode cannot be resolved', async () => {
    const view = viewWith({ srv: {} });
    const ctx: SelfCheckContext = {
      resolveBinary: async () => null,
      capture: async () => ({ code: 0, stdout: '', stderr: '' }),
      env: {},
    };
    expect(await opencodeAdapter.selfCheck(view, ctx)).toEqual({
      ok: false,
      detail: 'opencode not found on PATH',
    });
  });

  it('with no view servers, falls back to a mechanism check on the exit code', async () => {
    const view = tmp(); // no opencode.json → zero declared servers
    expect(await opencodeAdapter.selfCheck(view, ctxCapturing('No MCP servers.', 0))).toEqual({
      ok: true,
    });
    const bad = await opencodeAdapter.selfCheck(view, ctxCapturing('', 1));
    expect(bad.ok).toBe(false);
  });
});

describe('adapter.opencode — detect', () => {
  it('is false when no opencode binary is on PATH (hermetic)', async () => {
    expect(await opencodeAdapter.detect({ PATH: '/nonexistent-dir-xyz' })).toBe(false);
  });
});
