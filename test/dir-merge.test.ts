import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { materialise, dematerialise, type MaterialiseResult } from '../src/dir-merge.js';
import { resolvePaths } from '../src/paths.js';
import { findOwner, readState } from '../src/state.js';
import { expectRealHomeUntouched, makeTempHome, realHomeSnapshot } from './helpers.js';

/** Narrow a result to the materialised case, failing the test otherwise. */
function materialised(result: MaterialiseResult) {
  if (result.status !== 'materialised') {
    throw new Error(`expected materialised, got ${result.status}`);
  }
  return result.item;
}

describe('dir-merge surface', () => {
  let temp: ReturnType<typeof makeTempHome>;
  let realBefore: ReturnType<typeof realHomeSnapshot>;

  beforeEach(() => {
    realBefore = realHomeSnapshot();
    temp = makeTempHome();
  });

  afterEach(() => {
    temp.cleanup();
    expectRealHomeUntouched(realBefore);
  });

  const paths = () => resolvePaths(temp.env);

  /** A store item (a skill folder) the env would materialise. */
  function makeStoreItem(name: string, body = `# ${name}\n`): string {
    const dir = join(temp.home, 'store-src', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), body);
    return dir;
  }

  /** A user's own item already living in the harness surface dir. */
  function makeUserItem(targetDir: string, name: string, body = 'user content\n'): string {
    const dir = join(targetDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), body);
    return dir;
  }

  describe('materialise (symlink) + dematerialise', () => {
    it("symlinks a store item beside the user's items — never the whole dir", async () => {
      const p = paths();
      const targetDir = join(temp.home, 'claude', 'skills');
      makeUserItem(targetDir, 'research'); // a pre-existing user skill
      const source = makeStoreItem('sharpen');

      const result = await materialise(p, {
        ownerEnv: 'writing',
        sourcePath: source,
        targetDir,
        itemName: 'sharpen',
        mode: 'symlink',
      });

      expect(result.status).toBe('materialised');

      // The item is a per-item symlink pointing at the store source...
      const link = join(targetDir, 'sharpen');
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(source);
      // ...that resolves to the store content...
      expect(readFileSync(join(link, 'SKILL.md'), 'utf8')).toBe('# sharpen\n');
      // ...and the surface dir itself is a real directory, NOT a symlink (D1).
      expect(lstatSync(targetDir).isSymbolicLink()).toBe(false);
      expect(lstatSync(targetDir).isDirectory()).toBe(true);
      // The user's own skill is untouched.
      expect(readFileSync(join(targetDir, 'research', 'SKILL.md'), 'utf8')).toBe('user content\n');

      // Ownership is recorded as a dir-merge/symlink record (D1/D4).
      const owner = findOwner(await readState(p), link);
      expect(owner).toMatchObject({
        surface: 'dir-merge',
        action: 'symlink',
        path: link,
        target: source,
        ownerEnv: 'writing',
        backupRef: { kind: 'absent' },
      });
    });

    it('dematerialise removes only the owned link, leaving other user items untouched', async () => {
      const p = paths();
      const targetDir = join(temp.home, 'claude', 'skills');
      makeUserItem(targetDir, 'research');
      const source = makeStoreItem('sharpen');

      const item = materialised(
        await materialise(p, {
          ownerEnv: 'writing',
          sourcePath: source,
          targetDir,
          itemName: 'sharpen',
          mode: 'symlink',
        }),
      );

      await dematerialise(p, item);

      // Our link is gone...
      expect(existsSync(join(targetDir, 'sharpen'))).toBe(false);
      // ...the user's skill survives...
      expect(readFileSync(join(targetDir, 'research', 'SKILL.md'), 'utf8')).toBe('user content\n');
      // ...the store source is never deleted...
      expect(readFileSync(join(source, 'SKILL.md'), 'utf8')).toBe('# sharpen\n');
      // ...and the ownership record is dropped.
      expect(findOwner(await readState(p), join(targetDir, 'sharpen'))).toBeUndefined();
    });
  });

  describe('conflict: a non-owned same-named item wins (D1/D7)', () => {
    it('skips and warns without clobbering an existing user item; records nothing', async () => {
      const p = paths();
      const targetDir = join(temp.home, 'claude', 'skills');
      // The user already has a skill named exactly like the env's item.
      makeUserItem(targetDir, 'sharpen', 'the users own sharpen\n');
      const source = makeStoreItem('sharpen', '# env sharpen\n');

      const warnings: string[] = [];
      const result = await materialise(p, {
        ownerEnv: 'writing',
        sourcePath: source,
        targetDir,
        itemName: 'sharpen',
        mode: 'symlink',
        onWarn: (m) => warnings.push(m),
      });

      // Skipped, not materialised (D7: a non-owned item always wins).
      expect(result.status).toBe('skipped');
      expect(result).toMatchObject({ reason: 'conflict', itemName: 'sharpen' });
      expect(warnings.some((w) => w.includes('sharpen'))).toBe(true);

      // The user's item is untouched — still a real dir with their content,
      // NOT replaced by a symlink to the store.
      const at = join(targetDir, 'sharpen');
      expect(lstatSync(at).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(at, 'SKILL.md'), 'utf8')).toBe('the users own sharpen\n');

      // Nothing was recorded as owned — so a later drop can't touch it.
      expect(findOwner(await readState(p), at)).toBeUndefined();
    });
  });
});
