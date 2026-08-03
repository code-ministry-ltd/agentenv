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
import { opencodeAdapter } from '../src/adapters/opencode.js';
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
 * The exact bytes of the user's mixed `opencode.json`. The `mcp` object is
 * multiline (keyed config-keys preserves its formatting surgically), and the
 * `instructions` array is authored **inline** — the array-element mechanism rewrites
 * the whole target array via jsonc-parser (which normalises it to inline), so an
 * inline-authored array round-trips byte-identical; a MULTILINE-authored array would
 * come back inline (a documented `config-keys` array-element property, shared with
 * Pi's settings arrays — see docs/harness-opencode.md). Everything else is surgical.
 */
const REAL_OPENCODE_JSON = `{
  "$schema": "https://opencode.ai/config.json",
  "username": "jim",
  "mcp": {
    "context7": {
      "type": "remote",
      "url": "https://mcp.context7.com/mcp",
      "enabled": true
    }
  },
  "instructions": ["existing.md"]
}
`;

/**
 * An OpenCode-shaped "real ~/.config/opencode" copy: user items in every dir-merge
 * surface, a mixed `opencode.json` (mcp.context7 + an existing instructions entry
 * beside host state), and an AGENTS.md global mode must never touch.
 */
function seedOpencodeHome(realHome: string): void {
  mkdirSync(join(realHome, 'skills', 'user-skill'), { recursive: true });
  writeFileSync(join(realHome, 'skills', 'user-skill', 'SKILL.md'), '# user skill\n');
  mkdirSync(join(realHome, 'agents'), { recursive: true });
  writeFileSync(join(realHome, 'agents', 'user-agent.md'), '# user agent\n');
  mkdirSync(join(realHome, 'commands'), { recursive: true });
  writeFileSync(join(realHome, 'commands', 'user-cmd.md'), '# user command\n');
  // Mixed config file: managed `mcp`/`instructions` beside host state.
  writeFileSync(join(realHome, 'opencode.json'), REAL_OPENCODE_JSON);
  // The user's global instructions file — a bucket-1 pass-through, not a surface.
  writeFileSync(join(realHome, 'AGENTS.md'), '# user AGENTS\n');
}

/** A 'writing' env contributing one item to every OpenCode surface kind. */
function seedWritingEnv(envDir: string): void {
  mkdirSync(join(envDir, 'skills', 'w-skill'), { recursive: true });
  writeFileSync(join(envDir, 'skills', 'w-skill', 'SKILL.md'), '# w skill\n');
  mkdirSync(join(envDir, 'agents'), { recursive: true });
  writeFileSync(join(envDir, 'agents', 'w-agent.md'), '# w agent\n');
  mkdirSync(join(envDir, 'commands'), { recursive: true });
  writeFileSync(join(envDir, 'commands', 'w-cmd.md'), '# w command\n');
  mkdirSync(join(envDir, 'instructions'), { recursive: true });
  writeFileSync(join(envDir, 'instructions', 'opencode.md'), '# writing instruction\n');
  mkdirSync(join(envDir, 'mcp'), { recursive: true });
  writeFileSync(
    join(envDir, 'mcp', 'servers.yaml'),
    'linear:\n  transport: http\n  url: https://mcp.linear.app/mcp\n  auth: { bearer_env: LINEAR_TOKEN }\n',
  );
}

describe('adapter.opencode — global materialise/restore (AC)', () => {
  it('use --global materialises ALL surface kinds onto an OpenCode copy; drop --global restores byte-identical', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    // realConfigRoot(env) = $XDG_CONFIG_HOME/opencode → point OpenCode at the copy.
    const xdgBase = join(th.home, 'xdg');
    const realHome = join(xdgBase, 'opencode');
    seedOpencodeHome(realHome);
    seedWritingEnv(paths.envDir('writing'));
    const env: NodeJS.ProcessEnv = { ...th.env, HOME: th.home, XDG_CONFIG_HOME: xdgBase };
    expect(opencodeAdapter.realConfigRoot(env)).toBe(realHome);
    const opts = { env, adapters: [opencodeAdapter] };

    const before = hashTree(realHome);

    const used = await run(['use', 'writing', '--global'], opts);
    expect(used.code).toBe(0);
    expect(hashTree(realHome)).not.toBe(before); // something changed

    // Global writers receive retained COW copies; user items remain intact.
    for (const [root, dir, name, storeSub] of [
      [join(th.home, '.agents'), 'skills', 'w-skill', 'skills'],
      [realHome, 'agents', 'w-agent.md', 'agents'],
      [realHome, 'commands', 'w-cmd.md', 'commands'],
    ] as const) {
      const link = join(root, dir, name);
      expect(lstatSync(link).isSymbolicLink()).toBe(false);
      const source = join(paths.envDir('writing'), storeSub, name);
      const leaf = name.endsWith('.md') ? '' : 'SKILL.md';
      expect(readFileSync(join(link, leaf), 'utf8')).toBe(readFileSync(join(source, leaf), 'utf8'));
    }
    expect(readFileSync(join(realHome, 'skills', 'user-skill', 'SKILL.md'), 'utf8')).toBe('# user skill\n');
    expect(readFileSync(join(realHome, 'agents', 'user-agent.md'), 'utf8')).toBe('# user agent\n');

    const cfg = JSON.parse(readFileSync(join(realHome, 'opencode.json'), 'utf8'));
    // config-keys keyed: linear injected beside context7, shaped to OpenCode remote
    // form with an {env:VAR}-passthrough Authorization header (D6 rung-1).
    expect(Object.keys(cfg.mcp).sort()).toEqual(['context7', 'linear']);
    expect(cfg.mcp.linear).toEqual({
      type: 'remote',
      url: 'https://mcp.linear.app/mcp',
      enabled: true,
      headers: { Authorization: 'Bearer {env:LINEAR_TOKEN}' },
    });
    // config-keys array-element: the store instruction file's absolute path is
    // appended to `instructions`, the user's existing entry preserved.
    expect(cfg.instructions).toEqual([
      'existing.md',
      join(paths.envDir('writing'), 'instructions', 'opencode.md'),
    ]);
    // Host state in the mixed file is preserved.
    expect(cfg.$schema).toBe('https://opencode.ai/config.json');
    expect(cfg.username).toBe('jim');

    // The user's global AGENTS.md is untouched by global mode.
    expect(readFileSync(join(realHome, 'AGENTS.md'), 'utf8')).toBe('# user AGENTS\n');

    // manifest records ownership across mechanisms.
    const manifest = await readState(paths);
    expect(manifest.globalStack).toEqual(['writing']);
    expect(manifest.items.some((i) => i.surface === 'dir-merge')).toBe(true);
    expect(
      manifest.items.some((i) => i.surface === 'config-keys' && i.ownerEnv === 'writing'),
    ).toBe(true);

    // An env-less global drop restores the copy byte-for-byte.
    const dropped = await run(['drop', '--global'], opts);
    expect(dropped.code).toBe(0);
    expect(hashTree(realHome)).toBe(before);
    expect(() => lstatSync(join(th.home, '.agents', 'skills', 'w-skill'))).toThrow();
    const after = await readState(paths);
    expect(after.items).toEqual([]);
    expect(after.globalStack).toEqual([]);
    // Explicit byte check on the mixed config file (both config-keys surfaces cleanly reversed).
    expect(readFileSync(join(realHome, 'opencode.json'), 'utf8')).toBe(REAL_OPENCODE_JSON);
  });
});
