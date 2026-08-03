import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Adapter, SurfaceDeclaration } from '../src/adapter.js';
import { run } from '../src/cli.js';
import { resolvePaths } from '../src/paths.js';
import { readState, writeState } from '../src/state.js';
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

/**
 * An adapter with a dir-merge skill surface PLUS an array-element config-keys
 * surface (OpenCode-style `instructions[]`). Used to drive Finding 2: an unguarded
 * array-element inject over a non-array real value aborts the whole `use --global`
 * AFTER the skill self-commits — the deterministic trigger for the Finding 1 orphan.
 */
function arrayElementAdapter(): Adapter {
  const base = makeFixtureAdapter();
  const skills: SurfaceDeclaration = {
    id: 'skills',
    storeKind: 'skills',
    supported: true,
    mechanism: 'dir-merge',
    rootRelativePath: 'skills',
    mode: 'symlink',
  };
  const instrList: SurfaceDeclaration = {
    id: 'instr-list',
    storeKind: 'instructions',
    supported: true,
    mechanism: 'config-keys',
    rootRelativePath: 'settings.json',
    format: 'json',
    style: 'array-element',
    keyPath: ['instructions'],
  };
  return {
    ...base,
    surfaces: [skills, instrList],
    classifyEntry(name) {
      return name === 'skills' || name === 'settings.json' ? 'managed' : 'state';
    },
    async compileConfigKeys(surface) {
      if (surface.id !== 'instr-list') return [];
      return [{ style: 'array-element', arrayPath: ['instructions'], value: 'writing/base.md' }];
    },
  };
}

/** Materialise a single-env fixture stack, then simulate the Finding-1 crash: the
 * items are committed but the `globalStack` write was lost (empty stack, no journal). */
async function materialiseThenOrphan(
  th: TempHome,
): Promise<{ paths: ReturnType<typeof resolvePaths>; realHome: string; env: NodeJS.ProcessEnv }> {
  const paths = resolvePaths(th.env);
  const realHome = join(th.home, 'real');
  mkdirSync(realHome, { recursive: true });
  writeFileSync(join(realHome, 'INSTRUCTIONS.md'), '# user\n');
  writeFileSync(join(realHome, 'config.json'), '{}\n');
  const envDir = paths.envDir('writing');
  mkdirSync(join(envDir, 'skills', 'w-skill'), { recursive: true });
  writeFileSync(join(envDir, 'skills', 'w-skill', 'SKILL.md'), '# w\n');
  mkdirSync(join(envDir, 'instructions'), { recursive: true });
  writeFileSync(join(envDir, 'instructions', 'base.md'), 'writing base\n');
  mkdirSync(join(envDir, 'mcp'), { recursive: true });
  writeFileSync(join(envDir, 'mcp', 'servers.yaml'), 'linear:\n  url: https://x\n');

  const env: NodeJS.ProcessEnv = { ...th.env, [FIXTURE_CONFIG_ENV]: realHome };
  await run(['use', 'writing', '--global'], { env, adapters: [makeFixtureAdapter()] });

  // Simulate the crash between the item commits and writeGlobalStack (D4).
  const manifest = await readState(paths);
  expect(manifest.items.length).toBeGreaterThan(0);
  (manifest as { globalStack?: string[] }).globalStack = [];
  await writeState(paths, manifest);

  return { paths, realHome, env };
}

describe('engine: global orphan recovery (Finding 1/2)', () => {
  it('use --global SKIPS (not aborts) an array-element surface whose real target is a non-array (Finding 2)', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const realHome = join(th.home, 'real');
    mkdirSync(realHome, { recursive: true });
    // A NON-array value where the array-element surface wants an array.
    writeFileSync(join(realHome, 'settings.json'), '{\n  "instructions": "NOT-AN-ARRAY"\n}\n');
    mkdirSync(join(paths.envDir('writing'), 'skills', 'w-skill'), { recursive: true });
    writeFileSync(join(paths.envDir('writing'), 'skills', 'w-skill', 'SKILL.md'), '# w\n');

    const env: NodeJS.ProcessEnv = { ...th.env, [FIXTURE_CONFIG_ENV]: realHome };
    const res = await run(['use', 'writing', '--global'], { env, adapters: [arrayElementAdapter()] });

    // Post-fix: the invocation COMPLETES with a skip-warn — it does not abort.
    expect(res.code).toBe(0);
    expect(res.stderr ?? '').toContain('is not an array');
    // The dir-merge skill is materialised (not orphaned).
    expect(lstatSync(join(realHome, 'skills', 'w-skill')).isSymbolicLink()).toBe(false);
    // The stack IS persisted (the invocation reached writeGlobalStack).
    const manifest = await readState(paths);
    expect(manifest.globalStack).toEqual(['writing']);
    // The array-element key was skipped, not owned.
    expect(manifest.items.some((i) => i.surface === 'config-keys')).toBe(false);
  });

  it('drop --global --all clears manifest-owned items even when the global stack is empty (Finding 1)', async () => {
    const th = home();
    const { paths, realHome, env } = await materialiseThenOrphan(th);
    const opts = { env, adapters: [makeFixtureAdapter()] };

    // Orphan precondition: owned items on disk, but an empty persisted stack.
    expect(existsSync(join(realHome, 'skills', 'w-skill'))).toBe(true);
    expect((await readState(paths)).globalStack).toEqual([]);

    const res = await run(['drop', '--global', '--all'], opts);
    expect(res.code).toBe(0);

    // Every owned item is removed and the real surfaces are restored.
    const after = await readState(paths);
    expect(after.items).toEqual([]);
    expect(after.globalStack).toEqual([]);
    expect(existsSync(join(realHome, 'skills', 'w-skill'))).toBe(false);
  });

  it('status surfaces an owned-but-unstacked env as recovered/orphaned (Finding 1)', async () => {
    const th = home();
    const { env } = await materialiseThenOrphan(th);

    const res = await run(['status'], { env, adapters: [makeFixtureAdapter()] });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('writing'); // the orphaned env is not invisible
    expect(res.stdout.toLowerCase()).toMatch(/recover|orphan/);
  });
});
