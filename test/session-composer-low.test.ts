import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Adapter, EntryBucket, SurfaceDeclaration } from '../src/adapter.js';
import { resolvePaths } from '../src/paths.js';
import { composeView } from '../src/session/composer.js';
import { makeFixtureAdapter } from './fixtures/fixture-adapter.js';
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

/** Seed an env whose single MCP server is named `shared` with a distinguishing url. */
function seedSharedServer(envDir: string, url: string): void {
  mkdirSync(join(envDir, 'mcp'), { recursive: true });
  writeFileSync(join(envDir, 'mcp', 'servers.yaml'), `shared:\n  url: ${url}\n`);
}

describe('session composer hardening (LOW)', () => {
  it('L2: a later env overriding an earlier env config-keys value records a skip naming the loser', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    seedSharedServer(paths.envDir('a'), 'from-a');
    seedSharedServer(paths.envDir('b'), 'from-b');

    const skips: string[] = [];
    const res = await composeView({
      paths,
      adapter: makeFixtureAdapter(),
      envs: ['a', 'b'], // b is later → wins; a is the named loser
      session: 'sess-1',
      realConfigRoot: join(th.home, 'no-real-root'),
      onWarn: (m) => skips.push(m),
    });

    const cfg = JSON.parse(readFileSync(join(res.viewRoot, 'config.json'), 'utf8'));
    expect(cfg.mcpServers.shared.url).toBe('from-b'); // later env wins (D5)
    expect(skips.join(' ')).toContain("env 'a' overridden by env 'b'");
    expect(res.skipped.some((s) => s.detail.includes("env 'a' overridden by env 'b'"))).toBe(true);
  });

  it('L4: array-element dedup is order-insensitive for object values', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    mkdirSync(paths.envDir('x'), { recursive: true });

    // An adapter that injects the SAME object twice with different key order.
    const base = makeFixtureAdapter();
    const surfaces: SurfaceDeclaration[] = [
      {
        id: 'list',
        storeKind: 'skills',
        supported: true,
        mechanism: 'config-keys',
        rootRelativePath: 'settings.json',
        format: 'json',
        style: 'array-element',
        keyPath: ['items'],
      },
    ];
    const adapter: Adapter = {
      ...base,
      surfaces,
      classifyEntry(name): EntryBucket {
        return name === 'settings.json' ? 'managed' : base.classifyEntry(name);
      },
      async compileConfigKeys() {
        return [
          { style: 'array-element', arrayPath: ['items'], value: { a: 1, b: 2 } },
          { style: 'array-element', arrayPath: ['items'], value: { b: 2, a: 1 } },
        ];
      },
    };

    const res = await composeView({
      paths,
      adapter,
      envs: ['x'],
      session: 'sess-1',
      realConfigRoot: join(th.home, 'no-real-root'),
      onWarn: () => {},
    });

    const cfg = JSON.parse(readFileSync(join(res.viewRoot, 'settings.json'), 'utf8'));
    expect(cfg.items).toHaveLength(1); // the reordered duplicate was NOT appended
  });

  it('L5: a session id that could escape the live/ dir is rejected', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    mkdirSync(paths.envDir('x'), { recursive: true });

    await expect(
      composeView({
        paths,
        adapter: makeFixtureAdapter(),
        envs: ['x'],
        session: '../escape',
        realConfigRoot: join(th.home, 'no-real-root'),
        onWarn: () => {},
      }),
    ).rejects.toThrow(/unsafe session id/);
  });
});
