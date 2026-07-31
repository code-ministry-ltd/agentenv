import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { resolvePaths } from '../src/paths.js';
import { readState } from '../src/state.js';
import { FIXTURE_CONFIG_ENV, makeFixtureAdapter } from './fixtures/fixture-adapter.js';
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
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
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

function seedRealHome(realHome: string): void {
  mkdirSync(join(realHome, 'skills', 'user-skill'), { recursive: true });
  writeFileSync(join(realHome, 'skills', 'user-skill', 'SKILL.md'), '# user skill\n');
  writeFileSync(join(realHome, 'INSTRUCTIONS.md'), '# user instructions\n\nkeep me.\n');
  writeFileSync(join(realHome, 'config.json'), '{\n  "mcpServers": {\n    "user-server": { "url": "u" }\n  }\n}\n');
  writeFileSync(join(realHome, 'auth.json'), '{"token":"secret-state"}\n');
}

function seedEnv(envDir: string, skillName: string, mcpServerName: string, instrText: string): void {
  mkdirSync(join(envDir, 'skills', skillName), { recursive: true });
  writeFileSync(join(envDir, 'skills', skillName, 'SKILL.md'), `# ${skillName}\n`);
  mkdirSync(join(envDir, 'instructions'), { recursive: true });
  writeFileSync(join(envDir, 'instructions', 'base.md'), instrText);
  mkdirSync(join(envDir, 'mcp'), { recursive: true });
  writeFileSync(join(envDir, 'mcp', 'servers.yaml'), `${mcpServerName}:\n  url: https://x\n`);
}

describe('engine: global drop (round-trip)', () => {
  it('AC: use --global then drop --global --all is byte-identical outside ~/.agentenv', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const realHome = join(th.home, 'real');
    seedRealHome(realHome);
    seedEnv(paths.envDir('writing'), 'w-skill', 'linear', 'writing base\n');
    const env: NodeJS.ProcessEnv = { ...th.env, [FIXTURE_CONFIG_ENV]: realHome };
    const opts = { env, adapters: [makeFixtureAdapter()] };

    const before = hashTree(realHome);

    expect((await run(['use', 'writing', '--global'], opts)).code).toBe(0);
    // Prove something actually changed in between.
    expect(hashTree(realHome)).not.toBe(before);

    expect((await run(['drop', '--global', '--all'], opts)).code).toBe(0);

    expect(hashTree(realHome)).toBe(before);
    const manifest = await readState(paths);
    expect(manifest.items).toEqual([]);
    expect(manifest.globalStack).toEqual([]);
  });

  it('AC: dropping the top of a two-env stack re-materialises what it shadowed (D5)', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const realHome = join(th.home, 'real');
    mkdirSync(realHome, { recursive: true });
    // Two envs whose skills COLLIDE on the name "shared"; each also has a unique skill.
    seedEnv(paths.envDir('base'), 'shared', 'base-mcp', 'base instructions\n');
    writeFileSync(join(paths.envDir('base'), 'skills', 'shared', 'SKILL.md'), '# from BASE\n');
    mkdirSync(join(paths.envDir('base'), 'skills', 'base-only'), { recursive: true });
    writeFileSync(join(paths.envDir('base'), 'skills', 'base-only', 'SKILL.md'), '# base only\n');

    seedEnv(paths.envDir('top'), 'shared', 'top-mcp', 'top instructions\n');
    writeFileSync(join(paths.envDir('top'), 'skills', 'shared', 'SKILL.md'), '# from TOP\n');

    const env: NodeJS.ProcessEnv = { ...th.env, [FIXTURE_CONFIG_ENV]: realHome };
    const opts = { env, adapters: [makeFixtureAdapter()] };

    // Stack [base, top]: top wins the shared name.
    expect((await run(['use', 'base', 'top', '--global'], opts)).code).toBe(0);
    const sharedLink = join(realHome, 'skills', 'shared');
    expect(readlinkSync(sharedLink)).toBe(join(paths.envDir('top'), 'skills', 'shared'));

    // Drop the top env → base's shared skill is re-materialised (unshadowed).
    expect((await run(['drop', 'top', '--global'], opts)).code).toBe(0);
    expect(lstatSync(sharedLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(sharedLink)).toBe(join(paths.envDir('base'), 'skills', 'shared'));
    // base-only remains; top's ownership is gone.
    expect(existsSync(join(realHome, 'skills', 'base-only'))).toBe(true);
    const manifest = await readState(paths);
    expect(manifest.globalStack).toEqual(['base']);
    expect(manifest.items.some((i) => i.ownerEnv === 'top')).toBe(false);
    expect(manifest.items.some((i) => i.ownerEnv === 'base' && i.surface === 'dir-merge' && i.path === sharedLink)).toBe(
      true,
    );
  });
});
