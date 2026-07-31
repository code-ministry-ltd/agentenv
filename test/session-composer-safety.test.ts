import { mkdirSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateAdapter, type Adapter, type EntryBucket } from '../src/adapter.js';
import { composeView } from '../src/session/composer.js';
import { makeFixtureAdapter } from './fixtures/fixture-adapter.js';
import { resolvePaths } from '../src/paths.js';
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

/** An adapter that WRONGLY classifies its `skills` surface target as bucket-1 state. */
function misBucketedAdapter(): Adapter {
  const base = makeFixtureAdapter();
  return {
    ...base,
    classifyEntry(name): EntryBucket {
      if (name === 'skills') return 'state'; // BUG: a surface target must never be state
      return base.classifyEntry(name);
    },
  };
}

/**
 * H2 regression: a surface target mis-classified `state` must NOT become a
 * wholesale symlink into the user's real dir (which would then have per-item
 * env symlinks written THROUGH it into the real location).
 */
describe('session composer surface-target safety (H2)', () => {
  it('never composes into the real dir even when a surface target is mis-classified as state', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const realRoot = join(th.home, 'real');
    mkdirSync(join(realRoot, 'skills'), { recursive: true }); // real skills dir, EMPTY
    writeFileSync(join(realRoot, 'creds.json'), 'SECRET'); // a genuine bucket-1 entry

    const envDir = paths.envDir('writing');
    mkdirSync(join(envDir, 'skills', 'writing-skill'), { recursive: true });
    writeFileSync(join(envDir, 'skills', 'writing-skill', 'SKILL.md'), '# w\n');

    const res = await composeView({
      paths,
      adapter: misBucketedAdapter(),
      envs: ['writing'],
      session: 'sess-1',
      realConfigRoot: realRoot,
      onWarn: () => {},
    });

    // The user's REAL skills dir was never written into (stays empty).
    expect(readdirSync(join(realRoot, 'skills'))).toEqual([]);
    // The env skill was composed into the VIEW instead, pointing at the store.
    expect(readdirSync(join(res.viewRoot, 'skills'))).toEqual(['writing-skill']);
    expect(readlinkSync(join(res.viewRoot, 'skills', 'writing-skill'))).toBe(
      join(envDir, 'skills', 'writing-skill'),
    );
    // A genuine bucket-1 entry is still passed through as a symlink.
    expect(readlinkSync(join(res.viewRoot, 'creds.json'))).toBe(join(realRoot, 'creds.json'));
  });

  it('validateAdapter rejects an adapter whose surface target classifies as state', () => {
    const err = validateAdapter(misBucketedAdapter());
    expect(err).toContain('skills');
    expect(err).toContain('state');
  });
});
