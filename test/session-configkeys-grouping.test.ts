import { mkdirSync, readFileSync } from 'node:fs';
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

/** Two config-keys surfaces (Pi-like) targeting the SAME file at different arrays. */
function twoSurfaceAdapter(): Adapter {
  const base = makeFixtureAdapter();
  const surfaces: SurfaceDeclaration[] = [
    {
      id: 'packages',
      storeKind: 'skills',
      supported: true,
      mechanism: 'config-keys',
      rootRelativePath: 'settings.json',
      format: 'json',
      style: 'array-element',
      keyPath: ['packages'],
    },
    {
      id: 'skills-cfg',
      storeKind: 'skills',
      supported: true,
      mechanism: 'config-keys',
      rootRelativePath: 'settings.json',
      format: 'json',
      style: 'array-element',
      keyPath: ['skills'],
    },
  ];
  return {
    ...base,
    surfaces,
    classifyEntry(name): EntryBucket {
      return name === 'settings.json' ? 'managed' : base.classifyEntry(name);
    },
    async compileConfigKeys(surface) {
      if (surface.id === 'packages') return [{ style: 'array-element', arrayPath: ['packages'], value: 'pkg-a' }];
      if (surface.id === 'skills-cfg') return [{ style: 'array-element', arrayPath: ['skills'], value: 'skill-a' }];
      return [];
    },
  };
}

/**
 * H4 regression: config-keys surfaces sharing a target file must be composed
 * TOGETHER — seeded once, all injections applied, written once. Composing them
 * per-surface re-seeded and re-wrote the file, so the second surface clobbered
 * the first (Pi's two-array settings.json was unrepresentable).
 */
describe('session config-keys grouping (H4)', () => {
  it('two config-keys surfaces on one file both land (no clobber)', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    mkdirSync(paths.envDir('writing'), { recursive: true });

    const res = await composeView({
      paths,
      adapter: twoSurfaceAdapter(),
      envs: ['writing'],
      session: 'sess-1',
      realConfigRoot: join(th.home, 'no-real-root'),
      onWarn: () => {},
    });

    const cfg = JSON.parse(readFileSync(join(res.viewRoot, 'settings.json'), 'utf8'));
    expect(cfg.packages).toEqual(['pkg-a']);
    expect(cfg.skills).toEqual(['skill-a']);
  });
});
