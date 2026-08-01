import { existsSync, mkdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dematerialise, materialise } from '../src/dir-merge.js';
import { resolvePaths } from '../src/paths.js';
import { expectRealHomeUntouched, makeTempHome, guardRealHome, type TempHome } from './helpers.js';

/**
 * Regression for review findings on 1.3: (Major) an unvalidated `itemName` was
 * `join`'d into the surface dir, so `../x` escaped it (and in force mode clobbered
 * an out-of-surface path); (Minor) dematerialise of an `absent`-backup item
 * unconditionally deleted whatever was at the path, destroying a user's
 * out-of-band replacement.
 */
describe('dir-merge path-safety', () => {
  let tmp: TempHome;
  let realBefore: ReturnType<typeof guardRealHome>;
  beforeEach(() => {
    realBefore = guardRealHome();
    tmp = makeTempHome();
  });
  afterEach(() => {
    tmp.cleanup();
    expectRealHomeUntouched(realBefore);
  });

  function storeItem(): string {
    const src = join(tmp.home, 'store-item');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'SKILL.md'), 'x');
    return src;
  }

  const badNames = ['..', '.', '../escape', 'a/b', 'nested/../x', ''];
  for (const bad of badNames) {
    it(`dir-merge materialise rejects itemName '${bad}'`, async () => {
      const paths = resolvePaths(tmp.env);
      await expect(
        materialise(paths, {
          ownerEnv: 'e',
          sourcePath: storeItem(),
          targetDir: join(tmp.home, 'surface'),
          itemName: bad,
          force: true,
        }),
      ).rejects.toThrow(/invalid item name|single path segment/i);
    });
  }

  it('dir-merge materialise (force) cannot back up and clobber a path outside the surface', async () => {
    const paths = resolvePaths(tmp.env);
    const surface = join(tmp.home, 'nested', 'surface');
    mkdirSync(surface, { recursive: true });
    const victim = join(tmp.home, 'nested', 'victim');
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, 'keep'), 'important');

    await expect(
      materialise(paths, {
        ownerEnv: 'e',
        sourcePath: storeItem(),
        targetDir: surface,
        itemName: '../victim',
        force: true,
      }),
    ).rejects.toThrow();
    expect(existsSync(join(victim, 'keep'))).toBe(true); // never touched
  });

  it('dir-merge dematerialise does NOT delete a user replacement of a free-name symlink', async () => {
    const paths = resolvePaths(tmp.env);
    const surface = join(tmp.home, 'surface');
    const res = await materialise(paths, {
      ownerEnv: 'e',
      sourcePath: storeItem(),
      targetDir: surface,
      itemName: 'sharpen',
    });
    if (res.status !== 'materialised') throw new Error('expected materialised');
    const placed = join(surface, 'sharpen');
    expect(readlinkSync(placed)).toBe(join(tmp.home, 'store-item')); // our symlink

    // User replaces our symlink with their own directory, out of band.
    rmSync(placed);
    mkdirSync(placed);
    writeFileSync(join(placed, 'user-data'), 'do not delete');

    await dematerialise(paths, res.item);
    expect(existsSync(join(placed, 'user-data'))).toBe(true); // preserved, not rm'd
  });

  it('dir-merge dematerialise still deletes an unmodified free-name item it owns', async () => {
    const paths = resolvePaths(tmp.env);
    const surface = join(tmp.home, 'surface');
    const res = await materialise(paths, {
      ownerEnv: 'e',
      sourcePath: storeItem(),
      targetDir: surface,
      itemName: 'sharpen',
    });
    if (res.status !== 'materialised') throw new Error('expected materialised');
    const placed = join(surface, 'sharpen');
    expect(existsSync(placed)).toBe(true);
    await dematerialise(paths, res.item);
    expect(existsSync(placed)).toBe(false); // our own link removed as before
  });
});
