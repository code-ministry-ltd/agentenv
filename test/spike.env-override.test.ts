/**
 * Task 0.3 spike — permanent, CI-safe mechanical assertions.
 *
 * Encodes the parts of the falsification spike that need NO live auth and NO
 * network: that a harness's config-root env var (CLAUDE_CONFIG_DIR / CODEX_HOME)
 * relocates where it reads its managed MCP surface, and that pointing it at a
 * view leaves a sentinel "real config" dir byte-for-byte unchanged.
 *
 * Hermetic: every spawned harness runs with HOME + config-root overridden to a
 * throwaway temp dir, so these tests NEVER read or write the developer's real
 * config. They require the `claude` / `codex` binaries and skip cleanly when a
 * binary is absent (e.g. in CI). Live-auth / skills-loading assertions are NOT
 * encoded here — they are documented in spike/FINDINGS.md as requiring a login.
 *
 * Run just these:  npm test -- -t "spike"
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const PROBE_TIMEOUT_MS = 60_000;

function hasBinary(bin: string): boolean {
  const r = spawnSync(bin, ['--version'], { timeout: 20_000 });
  return r.status === 0;
}

const hasClaude = hasBinary('claude');
const hasCodex = hasBinary('codex');

const tmpRoots: string[] = [];
function freshRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentenv-spike-'));
  tmpRoots.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

/** Env for a hermetic harness run: HOME + config root both redirected to temp. */
function harnessEnv(home: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  return { ...env, ...extra };
}

function run(bin: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): string {
  const r = spawnSync(bin, args, { env, cwd, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

/** sha256 over sorted (relative-path, content) pairs of every regular file in dir. */
function hashTree(dir: string): string {
  const h = createHash('sha256');
  const walk = (d: string, rel: string): void => {
    for (const name of readdirSync(d).sort()) {
      const abs = join(d, name);
      const relPath = rel ? `${rel}/${name}` : name;
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs, relPath);
      else h.update(relPath).update('\0').update(readFileSync(abs));
    }
  };
  walk(dir, '');
  return h.digest('hex');
}

/** Compose a minimal, OFFLINE Claude view (distinctive MCP server, no credentials). */
function composeClaudeView(root: string, server: string): string {
  const view = join(root, 'view-claude');
  mkdirSync(view, { recursive: true });
  writeFileSync(
    join(view, '.claude.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      mcpServers: { [server]: { type: 'stdio', command: '/bin/echo', args: [server] } },
    }),
  );
  return view;
}

/** Compose a minimal Codex view (distinctive MCP server). */
function composeCodexView(root: string, server: string): string {
  const view = join(root, 'view-codex');
  mkdirSync(view, { recursive: true });
  writeFileSync(
    join(view, 'config.toml'),
    `[mcp_servers.${server}]\ncommand = "/bin/echo"\nargs = ["${server}"]\n`,
  );
  return view;
}

describe.skipIf(!hasClaude)('spike: CLAUDE_CONFIG_DIR relocates the managed MCP surface', () => {
  it('an empty config dir exposes NO user MCP servers', () => {
    const home = freshRoot();
    const empty = join(home, 'empty');
    mkdirSync(empty, { recursive: true });
    const out = run('claude', ['mcp', 'list'], harnessEnv(home, { CLAUDE_CONFIG_DIR: empty }), home);
    expect(out).toMatch(/No MCP servers configured/i);
  }, PROBE_TIMEOUT_MS);

  it('a view config dir exposes ONLY its own server', () => {
    const home = freshRoot();
    const view = composeClaudeView(home, 'spike-ci-alfa');
    const out = run('claude', ['mcp', 'list'], harnessEnv(home, { CLAUDE_CONFIG_DIR: view }), home);
    expect(out).toContain('spike-ci-alfa');
    expect(out).not.toContain('spike-ci-bravo');
    expect(out).not.toContain('context7'); // the developer's real user server must not leak in
  }, PROBE_TIMEOUT_MS);

  it('overriding CLAUDE_CONFIG_DIR leaves a sentinel real-config dir byte-identical', () => {
    const home = freshRoot();
    const realish = join(home, '.claude');
    mkdirSync(realish, { recursive: true });
    writeFileSync(join(realish, 'settings.json'), '{"sentinel":true}');
    writeFileSync(join(realish, '.credentials.json'), '{"do-not-touch":true}');
    const before = hashTree(realish);
    const view = composeClaudeView(home, 'spike-ci-sentinel');
    run('claude', ['mcp', 'list'], harnessEnv(home, { CLAUDE_CONFIG_DIR: view }), home);
    expect(hashTree(realish)).toBe(before);
  }, PROBE_TIMEOUT_MS);
});

describe.skipIf(!hasCodex)('spike: CODEX_HOME relocates the managed MCP surface', () => {
  it('an empty CODEX_HOME exposes NO MCP servers', () => {
    const home = freshRoot();
    const empty = join(home, 'empty-codex');
    mkdirSync(empty, { recursive: true });
    const out = run('codex', ['mcp', 'list'], harnessEnv(home, { CODEX_HOME: empty }), home);
    expect(out).toMatch(/No MCP servers configured/i);
  }, PROBE_TIMEOUT_MS);

  it('a view config.toml exposes ONLY its own server, and doctor points config.toml into CODEX_HOME', () => {
    const home = freshRoot();
    const view = composeCodexView(home, 'spike_ci_alfa');
    const list = run('codex', ['mcp', 'list'], harnessEnv(home, { CODEX_HOME: view }), home);
    expect(list).toContain('spike_ci_alfa');
    expect(list).not.toContain('spike_ci_bravo');
    expect(list).not.toContain('context7');
    const doctor = run('codex', ['doctor'], harnessEnv(home, { CODEX_HOME: view }), home);
    // doctor may abbreviate the view path as ~/view-codex/... since it sits under
    // the temp HOME, so match the path tail rather than the absolute string.
    expect(doctor).toMatch(/view-codex[/\\]config\.toml/);
  }, PROBE_TIMEOUT_MS);

  it('overriding CODEX_HOME leaves a sentinel real ~/.codex dir byte-identical', () => {
    const home = freshRoot();
    const realish = join(home, '.codex');
    mkdirSync(realish, { recursive: true });
    writeFileSync(join(realish, 'config.toml'), '# sentinel real codex config\n');
    const before = hashTree(realish);
    const view = composeCodexView(home, 'spike_ci_sentinel');
    run('codex', ['mcp', 'list'], harnessEnv(home, { CODEX_HOME: view }), home);
    expect(hashTree(realish)).toBe(before);
  }, PROBE_TIMEOUT_MS);
});
