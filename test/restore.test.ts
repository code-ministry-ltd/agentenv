import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeAdapter } from '../src/adapters/claude.js';
import { run } from '../src/cli.js';
import { storeIsRepo } from '../src/git.js';
import { type Paths, resolvePaths } from '../src/paths.js';
import type { ExecHarness, ExecSpec } from '../src/session/exec.js';
import { FIXTURE_CONFIG_ENV, installFixtureHarness, makeFixtureAdapter } from './fixtures/fixture-adapter.js';
import { expectRealHomeUntouched, makeTempHome, guardRealHome, type TempHome } from './helpers.js';

/**
 * Spec criterion 5 — NEW-MACHINE RESTORE, end to end and fully hermetic (no network,
 * `file://` bare remotes, temp homes only). An "origin machine" builds a `work` env
 * (a skill, an instructions file, and two MCP servers — one referencing a
 * `${SOME_TOKEN}` secret, one plain) and pushes it to a bare remote. A "fresh machine"
 * with NOTHING pre-existing then restores from that remote and proves criterion 5's
 * TWO probes:
 *
 *   Probe 1 — `agentenv init --remote <url>` CLONES the store, then `agentenv use
 *     work --global` reproduces the environment on real harness paths AND reports the
 *     unresolved `${SOME_TOKEN}` (no secrets.env on the fresh machine), failing closed
 *     on that one server while the rest materialises (Task 2.4 behaviour).
 *   Probe 2 — `agentenv run work -- <fixture-harness>` builds a valid SESSION view
 *     from the freshly cloned store, the fake harness observing the private root.
 */

const homes: TempHome[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A hermetic temp AGENTENV_HOME with git isolated from the dev machine's config. */
function gitHome(extraEnv: NodeJS.ProcessEnv = {}): TempHome {
  const th = makeTempHome({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...extraEnv });
  homes.push(th);
  return th;
}

/** A fresh, initialised bare repo standing in for the shared remote; plus its file:// URL. */
function bareRemote(): { dir: string; url: string } {
  const parent = mkdtempSync(join(tmpdir(), 'agentenv-restore-remote-'));
  dirs.push(parent);
  const bare = join(parent, 'store.git');
  execFileSync('git', ['init', '--bare', '-b', 'main', bare], { encoding: 'utf8' });
  return { dir: bare, url: pathToFileURL(bare).href };
}

/** An injected exec that really spawns the (fixture) binary and captures its stdout. */
function capturingExec(): { exec: ExecHarness; calls: ExecSpec[]; lastStdout: () => string } {
  const calls: ExecSpec[] = [];
  let stdout = '';
  const exec: ExecHarness = async (spec) => {
    calls.push(spec);
    const r = spawnSync(spec.binaryPath, [...spec.args], { env: spec.env, encoding: 'utf8' });
    stdout = r.stdout ?? '';
    return r.status ?? 0;
  };
  return { exec, calls, lastStdout: () => stdout };
}

/**
 * The ORIGIN machine: build a `work` env with a skill, an instructions file and two
 * MCP servers (one secret-bearing, one plain), then push the store to `url`. The
 * secret is only ever a `${SOME_TOKEN}` PLACEHOLDER — no value ever enters the store.
 */
async function seedOriginAndPush(url: string): Promise<void> {
  const th = gitHome();
  const paths = resolvePaths(th.env);
  expect((await run(['init'], { env: th.env })).code).toBe(0);
  expect((await run(['create', 'work'], { env: th.env })).code).toBe(0);

  const envDir = paths.envDir('work');
  mkdirSync(join(envDir, 'skills', 'sharpen'), { recursive: true });
  writeFileSync(
    join(envDir, 'skills', 'sharpen', 'SKILL.md'),
    '---\nname: sharpen\ndescription: Sharpen prose.\n---\n\n# sharpen\n\nBe concise.\n',
  );
  mkdirSync(join(envDir, 'instructions'), { recursive: true });
  // `base.md` is the canonical generic instruction file: dir-merged into rules/ by
  // the Claude adapter AND inlined into the session view by the file-block surface.
  writeFileSync(join(envDir, 'instructions', 'base.md'), 'Work rule: keep it concise.\n');
  mkdirSync(join(envDir, 'mcp'), { recursive: true });
  writeFileSync(
    join(envDir, 'mcp', 'servers.yaml'),
    [
      'github:',
      '  command: mcp-server-github',
      '  env:',
      '    GITHUB_TOKEN: ${SOME_TOKEN}',
      'notes:',
      '  command: mcp-server-notes',
      '',
    ].join('\n'),
  );

  // `remote` commits the drift (the env content) and pushes it to the empty bare
  // remote, flipping origin — the whole `work` env now lives in the remote's history.
  const pushed = await run(['remote', url], { env: th.env });
  expect(pushed.code).toBe(0);
}

/** A FRESH machine (nothing pre-existing) that restores by cloning `url`. */
async function freshRestore(url: string): Promise<{ th: TempHome; paths: Paths; res: Awaited<ReturnType<typeof run>> }> {
  const th = gitHome();
  const res = await run(['init', '--remote', url], { env: th.env });
  return { th, paths: resolvePaths(th.env), res };
}

describe('restore (criterion 5): init --remote clones a populated store', () => {
  it('clones the work env + its skills/instructions/mcp into the fresh store, from git', async () => {
    const real = guardRealHome();
    const remote = bareRemote();
    await seedOriginAndPush(remote.url);

    const { paths, res } = await freshRestore(remote.url);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('cloned the store from');

    // The env and every surface are present in the fresh store — restored FROM GIT.
    const envDir = paths.envDir('work');
    expect(existsSync(join(envDir, 'skills', 'sharpen', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(envDir, 'instructions', 'base.md'))).toBe(true);
    const yaml = readFileSync(join(envDir, 'mcp', 'servers.yaml'), 'utf8');
    expect(yaml).toContain('github');
    expect(yaml).toContain('${SOME_TOKEN}'); // placeholder, never a value
    expect(yaml).toContain('notes');

    // It genuinely came from a clone: a git repo whose origin is the remote.
    expect(await storeIsRepo(paths)).toBe(true);
    const origin = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: paths.store,
      encoding: 'utf8',
    }).trim();
    expect(origin).toBe(remote.url);

    // The rest of the machine bootstrap still ran (manifest + shims).
    expect(existsSync(paths.state)).toBe(true);
    expectRealHomeUntouched(real);
  });

  it('falls back to an empty store + connected remote when the remote is empty', async () => {
    const real = guardRealHome();
    const remote = bareRemote(); // initialised but EMPTY (no history pushed)

    const { paths, res } = await freshRestore(remote.url);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('agentenv initialised');
    expect(res.stderr ?? '').toContain('empty');
    // An empty store was created and the remote connected for the first push.
    expect(await storeIsRepo(paths)).toBe(true);
    expect(existsSync(paths.environments)).toBe(true);
    const origin = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: paths.store,
      encoding: 'utf8',
    }).trim();
    expect(origin).toBe(remote.url);
    expectRealHomeUntouched(real);
  });
});

describe('restore (criterion 5) probe 1: use work --global reproduces the env + reports unresolved ${VAR}', () => {
  it('materialises every surface kind onto a fresh Claude home (skills/rules symlinks + .claude.json mcpServers)', async () => {
    const real = guardRealHome();
    const remote = bareRemote();
    await seedOriginAndPush(remote.url);
    const { th, paths } = await freshRestore(remote.url);

    // A pristine ~/.claude-style home (a clean container has no surface dirs yet).
    const realHome = join(th.home, 'claude-copy');
    const userJson = join(th.home, '.claude.json');
    mkdirSync(realHome, { recursive: true });
    writeFileSync(userJson, `${JSON.stringify({ hasCompletedOnboarding: true }, null, 2)}\n`);
    const env: NodeJS.ProcessEnv = { ...th.env, HOME: th.home, CLAUDE_CONFIG_DIR: realHome };

    const used = await run(['use', 'work', '--global'], { env, adapters: [claudeAdapter] });
    expect(used.code).toBe(0);

    // dir-merge: retained COW copies appear in freshly-created surface dirs.
    const skillLink = join(realHome, 'skills', 'sharpen');
    expect(lstatSync(skillLink).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(skillLink, 'SKILL.md'), 'utf8')).toContain('sharpen');
    // Instructions materialise as a rules/ COW file, not a CLAUDE.md block.
    const ruleLink = join(realHome, 'rules', 'base.md');
    expect(lstatSync(ruleLink).isSymbolicLink()).toBe(false);
    expect(readFileSync(ruleLink, 'utf8')).toBe(
      readFileSync(join(paths.envDir('work'), 'instructions', 'base.md'), 'utf8'),
    );

    // config-keys: BOTH servers injected into .claude.json; Claude is passthrough so
    // the ${SOME_TOKEN} placeholder is kept verbatim (no secret written, env reproduced).
    const cfg = JSON.parse(readFileSync(userJson, 'utf8'));
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(['github', 'notes']);
    expect(cfg.mcpServers.github.env.GITHUB_TOKEN).toBe('${SOME_TOKEN}');
    expect(cfg.hasCompletedOnboarding).toBe(true); // host state preserved
    expectRealHomeUntouched(real);
  });

  it('reports the unresolved ${SOME_TOKEN} on a substitute-rung harness, skips only that server, materialises the rest', async () => {
    const real = guardRealHome();
    const remote = bareRemote();
    await seedOriginAndPush(remote.url);
    // A fresh clone with NO secrets.env → ${SOME_TOKEN} cannot be resolved.
    const { th, paths } = await freshRestore(remote.url);
    expect(existsSync(paths.secrets)).toBe(false);

    const realRoot = join(th.home, 'fixture-copy');
    mkdirSync(realRoot, { recursive: true });
    const env: NodeJS.ProcessEnv = { ...th.env, FIXTURE_CONFIG_DIR: realRoot };

    const used = await run(['use', 'work', '--global'], {
      env,
      adapters: [makeFixtureAdapter({ substituteMcp: true })],
    });
    // Never fails the whole activation, but names the unresolved secret (actionable).
    expect(used.code).toBe(0);
    expect(used.stderr ?? '').toContain('SOME_TOKEN');

    const cfg = JSON.parse(readFileSync(join(realRoot, 'config.json'), 'utf8'));
    // Fail-closed per server: the secret-bearing server is skipped, the plain one lands.
    expect(cfg.mcpServers.github).toBeUndefined();
    expect(cfg.mcpServers.notes).toBeDefined();
    // The rest of the environment still materialised (the skill is on a real path).
    expect(existsSync(join(realRoot, 'skills', 'sharpen'))).toBe(true);
    expectRealHomeUntouched(real);
  });
});

describe('restore (criterion 5) probe 2: run builds a valid session view from the fresh clone', () => {
  it('composes the env stack and the fake harness observes the private root + composed skills/instructions/mcp', async () => {
    const real = guardRealHome();
    const remote = bareRemote();
    await seedOriginAndPush(remote.url);
    const { th } = await freshRestore(remote.url);

    const binDir = join(th.home, 'bin');
    installFixtureHarness(binDir);
    const env: NodeJS.ProcessEnv = {
      ...th.env,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
      // A hermetic (nonexistent) real root, so the view is env-content-only.
      FIXTURE_CONFIG_DIR: join(th.home, 'fixture-real'),
    };
    const cap = capturingExec();
    const opts = { env, cwd: th.home, adapters: [makeFixtureAdapter()], execHarness: cap.exec };

    // The fake harness, launched under the composed overrides, observes the private view.
    const rootRes = await run(['run', 'work', '--', 'fixture-harness', '--print-config-root'], opts);
    expect(rootRes.code).toBe(0);
    const viewRoot = cap.calls.at(-1)?.env[FIXTURE_CONFIG_ENV];
    expect(viewRoot).toBeTruthy();
    expect(cap.lastStdout().trim()).toBe(viewRoot);

    // The view carries the env's composed skill…
    await run(['run', 'work', '--', 'fixture-harness', '--list-skills'], opts);
    expect(cap.lastStdout()).toContain('sharpen');
    // …its MCP servers (passthrough view: both present)…
    await run(['run', 'work', '--', 'fixture-harness', '--show-mcp'], opts);
    const mcp = cap.lastStdout();
    expect(mcp).toContain('github');
    expect(mcp).toContain('notes');
    // …and its instructions.
    await run(['run', 'work', '--', 'fixture-harness', '--show-instructions'], opts);
    expect(cap.lastStdout()).toContain('concise');
    expectRealHomeUntouched(real);
  });
});
