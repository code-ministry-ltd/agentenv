import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import {
  materialise,
  dematerialise,
  syncBack,
  type MaterialiseResult,
} from '../src/dir-merge.js';
import { recoverState } from '../src/journal.js';
import { resolvePaths } from '../src/paths.js';
import { findOwner, readState } from '../src/state.js';
import { expectRealHomeUntouched, makeTempHome, guardRealHome } from './helpers.js';

/** Narrow a result to the materialised case, failing the test otherwise. */
function materialised(result: MaterialiseResult) {
  if (result.status !== 'materialised') {
    throw new Error(`expected materialised, got ${result.status}`);
  }
  return result.item;
}

describe('dir-merge surface', () => {
  let temp: ReturnType<typeof makeTempHome>;
  let realBefore: ReturnType<typeof guardRealHome>;

  beforeEach(() => {
    realBefore = guardRealHome();
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

  describe('force: back up, take over, and restore on drop (D1)', () => {
    it('takes over a user DIRECTORY and dematerialise restores it byte-identically', async () => {
      const p = paths();
      const targetDir = join(temp.home, 'claude', 'skills');
      const userDir = makeUserItem(targetDir, 'sharpen', 'the users own sharpen\n');
      writeFileSync(join(userDir, 'extra.txt'), 'a second user file\n');
      const source = makeStoreItem('sharpen', '# env sharpen\n');
      const at = join(targetDir, 'sharpen');

      const item = materialised(
        await materialise(p, {
          ownerEnv: 'writing',
          sourcePath: source,
          targetDir,
          itemName: 'sharpen',
          mode: 'symlink',
          force: true,
        }),
      );

      // The env item now owns the name: a symlink to the store, backed by a
      // directory backup so the takeover is reversible.
      expect(lstatSync(at).isSymbolicLink()).toBe(true);
      expect(readlinkSync(at)).toBe(source);
      expect(readFileSync(join(at, 'SKILL.md'), 'utf8')).toBe('# env sharpen\n');
      expect(item.backupRef).toEqual({ kind: 'directory', id: expect.any(String) });

      await dematerialise(p, item);

      // The user's original directory is restored byte-identically — a real
      // dir (not a symlink), with every file intact.
      expect(lstatSync(at).isSymbolicLink()).toBe(false);
      expect(lstatSync(at).isDirectory()).toBe(true);
      expect(readFileSync(join(at, 'SKILL.md'), 'utf8')).toBe('the users own sharpen\n');
      expect(readFileSync(join(at, 'extra.txt'), 'utf8')).toBe('a second user file\n');
      expect(findOwner(await readState(p), at)).toBeUndefined();
    });

    it('takes over a user SYMLINK and dematerialise restores link-ness and target', async () => {
      const p = paths();
      const targetDir = join(temp.home, 'claude', 'skills');
      mkdirSync(targetDir, { recursive: true });
      // The user's item is itself a symlink (e.g. an `npx skills` install).
      const userTarget = join(temp.home, 'elsewhere', 'sharpen');
      mkdirSync(userTarget, { recursive: true });
      writeFileSync(join(userTarget, 'SKILL.md'), 'linked user skill\n');
      const at = join(targetDir, 'sharpen');
      symlinkSync(userTarget, at);
      const source = makeStoreItem('sharpen', '# env sharpen\n');

      const item = materialised(
        await materialise(p, {
          ownerEnv: 'writing',
          sourcePath: source,
          targetDir,
          itemName: 'sharpen',
          mode: 'symlink',
          force: true,
        }),
      );

      // Now points at the store, backed by a symlink backup.
      expect(readlinkSync(at)).toBe(source);
      expect(item.backupRef).toEqual({ kind: 'symlink', target: userTarget });

      await dematerialise(p, item);

      // The user's symlink is restored as a symlink to its original target,
      // never a materialised copy.
      expect(lstatSync(at).isSymbolicLink()).toBe(true);
      expect(readlinkSync(at)).toBe(userTarget);
      expect(readFileSync(join(at, 'SKILL.md'), 'utf8')).toBe('linked user skill\n');
    });
  });

  describe('copy-with-write-back fallback (mode: copy, D1)', () => {
    it('copies the store item in as a real item, not a symlink', async () => {
      const p = paths();
      const targetDir = join(temp.home, 'opencode', 'skills');
      const source = makeStoreItem('sharpen', '# env sharpen\n');
      const at = join(targetDir, 'sharpen');

      const item = materialised(
        await materialise(p, {
          ownerEnv: 'writing',
          sourcePath: source,
          targetDir,
          itemName: 'sharpen',
          mode: 'copy',
        }),
      );

      // A real copy, not a link — the fallback for surfaces without symlinks.
      expect(lstatSync(at).isSymbolicLink()).toBe(false);
      expect(lstatSync(at).isDirectory()).toBe(true);
      expect(readFileSync(join(at, 'SKILL.md'), 'utf8')).toBe('# env sharpen\n');
      expect(item).toMatchObject({ action: 'copy', target: source });
    });

    it('round-trips a directory item: materialise(copy) → edit → syncBack → store updated → drop', async () => {
      const p = paths();
      const targetDir = join(temp.home, 'opencode', 'skills');
      const source = makeStoreItem('sharpen', '# env sharpen\n');
      writeFileSync(join(source, 'keep.txt'), 'unchanged\n');
      writeFileSync(join(source, 'gone.txt'), 'will be deleted in the copy\n');
      const at = join(targetDir, 'sharpen');

      const item = materialised(
        await materialise(p, {
          ownerEnv: 'writing',
          sourcePath: source,
          targetDir,
          itemName: 'sharpen',
          mode: 'copy',
        }),
      );

      // Edit the working copy: change a file, add a file, delete a file.
      writeFileSync(join(at, 'SKILL.md'), '# edited in the copy\n');
      writeFileSync(join(at, 'new.txt'), 'added in the copy\n');
      rmSync(join(at, 'gone.txt'));

      await syncBack(p, item);

      // The store now mirrors the working copy...
      expect(readFileSync(join(source, 'SKILL.md'), 'utf8')).toBe('# edited in the copy\n');
      expect(readFileSync(join(source, 'new.txt'), 'utf8')).toBe('added in the copy\n');
      expect(existsSync(join(source, 'gone.txt'))).toBe(false);
      // ...and an untouched file is left exactly as it was.
      expect(readFileSync(join(source, 'keep.txt'), 'utf8')).toBe('unchanged\n');

      // Drop removes the working copy but never the store.
      await dematerialise(p, item);
      expect(existsSync(at)).toBe(false);
      expect(readFileSync(join(source, 'SKILL.md'), 'utf8')).toBe('# edited in the copy\n');
    });

    it('round-trips a single-FILE item (an agent/command .md): edit → syncBack', async () => {
      const p = paths();
      const targetDir = join(temp.home, 'opencode', 'agents');
      const source = join(temp.home, 'store-src', 'reviewer.md');
      mkdirSync(join(temp.home, 'store-src'), { recursive: true });
      writeFileSync(source, 'original agent\n');
      const at = join(targetDir, 'reviewer.md');

      const item = materialised(
        await materialise(p, {
          ownerEnv: 'work',
          sourcePath: source,
          targetDir,
          itemName: 'reviewer.md',
          mode: 'copy',
        }),
      );
      expect(readFileSync(at, 'utf8')).toBe('original agent\n');

      writeFileSync(at, 'edited agent\n');
      await syncBack(p, item);
      expect(readFileSync(source, 'utf8')).toBe('edited agent\n');

      await dematerialise(p, item);
      expect(existsSync(at)).toBe(false);
      expect(readFileSync(source, 'utf8')).toBe('edited agent\n'); // store survives
    });
  });

  describe('transactional: a failed materialise rolls back (D4)', () => {
    it('restores a force-taken-over user item and records nothing when the effect fails', async () => {
      const p = paths();
      const targetDir = join(temp.home, 'claude', 'skills');
      const userDir = makeUserItem(targetDir, 'sharpen', 'the users own sharpen\n');
      writeFileSync(join(userDir, 'extra.txt'), 'second file\n');
      const at = join(targetDir, 'sharpen');
      const missingSource = join(temp.home, 'store-src', 'does-not-exist');

      // copy mode reads the source, so a missing source faults mid-effect —
      // AFTER the user's item was backed up and removed for takeover.
      await expect(
        materialise(p, {
          ownerEnv: 'writing',
          sourcePath: missingSource,
          targetDir,
          itemName: 'sharpen',
          mode: 'copy',
          force: true,
        }),
      ).rejects.toThrow();

      // The user's directory is restored byte-identically — the takeover left
      // no trace.
      expect(lstatSync(at).isDirectory()).toBe(true);
      expect(lstatSync(at).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(at, 'SKILL.md'), 'utf8')).toBe('the users own sharpen\n');
      expect(readFileSync(join(at, 'extra.txt'), 'utf8')).toBe('second file\n');

      // No ownership recorded, and no journal left pending (recovery is a no-op).
      const manifest = await readState(p);
      expect(findOwner(manifest, at)).toBeUndefined();
      expect(manifest.journal).toBeNull();
      expect(await recoverState(p)).toEqual({ recovered: false, rolledBack: 0 });
    });

    it('leaves a free name free (no orphan link, no record) when a create fails', async () => {
      const p = paths();
      const targetDir = join(temp.home, 'claude', 'skills');
      const at = join(targetDir, 'sharpen');
      const missingSource = join(temp.home, 'store-src', 'does-not-exist');

      await expect(
        materialise(p, {
          ownerEnv: 'writing',
          sourcePath: missingSource,
          targetDir,
          itemName: 'sharpen',
          mode: 'copy',
        }),
      ).rejects.toThrow();

      expect(existsSync(at)).toBe(false);
      const manifest = await readState(p);
      expect(findOwner(manifest, at)).toBeUndefined();
      expect(manifest.journal).toBeNull();
    });
  });
});
