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
import { materialise, dematerialise } from '../src/dir-merge.js';
import { resolvePaths } from '../src/paths.js';
import { findOwner, readState } from '../src/state.js';
import { expectRealHomeUntouched, makeTempHome, realHomeSnapshot } from './helpers.js';

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

      const { item } = await materialise(p, {
        ownerEnv: 'writing',
        sourcePath: source,
        targetDir,
        itemName: 'sharpen',
        mode: 'symlink',
      });

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
});
