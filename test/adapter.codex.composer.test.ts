import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePaths } from '../src/paths.js';
import { composeView, type ComposeRequest } from '../src/session/composer.js';
import { codexAdapter } from '../src/adapters/codex.js';
import { makeTempHome, type TempHome } from './helpers.js';

const homes: TempHome[] = [];
function home(): TempHome {
  const h = makeTempHome();
  homes.push(h);
  return h;
}
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
});

/** A Codex-shaped real `~/.codex`: a user MCP server (with an embedded literal secret,
 * proving seed pass-through), user AGENTS.md, user skill, and a bucket-1 auth.json. */
function seedRealCodex(root: string): void {
  mkdirSync(join(root, 'skills', 'user-skill'), { recursive: true });
  writeFileSync(join(root, 'skills', 'user-skill', 'SKILL.md'), '# user skill\n');
  writeFileSync(join(root, 'AGENTS.md'), 'USER GLOBAL AGENTS INSTRUCTIONS\n');
  writeFileSync(
    join(root, 'config.toml'),
    '[mcp_servers.context7]\ntype = "http"\nurl = "https://mcp.context7.com/mcp"\n',
  );
  writeFileSync(join(root, 'auth.json'), '{"OPENAI_API_KEY":"real-token"}\n'); // bucket 1 (state)
}

/** An env contributing one item to each Codex surface, exercising every MCP mapping. */
function seedWritingEnv(envDir: string): void {
  mkdirSync(join(envDir, 'skills', 'w-skill'), { recursive: true });
  writeFileSync(join(envDir, 'skills', 'w-skill', 'SKILL.md'), '# w skill\n');
  mkdirSync(join(envDir, 'instructions'), { recursive: true });
  writeFileSync(join(envDir, 'instructions', 'codex.md'), 'CODEX RULE: be terse.\n');
  mkdirSync(join(envDir, 'mcp'), { recursive: true });
  writeFileSync(
    join(envDir, 'mcp', 'servers.yaml'),
    'github:\n' +
      '  transport: stdio\n' +
      '  command: npx\n' +
      '  env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" }\n' +
      'linear:\n' +
      '  transport: http\n' +
      '  url: https://mcp.linear.app/mcp\n' +
      '  auth: { bearer_env: LINEAR_TOKEN }\n' +
      'embedded:\n' +
      '  transport: http\n' +
      '  url: "https://svc/?key=${EMBED_KEY}"\n',
  );
}

function baseReq(th: TempHome, realRoot: string, extra: Partial<ComposeRequest> = {}): ComposeRequest {
  return {
    paths: resolvePaths(th.env),
    adapter: codexAdapter,
    envs: ['writing'],
    session: 'sess-codex',
    realConfigRoot: realRoot,
    onWarn: () => {},
    ...extra,
  };
}

describe('adapter.codex — session composer (TOML config.toml view, D6/D15)', () => {
  it('composes an isolating view: native indirections, trust entry, inline AGENTS.md, bucket-1 auth', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const realRoot = join(th.home, 'codex-real');
    seedRealCodex(realRoot);
    mkdirSync(paths.envDir('writing'), { recursive: true });
    seedWritingEnv(paths.envDir('writing'));

    const projectRoot = join(th.home, 'proj');
    const res = await composeView(
      baseReq(th, realRoot, {
        projectRoot,
        // The substitute rung resolves the url-embedded secret for the ephemeral view.
        env: { ...th.env, EMBED_KEY: 'sekret' },
      }),
    );
    const view = res.viewRoot;

    // --- config.toml (config-keys, TOML) ---
    const cfg = parseToml(readFileSync(join(view, 'config.toml'), 'utf8')) as {
      mcp_servers: Record<string, Record<string, unknown>>;
      projects: Record<string, { trust_level: string }>;
    };
    // The user's server survives (seed pass-through), env servers injected beside it.
    expect(Object.keys(cfg.mcp_servers).sort()).toEqual(['context7', 'embedded', 'github', 'linear']);
    // stdio ${VAR} env (key==var) → env_vars allowlist, no secret in the file.
    expect(cfg.mcp_servers.github).toEqual({ command: 'npx', env_vars: ['GITHUB_TOKEN'] });
    // http auth.bearer_env → bearer_token_env_var (native), no secret in the file.
    expect(cfg.mcp_servers.linear).toEqual({
      url: 'https://mcp.linear.app/mcp',
      bearer_token_env_var: 'LINEAR_TOKEN',
    });
    // url-embedded secret has no native indirection → substitute rung resolved the
    // literal into the EPHEMERAL view (never the store).
    expect(cfg.mcp_servers.embedded).toEqual({ url: 'https://svc/?key=sekret' });
    // Trust-gating: the launch's projectRoot is trusted so project-static config merges.
    expect(cfg.projects[projectRoot]).toEqual({ trust_level: 'trusted' });

    // --- AGENTS.md (file-block, inline mode) ---
    const agents = readFileSync(join(view, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('USER GLOBAL AGENTS INSTRUCTIONS'); // user content preserved
    expect(agents).toContain('CODEX RULE: be terse.'); // env content INLINED (no @import line)
    expect(agents).not.toContain('@'); // inline mode never writes an import line

    // --- skills (dir-merge) ---
    expect(lstatSync(join(view, 'skills', 'w-skill')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(view, 'skills', 'w-skill'))).toBe(
      join(paths.envDir('writing'), 'skills', 'w-skill'),
    );
    expect(lstatSync(join(view, 'skills', 'user-skill')).isSymbolicLink()).toBe(true); // user item kept

    // --- auth.json (bucket-1 state) passes through to the real (copied) token ---
    expect(lstatSync(join(view, 'auth.json')).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(view, 'auth.json'))).toBe(realpathSync(join(realRoot, 'auth.json')));

    // No surfaces were skipped for format any more (TOML now supported).
    expect(res.skipped.filter((s) => s.reason === 'format')).toEqual([]);
  });

  it('without a projectRoot, emits no trust entry (global/probe launches)', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const realRoot = join(th.home, 'codex-real');
    seedRealCodex(realRoot);
    mkdirSync(paths.envDir('writing'), { recursive: true });
    seedWritingEnv(paths.envDir('writing'));

    const res = await composeView(
      baseReq(th, realRoot, { projectRoot: null, env: { ...th.env, EMBED_KEY: 'x' } }),
    );
    const cfg = parseToml(readFileSync(join(res.viewRoot, 'config.toml'), 'utf8')) as {
      projects?: unknown;
    };
    expect(cfg.projects).toBeUndefined();
  });
});
