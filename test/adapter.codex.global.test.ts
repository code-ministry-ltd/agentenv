import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { resolvePaths } from '../src/paths.js';
import { readState } from '../src/state.js';
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

/** A content+structure hash of a directory tree (files by content, symlinks by target). */
function hashTree(root: string): string {
  const rows: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs);
      if (entry.isSymbolicLink()) {
        rows.push(`L ${rel} -> ${readlinkSync(abs)}`);
      } else if (entry.isDirectory()) {
        rows.push(`D ${rel}`);
        walk(abs);
      } else {
        rows.push(`F ${rel} ${createHash('sha256').update(readFileSync(abs)).digest('hex')}`);
      }
    }
  };
  walk(root);
  return createHash('sha256').update(rows.join('\n')).digest('hex');
}

/** A Codex-shaped home with shared standard skills plus a bucket-1 auth.json. */
function seedCodexHome(realHome: string, sharedSkills: string): void {
  mkdirSync(realHome, { recursive: true });
  mkdirSync(join(sharedSkills, 'user-skill'), { recursive: true });
  writeFileSync(join(sharedSkills, 'user-skill', 'SKILL.md'), '# user skill\n');
  writeFileSync(join(realHome, 'AGENTS.md'), '# user agents instructions\n');
  // A user MCP server plus an unrelated user key — both must survive untouched.
  writeFileSync(
    join(realHome, 'config.toml'),
    '# my codex config\nmodel = "gpt-5"\n\n[mcp_servers.context7]\ntype = "http"\nurl = "https://mcp.context7.com/mcp"\n',
  );
  writeFileSync(join(realHome, 'auth.json'), '{"OPENAI_API_KEY":"real-token"}\n'); // bucket 1
}

/** A 'writing' env contributing one item to every supported Codex surface kind. */
function seedWritingEnv(envDir: string): void {
  mkdirSync(join(envDir, 'skills', 'w-skill'), { recursive: true });
  writeFileSync(join(envDir, 'skills', 'w-skill', 'SKILL.md'), '# w skill\n');
  mkdirSync(join(envDir, 'commands'), { recursive: true });
  writeFileSync(join(envDir, 'commands', 'ship.md'), '# Ship command\n');
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
      '  auth: { bearer_env: LINEAR_TOKEN }\n',
  );
}

describe('adapter.codex — global materialise/restore (AC)', () => {
  it('use --global materialises ALL supported surface kinds onto a Codex copy; drop --global restores byte-identical', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const userHome = join(th.home, 'user-home');
    const realHome = join(userHome, '.codex');
    const sharedSkills = join(userHome, '.agents', 'skills');
    seedCodexHome(realHome, sharedSkills);
    seedWritingEnv(paths.envDir('writing'));
    // realConfigRoot(env) reads CODEX_HOME → point Codex at the copy.
    const env: NodeJS.ProcessEnv = { ...th.env, HOME: userHome, CODEX_HOME: realHome };
    const opts = { env, adapters: [codexAdapter] };

    const before = hashTree(userHome);

    const used = await run(['use', 'writing', '--global'], opts);
    expect(used.code).toBe(0);
    expect(hashTree(userHome)).not.toBe(before); // something changed

    // Global writers receive retained COW copies; user items remain intact.
    const wSkill = join(sharedSkills, 'w-skill');
    expect(lstatSync(wSkill).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(wSkill, 'SKILL.md'), 'utf8')).toBe('# w skill\n');
    expect(readFileSync(join(sharedSkills, 'user-skill', 'SKILL.md'), 'utf8')).toBe('# user skill\n');
    expect(lstatSync(join(sharedSkills, 'ship')).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(sharedSkills, 'ship', 'SKILL.md')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(sharedSkills, 'ship', 'SKILL.md'), 'utf8')).toBe(
      readFileSync(join(paths.envDir('writing'), 'commands', 'ship.md'), 'utf8'),
    );

    // file-block (AGENTS.md inline): env content INLINED into a managed region; user content kept.
    const agents = readFileSync(join(realHome, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('# user agents instructions');
    expect(agents).toContain('CODEX RULE: be terse.');

    // config-keys (config.toml TOML): env servers injected with native indirections
    // beside the user's context7; the user's non-MCP key is untouched.
    const cfg = parseToml(readFileSync(join(realHome, 'config.toml'), 'utf8')) as {
      model: string;
      mcp_servers: Record<string, Record<string, unknown>>;
    };
    expect(cfg.model).toBe('gpt-5');
    expect(Object.keys(cfg.mcp_servers).sort()).toEqual(['context7', 'github', 'linear']);
    expect(cfg.mcp_servers.github).toEqual({ command: 'npx', env_vars: ['GITHUB_TOKEN'] });
    expect(cfg.mcp_servers.linear).toEqual({
      url: 'https://mcp.linear.app/mcp',
      bearer_token_env_var: 'LINEAR_TOKEN',
    });
    // Global mode has no project context → no trust entry emitted.
    expect((cfg as { projects?: unknown }).projects).toBeUndefined();

    // bucket-1 auth.json untouched by global mode.
    expect(readFileSync(join(realHome, 'auth.json'), 'utf8')).toBe('{"OPENAI_API_KEY":"real-token"}\n');

    // manifest records ownership across all three mechanisms.
    const manifest = await readState(paths);
    expect(manifest.globalStack).toEqual(['writing']);
    expect(manifest.items.some((i) => i.surface === 'dir-merge')).toBe(true);
    expect(manifest.items.some((i) => i.surface === 'file-block')).toBe(true);
    expect(manifest.items.some((i) => i.surface === 'config-keys' && i.ownerEnv === 'writing')).toBe(true);

    // An env-less global drop restores the copy byte-for-byte.
    const dropped = await run(['drop', '--global'], opts);
    expect(dropped.code).toBe(0);
    expect(hashTree(userHome)).toBe(before);
    const after = await readState(paths);
    expect(after.items).toEqual([]);
    expect(after.globalStack).toEqual([]);
  });
});
