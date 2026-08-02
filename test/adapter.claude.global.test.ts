import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { resolvePaths } from '../src/paths.js';
import { readState } from '../src/state.js';
import { claudeAdapter } from '../src/adapters/claude.js';
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

/**
 * A Claude-shaped "real ~/.claude" copy: user items in every dir-merge surface, a
 * mixed `.claude.json` (mcpServers.context7 beside onboarding/identity state), and
 * a bucket-1 `.credentials.json` that global mode must never touch.
 */
function seedClaudeHome(realHome: string, userJson: string): void {
  for (const [dir, item, body] of [
    ['skills', 'user-skill', '# user skill\n'],
    ['agents', 'user-agent.md', '# user agent\n'],
    ['commands', 'user-cmd.md', '# user command\n'],
    ['rules', 'user-rule.md', '# user rule\n'],
  ] as const) {
    if (dir === 'skills') {
      mkdirSync(join(realHome, dir, item), { recursive: true });
      writeFileSync(join(realHome, dir, item, 'SKILL.md'), body);
    } else {
      mkdirSync(join(realHome, dir), { recursive: true });
      writeFileSync(join(realHome, dir, item), body);
    }
  }
  // Mixed internal file: managed mcpServers beside host state (D15).
  writeFileSync(
    userJson,
    `${JSON.stringify(
      {
        hasCompletedOnboarding: true,
        numStartups: 7,
        mcpServers: { context7: { type: 'http', url: 'https://mcp.context7.com/mcp' } },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(realHome, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"tok"}}\n');
}

/** A 'writing' env contributing one item to every Claude surface kind. */
function seedWritingEnv(envDir: string): void {
  mkdirSync(join(envDir, 'skills', 'w-skill'), { recursive: true });
  writeFileSync(join(envDir, 'skills', 'w-skill', 'SKILL.md'), '# w skill\n');
  mkdirSync(join(envDir, 'agents'), { recursive: true });
  writeFileSync(join(envDir, 'agents', 'w-agent.md'), '# w agent\n');
  mkdirSync(join(envDir, 'commands'), { recursive: true });
  writeFileSync(join(envDir, 'commands', 'w-cmd.md'), '# w command\n');
  mkdirSync(join(envDir, 'instructions'), { recursive: true });
  writeFileSync(join(envDir, 'instructions', 'agentenv-writing.md'), '# writing rule\n');
  mkdirSync(join(envDir, 'mcp'), { recursive: true });
  writeFileSync(
    join(envDir, 'mcp', 'servers.yaml'),
    'linear:\n  transport: http\n  url: https://mcp.linear.app/mcp\n  auth: { bearer_env: LINEAR_TOKEN }\n',
  );
}

describe('adapter.claude — global materialise/restore (AC)', () => {
  it('use --global materialises ALL surface kinds onto a Claude copy; drop --global restores byte-identical', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const userHome = join(th.home, 'user-home');
    const realHome = join(userHome, '.claude');
    const userJson = join(userHome, '.claude.json');
    mkdirSync(userHome, { recursive: true });
    seedClaudeHome(realHome, userJson);
    seedWritingEnv(paths.envDir('writing'));
    // realConfigRoot(env) reads CLAUDE_CONFIG_DIR → point Claude at the copy.
    const env: NodeJS.ProcessEnv = { ...th.env, HOME: userHome, CLAUDE_CONFIG_DIR: realHome };
    const opts = { env, adapters: [claudeAdapter] };

    const before = hashTree(userHome);

    const used = await run(['use', 'writing', '--global'], opts);
    expect(used.code).toBe(0);
    expect(hashTree(userHome)).not.toBe(before); // something changed

    // dir-merge: each env item symlinked in beside the user's, user items intact.
    for (const [dir, name, storeSub] of [
      ['skills', 'w-skill', 'skills'],
      ['agents', 'w-agent.md', 'agents'],
      ['commands', 'w-cmd.md', 'commands'],
      // instructions dir-merge lands in rules/ (D2 — symlink, not a CLAUDE.md block).
      ['rules', 'agentenv-writing.md', 'instructions'],
    ] as const) {
      const link = join(realHome, dir, name);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(join(paths.envDir('writing'), storeSub, name));
    }
    // The user's own items in every surface survive.
    expect(readFileSync(join(realHome, 'skills', 'user-skill', 'SKILL.md'), 'utf8')).toBe('# user skill\n');
    expect(readFileSync(join(realHome, 'rules', 'user-rule.md'), 'utf8')).toBe('# user rule\n');

    // config-keys: linear injected beside context7, shaped to Claude form with a
    // ${VAR}-passthrough Authorization header (D6 rung-1).
    const cfg = JSON.parse(readFileSync(userJson, 'utf8'));
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(['context7', 'linear']);
    expect(cfg.mcpServers.linear).toEqual({
      type: 'http',
      url: 'https://mcp.linear.app/mcp',
      headers: { Authorization: 'Bearer ${LINEAR_TOKEN}' },
    });
    // Host state in the mixed file is preserved.
    expect(cfg.hasCompletedOnboarding).toBe(true);
    expect(cfg.numStartups).toBe(7);

    // bucket-1 credentials untouched by global mode.
    expect(readFileSync(join(realHome, '.credentials.json'), 'utf8')).toBe(
      '{"claudeAiOauth":{"accessToken":"tok"}}\n',
    );

    // manifest records ownership across all mechanisms.
    const manifest = await readState(paths);
    expect(manifest.globalStack).toEqual(['writing']);
    expect(manifest.items.some((i) => i.surface === 'dir-merge')).toBe(true);
    expect(manifest.items.some((i) => i.surface === 'config-keys' && i.ownerEnv === 'writing')).toBe(true);

    // drop --global --all restores the copy byte-for-byte.
    const dropped = await run(['drop', '--global', '--all', '--harness', 'claude'], opts);
    expect(dropped.code).toBe(0);
    expect(hashTree(userHome)).toBe(before);
    const after = await readState(paths);
    expect(after.items).toEqual([]);
    expect(after.globalStack).toEqual([]);
  });
});
