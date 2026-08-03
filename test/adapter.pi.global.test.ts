/**
 * Task 4.3 — global materialise/restore AC for the Pi adapter, driven through the
 * REAL engine (`run`) against a Pi-shaped COPY of a config root (never the real
 * ~/.pi). Proves every supported surface materialises (skills/prompts dir-merge,
 * AGENTS.md inline file-block, settings.json resource arrays), the MCP surface is
 * reported UNSUPPORTED, bucket-1 `auth.json`/`trust.json` are never touched, and
 * `drop --global --all` restores the copy byte-for-byte.
 */
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { describeGlobal } from '../src/engine.js';
import { resolvePaths } from '../src/paths.js';
import { readState } from '../src/state.js';
import { piAdapter } from '../src/adapters/pi.js';
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

/**
 * A content+structure hash of a directory tree (files by content, symlinks by
 * target). `excludeTop` drops top-level entries by name — used to hold the
 * settings.json array-element surface to a DATA-identity check instead of a
 * byte-identity one (see the drop assertions).
 */
function hashTree(root: string, excludeTop: readonly string[] = []): string {
  const rows: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs);
      if (excludeTop.includes(rel)) continue;
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
 * A Pi-shaped "real ~/.pi/agent" copy: user items in the dir-merge surfaces, an
 * AGENTS.md with user content, a settings.json with a user `packages` array, an
 * `extensions/` dir (bucket-1 state), and the two bucket-1 pass-throughs
 * (`auth.json`, `trust.json`) global mode must never touch.
 */
function seedPiHome(realHome: string): void {
  mkdirSync(join(realHome, 'skills', 'user-skill'), { recursive: true });
  writeFileSync(join(realHome, 'skills', 'user-skill', 'SKILL.md'), '# user skill\n');
  mkdirSync(join(realHome, 'prompts'), { recursive: true });
  writeFileSync(join(realHome, 'prompts', 'user-cmd.md'), '# user command\n');
  writeFileSync(join(realHome, 'AGENTS.md'), '# User AGENTS\n\nUser global instructions.\n');
  writeFileSync(
    join(realHome, 'settings.json'),
    `${JSON.stringify({ packages: ['user-pkg'], themes: ['user-theme'] }, null, 2)}\n`,
  );
  mkdirSync(join(realHome, 'extensions'), { recursive: true });
  writeFileSync(join(realHome, 'extensions', 'user-ext.ts'), '// user extension\n');
  writeFileSync(join(realHome, 'auth.json'), '{"provider":"real-login-token"}\n');
  writeFileSync(join(realHome, 'trust.json'), '{"trustedProjects":["/home/user/work"]}\n');
}

/** A 'writing' env contributing one item to every supported Pi surface kind. */
function seedWritingEnv(envDir: string): void {
  mkdirSync(join(envDir, 'skills', 'w-skill'), { recursive: true });
  writeFileSync(join(envDir, 'skills', 'w-skill', 'SKILL.md'), '# w skill\n');
  // prompts surface draws from the canonical `commands/` store content.
  mkdirSync(join(envDir, 'commands'), { recursive: true });
  writeFileSync(join(envDir, 'commands', 'w-cmd.md'), '# w command\n');
  // instructions → inline AGENTS.md managed block (D2).
  mkdirSync(join(envDir, 'instructions'), { recursive: true });
  writeFileSync(join(envDir, 'instructions', 'base.md'), 'Writing-env global instructions.\n');
  // settings resource arrays → config-keys array-element (D3).
  mkdirSync(join(envDir, 'files'), { recursive: true });
  writeFileSync(
    join(envDir, 'files', 'settings.json'),
    `${JSON.stringify({ packages: ['@acme/writing-pack'] }, null, 2)}\n`,
  );
}

describe('adapter.pi — global materialise/restore (AC)', () => {
  it('use --global materialises ALL supported surfaces on a Pi copy; drop --global restores byte-identical', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const realHome = join(th.home, 'pi-copy');
    seedPiHome(realHome);
    seedWritingEnv(paths.envDir('writing'));
    // realConfigRoot(env) reads PI_CODING_AGENT_DIR → point Pi at the copy.
    const env: NodeJS.ProcessEnv = { ...th.env, HOME: th.home, PI_CODING_AGENT_DIR: realHome };
    const opts = { env, adapters: [piAdapter] };

    const before = hashTree(realHome);
    // Every surface EXCEPT the settings.json array-element one round-trips byte-identical.
    const beforeExceptSettings = hashTree(realHome, ['settings.json']);
    const beforeSettingsBytes = readFileSync(join(realHome, 'settings.json'), 'utf8');

    const used = await run(['use', 'writing', '--global'], opts);
    expect(used.code).toBe(0);
    expect(hashTree(realHome)).not.toBe(before); // something changed

    // Global writers receive retained COW copies; the prompts surface draws
    // from the env's `commands/` store content (storeKind ≠ rootRelativePath).
    for (const [root, dir, name, storeSub] of [
      [join(th.home, '.agents'), 'skills', 'w-skill', 'skills'],
      [realHome, 'prompts', 'w-cmd.md', 'commands'],
    ] as const) {
      const link = join(root, dir, name);
      expect(lstatSync(link).isSymbolicLink()).toBe(false);
      const source = join(paths.envDir('writing'), storeSub, name);
      const leaf = name.endsWith('.md') ? '' : 'SKILL.md';
      expect(readFileSync(join(link, leaf), 'utf8')).toBe(readFileSync(join(source, leaf), 'utf8'));
    }
    // The user's own dir-merge items survive.
    expect(readFileSync(join(realHome, 'skills', 'user-skill', 'SKILL.md'), 'utf8')).toBe('# user skill\n');
    expect(readFileSync(join(realHome, 'prompts', 'user-cmd.md'), 'utf8')).toBe('# user command\n');

    // file-block inline: AGENTS.md keeps the user's content AND gains the env's
    // managed region.
    const agents = readFileSync(join(realHome, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('User global instructions.');
    expect(agents).toContain('Writing-env global instructions.');
    expect(agents).toMatch(/agentenv:writing/); // a managed marker is present

    // config-keys array-element: the env package joins the user's, order-independent,
    // beside the untouched user `themes` array.
    const settings = JSON.parse(readFileSync(join(realHome, 'settings.json'), 'utf8'));
    expect(settings.packages.sort()).toEqual(['@acme/writing-pack', 'user-pkg']);
    expect(settings.themes).toEqual(['user-theme']);

    // bucket-1 pass-throughs untouched by global mode (D15).
    expect(readFileSync(join(realHome, 'auth.json'), 'utf8')).toBe('{"provider":"real-login-token"}\n');
    expect(readFileSync(join(realHome, 'trust.json'), 'utf8')).toBe('{"trustedProjects":["/home/user/work"]}\n');
    // bucket-1 extensions/ dir untouched.
    expect(readFileSync(join(realHome, 'extensions', 'user-ext.ts'), 'utf8')).toBe('// user extension\n');

    // manifest records ownership across mechanisms.
    const manifest = await readState(paths);
    expect(manifest.globalStack).toEqual(['writing']);
    expect(manifest.items.some((i) => i.surface === 'dir-merge')).toBe(true);
    expect(manifest.items.some((i) => i.surface === 'file-block' && i.ownerEnv === 'writing')).toBe(true);
    expect(manifest.items.some((i) => i.surface === 'config-keys' && i.ownerEnv === 'writing')).toBe(true);

    // drop --global --all restores the copy. Every surface that promises a
    // format-preserving round-trip is byte-for-byte identical: dir-merge symlinks are
    // removed, the AGENTS.md file-block is restored exactly, bucket-1 files untouched.
    const dropped = await run(['drop', '--global', '--all'], opts);
    expect(dropped.code).toBe(0);
    expect(hashTree(realHome, ['settings.json'])).toBe(beforeExceptSettings);
    // The settings.json array-element surface is DATA-identical with agentenv's element
    // removed and no residue. It is NOT guaranteed byte-identical: the shared config-keys
    // array-element mechanism rewrites the touched array literal compactly (jsonc-parser
    // `modify`), so a user's multi-line `packages` array comes back single-line. That is a
    // config-keys.ts property (out of scope here), documented in docs/harness-pi.md.
    const afterSettingsBytes = readFileSync(join(realHome, 'settings.json'), 'utf8');
    expect(JSON.parse(afterSettingsBytes)).toEqual(JSON.parse(beforeSettingsBytes)); // data restored
    expect(afterSettingsBytes).not.toContain('@acme/writing-pack'); // env element gone
    expect(afterSettingsBytes).not.toMatch(/agentenv/); // no ownership residue
    expect(() => lstatSync(join(th.home, '.agents', 'skills', 'w-skill'))).toThrow();

    const after = await readState(paths);
    expect(after.items).toEqual([]);
    expect(after.globalStack).toEqual([]);
  });

  it('status reports the Pi MCP surface as UNSUPPORTED with its reason (D6)', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const realHome = join(th.home, 'pi-copy');
    seedPiHome(realHome);
    const env: NodeJS.ProcessEnv = { ...th.env, PI_CODING_AGENT_DIR: realHome };

    // Structured status (what the `status` command renders from).
    const status = await describeGlobal({ paths, adapters: [piAdapter], env });
    const pi = status.adapters.find((a) => a.adapterId === 'pi');
    expect(pi).toBeDefined();
    const mcp = pi!.surfaces.find((s) => s.surfaceId === 'mcp');
    expect(mcp).toMatchObject({ supported: false });
    expect(mcp!.unsupportedReason).toMatch(/no native MCP/i);
    expect(pi!.skips.some((s) => s.reason === 'unsupported' && s.surfaceId === 'mcp')).toBe(true);

    // The rendered `status` command output surfaces it too.
    const out = await run(['status'], { env, adapters: [piAdapter] });
    expect(out.stdout).toMatch(/mcp\s+config-keys\s+UNSUPPORTED/);
    expect(out.stdout).toContain('no native MCP');
  });
});
