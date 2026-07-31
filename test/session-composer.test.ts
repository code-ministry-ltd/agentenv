import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePaths } from '../src/paths.js';
import { composeView, type ComposeRequest } from '../src/session/composer.js';
import { FAKE_HARNESS_SCRIPT, FIXTURE_CONFIG_ENV, makeFixtureAdapter } from './fixtures/fixture-adapter.js';
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

/** Seed a store env with a skill, instructions and an MCP server. */
function seedEnv(envDir: string, name: string): void {
  mkdirSync(join(envDir, 'skills', `${name}-skill`), { recursive: true });
  writeFileSync(join(envDir, 'skills', `${name}-skill`, 'SKILL.md'), `# ${name} skill\n`);
  mkdirSync(join(envDir, 'instructions'), { recursive: true });
  writeFileSync(join(envDir, 'instructions', 'base.md'), `Instructions from ${name}.\n`);
  mkdirSync(join(envDir, 'mcp'), { recursive: true });
  writeFileSync(
    join(envDir, 'mcp', 'servers.yaml'),
    `${name}-server:\n  transport: http\n  url: https://example/${name}\n`,
  );
}

/** A real config root with a user skill, user instructions, user MCP + a bucket-1 state file. */
function seedRealRoot(root: string): void {
  mkdirSync(join(root, 'skills', 'user-skill'), { recursive: true });
  writeFileSync(join(root, 'skills', 'user-skill', 'SKILL.md'), '# user skill\n');
  writeFileSync(join(root, 'INSTRUCTIONS.md'), 'USER GLOBAL INSTRUCTIONS\n');
  writeFileSync(join(root, 'config.json'), JSON.stringify({ mcpServers: { userSrv: { url: 'u' } } }));
  writeFileSync(join(root, 'creds.json'), 'SECRET-TOKEN'); // bucket 1 (state) → symlink
}

function baseReq(th: TempHome, realRoot: string, envs: string[], extra: Partial<ComposeRequest> = {}): ComposeRequest {
  return {
    paths: resolvePaths(th.env),
    adapter: makeFixtureAdapter(),
    envs,
    session: 'sess-1',
    realConfigRoot: realRoot,
    onWarn: () => {},
    ...extra,
  };
}

describe('session view composer', () => {
  it('composes a valid two-bucket view: state symlinked, surfaces merged; harness prints the root', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const realRoot = join(th.home, 'real');
    seedRealRoot(realRoot);
    mkdirSync(paths.envDir('writing'), { recursive: true });
    seedEnv(paths.envDir('writing'), 'writing');

    const res = await composeView(baseReq(th, realRoot, ['writing']));
    expect(res.rebuilt).toBe(true);
    const view = res.viewRoot;

    // Bucket 1: the state file is a symlink pointing back to the real location.
    const creds = lstatSync(join(view, 'creds.json'));
    expect(creds.isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(view, 'creds.json'))).toBe(join(realRoot, 'creds.json'));

    // Bucket 2 — skills: user's real skill AND the env skill, side by side (per-item).
    expect(readdirSync(join(view, 'skills')).sort()).toEqual(['user-skill', 'writing-skill']);
    expect(readlinkSync(join(view, 'skills', 'writing-skill'))).toBe(
      join(paths.envDir('writing'), 'skills', 'writing-skill'),
    );

    // Bucket 2 — instructions: user content layered with the env's managed region.
    const instr = readFileSync(join(view, 'INSTRUCTIONS.md'), 'utf8');
    expect(instr).toContain('USER GLOBAL INSTRUCTIONS');
    expect(instr).toContain('agentenv:writing/base.md');
    expect(instr).toContain('Instructions from writing.');

    // Bucket 2 — MCP: user's server preserved, env server injected.
    const cfg = JSON.parse(readFileSync(join(view, 'config.json'), 'utf8'));
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(['userSrv', 'writing-server']);

    // The fixture harness, pointed at the view, reports exactly this root.
    const out = spawnSync('node', [FAKE_HARNESS_SCRIPT, '--print-config-root'], {
      env: { ...process.env, [FIXTURE_CONFIG_ENV]: view },
      encoding: 'utf8',
    });
    expect(out.stdout.trim()).toBe(view);
  });

  it('AC: a second launch with nothing changed rebuilds nothing (build counter unchanged)', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const realRoot = join(th.home, 'real');
    seedRealRoot(realRoot);
    mkdirSync(paths.envDir('writing'), { recursive: true });
    seedEnv(paths.envDir('writing'), 'writing');

    const first = await composeView(baseReq(th, realRoot, ['writing']));
    expect(first.rebuilt).toBe(true);
    expect(first.generation).toBe(1);

    const second = await composeView(baseReq(th, realRoot, ['writing']));
    expect(second.rebuilt).toBe(false);
    expect(second.generation).toBe(1); // build counter did NOT advance
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.viewRoot).toBe(first.viewRoot);
  });

  it('AC: a store edit makes the next launch rebuild', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const realRoot = join(th.home, 'real');
    seedRealRoot(realRoot);
    const envDir = paths.envDir('writing');
    mkdirSync(envDir, { recursive: true });
    seedEnv(envDir, 'writing');

    const first = await composeView(baseReq(th, realRoot, ['writing']));
    expect(first.generation).toBe(1);

    // Edit a store instruction file — a static input the fingerprint enumerates.
    writeFileSync(join(envDir, 'instructions', 'base.md'), 'EDITED instructions\n');

    const second = await composeView(baseReq(th, realRoot, ['writing']));
    expect(second.rebuilt).toBe(true);
    expect(second.generation).toBe(2);
    expect(readFileSync(join(second.viewRoot, 'INSTRUCTIONS.md'), 'utf8')).toContain('EDITED instructions');
  });

  it('AC: a kill mid-build (leftover temp dir) is discarded; the published view is only ever whole', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const realRoot = join(th.home, 'real');
    seedRealRoot(realRoot);
    mkdirSync(paths.envDir('writing'), { recursive: true });
    seedEnv(paths.envDir('writing'), 'writing');

    // Simulate a shim killed mid-build: a leftover temp build dir with junk.
    const sessionDir = join(paths.live, 'sess-1');
    const debris = join(sessionDir, '.build-fixture-deadbeef');
    mkdirSync(join(debris, 'half'), { recursive: true });
    writeFileSync(join(debris, 'half', 'partial'), 'garbage');

    const res = await composeView(baseReq(th, realRoot, ['writing']));
    expect(res.rebuilt).toBe(true);

    // Debris gone; only the whole published view remains beside its meta marker.
    const siblings = readdirSync(sessionDir).sort();
    expect(siblings).toEqual(['fixture', 'fixture.meta.json']);
    // The published view is complete (all surfaces present).
    expect(readdirSync(join(res.viewRoot, 'skills')).length).toBeGreaterThan(0);
    expect(lstatSync(join(res.viewRoot, 'INSTRUCTIONS.md')).isFile()).toBe(true);
  });

  it('a later env in the stack wins an item-name collision; the user always wins', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const realRoot = join(th.home, 'real');
    seedRealRoot(realRoot);
    // Two envs, both define a skill named "shared"; env "b" is later so wins.
    for (const name of ['a', 'b']) {
      const d = paths.envDir(name);
      mkdirSync(join(d, 'skills', 'shared'), { recursive: true });
      writeFileSync(join(d, 'skills', 'shared', 'SKILL.md'), `# ${name}'s shared\n`);
    }
    // And both collide with a user skill named "user-skill"? add one that collides with user.
    const d = paths.envDir('a');
    mkdirSync(join(d, 'skills', 'user-skill'), { recursive: true });
    writeFileSync(join(d, 'skills', 'user-skill', 'SKILL.md'), '# env tries user-skill\n');

    const skips: string[] = [];
    const res = await composeView(
      baseReq(th, realRoot, ['a', 'b'], { onWarn: (m) => skips.push(m) }),
    );
    // "shared" resolves to env b (later wins).
    expect(readlinkSync(join(res.viewRoot, 'skills', 'shared'))).toBe(
      join(paths.envDir('b'), 'skills', 'shared'),
    );
    // "user-skill" stays the user's real one (user always wins) and env a is skipped.
    expect(readlinkSync(join(res.viewRoot, 'skills', 'user-skill'))).toBe(
      join(realRoot, 'skills', 'user-skill'),
    );
    expect(res.skipped.some((s) => s.detail.includes('user-skill'))).toBe(true);
  });

  it('composes on a fresh machine with no real config root (env content only)', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    mkdirSync(paths.envDir('writing'), { recursive: true });
    seedEnv(paths.envDir('writing'), 'writing');

    const res = await composeView(baseReq(th, join(th.home, 'does-not-exist'), ['writing']));
    expect(res.rebuilt).toBe(true);
    expect(readdirSync(join(res.viewRoot, 'skills'))).toEqual(['writing-skill']);
    const cfg = JSON.parse(readFileSync(join(res.viewRoot, 'config.json'), 'utf8'));
    expect(Object.keys(cfg.mcpServers)).toEqual(['writing-server']);
  });
});
