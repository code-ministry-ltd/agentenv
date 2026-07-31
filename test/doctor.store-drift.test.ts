import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { resolvePaths } from '../src/paths.js';
import { readState, writeState, type ManifestItem, type StateManifest } from '../src/state.js';
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
 * Fixture: a manifest dir-merge item whose STORE SOURCE is gone — the env store
 * folder it points at no longer exists (design D4: store-vs-manifest drift). The
 * placed link still points at the vanished source. It cannot be re-materialised,
 * so repair drops the orphaned materialisation and its ownership record.
 */
async function seedStoreDrift(th: TempHome): Promise<{ linkPath: string }> {
  const paths = resolvePaths(th.env);
  mkdirSync(paths.base, { recursive: true });

  // The store source does NOT exist (never created / deleted from the store).
  const storeSource = join(paths.envDir('writing'), 'skills', 'gone-skill');

  const skillsDir = join(th.home, 'real', 'skills');
  mkdirSync(skillsDir, { recursive: true });
  const linkPath = join(skillsDir, 'gone-skill');
  symlinkSync(storeSource, linkPath); // points at the missing store source

  const item: ManifestItem = {
    action: 'symlink',
    surface: 'dir-merge',
    path: linkPath,
    target: storeSource,
    ownerEnv: 'writing',
    backupRef: { kind: 'absent' },
  } as unknown as ManifestItem;
  const manifest: StateManifest = { version: '1.0', items: [item], journal: null };
  await writeState(paths, manifest);
  return { linkPath };
}

describe('doctor: store-vs-manifest drift', () => {
  it('detects a manifest item whose store source is gone (read-only)', async () => {
    const th = home();
    const { linkPath } = await seedStoreDrift(th);

    const res = await run(['doctor'], { env: th.env });
    expect(res.code).not.toBe(0);
    expect(`${res.stdout}${res.stderr ?? ''}`).toContain('store');
    // Never mutates: the orphaned link + record are still present.
    expect(existsSync(join(th.home, 'real', 'skills', 'gone-skill'))).toBe(false); // still dangling
    const paths = resolvePaths(th.env);
    expect((await readState(paths)).items).toHaveLength(1);
    void linkPath;
  });

  it('--repair drops the orphaned materialisation + record, re-run clean', async () => {
    const th = home();
    const { linkPath } = await seedStoreDrift(th);
    const paths = resolvePaths(th.env);

    const repair = await run(['doctor', '--repair'], { env: th.env });
    expect(repair.code).toBe(0);

    // The dangling link is gone and the manifest no longer owns it.
    const { lstatSync } = await import('node:fs');
    let stillLinked = true;
    try {
      lstatSync(linkPath);
    } catch {
      stillLinked = false;
    }
    expect(stillLinked).toBe(false);
    expect((await readState(paths)).items).toHaveLength(0);

    const rerun = await run(['doctor'], { env: th.env });
    expect(rerun.code).toBe(0);
  });
});
