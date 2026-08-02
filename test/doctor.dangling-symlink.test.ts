import { existsSync, lstatSync, mkdirSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { resolvePaths } from '../src/paths.js';
import { emptyManifest, writeState, type ManifestItem, type StateManifest } from '../src/state.js';
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
 * Fixture: a manifest-owned dir-merge symlink whose on-disk link is BROKEN (points
 * nowhere) while its store source still EXISTS — a dangling link the manifest +
 * store can re-materialise (design D4). Distinct from store-vs-manifest drift,
 * where the store source itself is gone.
 */
async function seedDangling(th: TempHome): Promise<{ linkPath: string; storeSource: string }> {
  const paths = resolvePaths(th.env);
  mkdirSync(paths.base, { recursive: true });

  // The store source EXISTS (a real skill folder in the env store).
  const storeSource = join(paths.envDir('writing'), 'skills', 'w-skill');
  mkdirSync(storeSource, { recursive: true });
  writeFileSync(join(storeSource, 'SKILL.md'), '# w skill\n');

  // The placed link is BROKEN — it points at a path that does not exist.
  const skillsDir = join(th.home, 'real', 'skills');
  mkdirSync(skillsDir, { recursive: true });
  const linkPath = join(skillsDir, 'w-skill');
  symlinkSync(join(th.home, 'real', 'gone-target'), linkPath);

  const item: ManifestItem = {
    action: 'symlink',
    surface: 'dir-merge',
    path: linkPath,
    target: storeSource,
    ownerEnv: 'writing',
    backupRef: { kind: 'absent' },
  } as unknown as ManifestItem;
  const manifest: StateManifest = { ...emptyManifest(), items: [item] };
  await writeState(paths, manifest);
  return { linkPath, storeSource };
}

describe('doctor: dangling symlinks', () => {
  it('detects a dangling owned link and exits non-zero (read-only)', async () => {
    const th = home();
    const { linkPath } = await seedDangling(th);
    // Sanity: the link is genuinely broken to start.
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(existsSync(linkPath)).toBe(false); // resolves to nothing

    const res = await run(['doctor'], { env: th.env });
    expect(res.code).not.toBe(0);
    expect(`${res.stdout}${res.stderr ?? ''}`).toContain('dangling');
    // Never mutates: still broken.
    expect(existsSync(linkPath)).toBe(false);
  });

  it('--repair re-materialises the link to the store source, re-run clean', async () => {
    const th = home();
    const { linkPath, storeSource } = await seedDangling(th);

    const repair = await run(['doctor', '--repair'], { env: th.env });
    expect(repair.code).toBe(0);

    // The link now resolves and points at the store source.
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkPath)).toBe(storeSource);
    expect(statSync(linkPath).isDirectory()).toBe(true); // resolves

    const rerun = await run(['doctor'], { env: th.env });
    expect(rerun.code).toBe(0);
  });
});
