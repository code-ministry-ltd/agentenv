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
import { cursorAdapter } from '../src/adapters/cursor.js';
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
 * A Cursor-shaped "real ~/.cursor" copy: a user skill, a user-authored mcp.json
 * (mixed — a user server the composer must preserve), and a bucket-1 `cli-config.json`
 * global mode must never touch.
 */
function seedCursorHome(realHome: string): void {
  mkdirSync(join(realHome, 'skills', 'user-skill'), { recursive: true });
  writeFileSync(join(realHome, 'skills', 'user-skill', 'SKILL.md'), '# user skill\n');
  writeFileSync(
    join(realHome, 'mcp.json'),
    `${JSON.stringify(
      { mcpServers: { context7: { type: 'http', url: 'https://mcp.context7.com/mcp' } } },
      null,
      2,
    )}\n`,
  );
  // bucket-1 state (auth/permissions/model) — never a surface, must pass untouched.
  writeFileSync(join(realHome, 'cli-config.json'), '{"permissions":{"allow":["Read"]}}\n');
}

/** A 'writing' env contributing a skill, an (UNSUPPORTED) instruction, and an MCP server. */
function seedWritingEnv(envDir: string): void {
  mkdirSync(join(envDir, 'skills', 'w-skill'), { recursive: true });
  writeFileSync(join(envDir, 'skills', 'w-skill', 'SKILL.md'), '# w skill\n');
  // Instructions are UNSUPPORTED for Cursor — the engine must skip this, never
  // materialise a rules/ dir into the copy.
  mkdirSync(join(envDir, 'instructions'), { recursive: true });
  writeFileSync(join(envDir, 'instructions', 'agentenv-writing.md'), '# writing rule\n');
  mkdirSync(join(envDir, 'mcp'), { recursive: true });
  writeFileSync(
    join(envDir, 'mcp', 'servers.yaml'),
    'linear:\n  transport: http\n  url: https://mcp.linear.app/mcp\n  auth: { bearer_env: LINEAR_TOKEN }\n',
  );
}

describe('adapter.cursor — global materialise/restore (AC)', () => {
  it('use --global materialises Cursor global surfaces on a copy; drop --global restores byte-identical', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const realHome = join(th.home, 'cursor-copy');
    seedCursorHome(realHome);
    seedWritingEnv(paths.envDir('writing'));
    // realConfigRoot(env) reads CURSOR_CONFIG_DIR → point the adapter at the copy.
    const env: NodeJS.ProcessEnv = { ...th.env, HOME: th.home, CURSOR_CONFIG_DIR: realHome };
    const opts = { env, adapters: [cursorAdapter] };

    const before = hashTree(realHome);

    const used = await run(['use', 'writing', '--global'], opts);
    expect(used.code).toBe(0);
    expect(hashTree(realHome)).not.toBe(before); // something changed

    // The env skill is a retained COW copy beside the user's own skill.
    const wSkill = join(th.home, '.agents', 'skills', 'w-skill');
    expect(lstatSync(wSkill).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(wSkill, 'SKILL.md'), 'utf8')).toBe('# w skill\n');
    expect(readFileSync(join(realHome, 'skills', 'user-skill', 'SKILL.md'), 'utf8')).toBe(
      '# user skill\n',
    );

    // config-keys: linear injected beside context7, shaped to Cursor form with a
    // ${env:VAR}-passthrough Authorization header (D6 rung-1).
    const cfg = JSON.parse(readFileSync(join(realHome, 'mcp.json'), 'utf8'));
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(['context7', 'linear']);
    expect(cfg.mcpServers.linear).toEqual({
      type: 'http',
      url: 'https://mcp.linear.app/mcp',
      headers: { Authorization: 'Bearer ${env:LINEAR_TOKEN}' },
    });
    // The user's own server in the mixed file is preserved.
    expect(cfg.mcpServers.context7).toEqual({ type: 'http', url: 'https://mcp.context7.com/mcp' });

    // Instructions are UNSUPPORTED → no rules/ dir was created in the copy.
    expect(() => lstatSync(join(realHome, 'rules'))).toThrow();

    // bucket-1 cli-config.json untouched by global mode.
    expect(readFileSync(join(realHome, 'cli-config.json'), 'utf8')).toBe(
      '{"permissions":{"allow":["Read"]}}\n',
    );

    // manifest records ownership across both mechanisms.
    const manifest = await readState(paths);
    expect(manifest.globalStack).toEqual(['writing']);
    expect(manifest.items.some((i) => i.surface === 'dir-merge')).toBe(true);
    expect(
      manifest.items.some((i) => i.surface === 'config-keys' && i.ownerEnv === 'writing'),
    ).toBe(true);

    // drop --global --all restores the copy byte-for-byte.
    const dropped = await run(['drop', '--global', '--all'], opts);
    expect(dropped.code).toBe(0);
    expect(hashTree(realHome)).toBe(before);
    expect(() => lstatSync(wSkill)).toThrow();
    const after = await readState(paths);
    expect(after.items).toEqual([]);
    expect(after.globalStack).toEqual([]);
  });
});
