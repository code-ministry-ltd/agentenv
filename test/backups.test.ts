import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backup, restore } from '../src/backups.js';
import { resolvePaths } from '../src/paths.js';
import { expectRealHomeUntouched, makeTempHome, guardRealHome } from './helpers.js';

describe('content-addressed backups', () => {
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

  function paths() {
    return resolvePaths(temp.env);
  }

  it('round-trips a file: backup then restore yields the original bytes', async () => {
    const p = paths();
    const file = join(temp.home, 'user-file.txt');
    const original = Buffer.from('the original contents\n');
    writeFileSync(file, original);

    const ref = await backup(p, file);
    expect(ref).toEqual({ kind: 'content', hash: expect.any(String) });

    // Mutate the file, then restore from the backup.
    writeFileSync(file, 'mutated contents');
    await restore(p, ref, file);

    expect(readFileSync(file)).toEqual(original);
  });

  it('is content-addressed: identical content dedups to a single stored object', async () => {
    const p = paths();
    const a = join(temp.home, 'a.txt');
    const b = join(temp.home, 'b.txt');
    const same = 'identical bytes';
    writeFileSync(a, same);
    writeFileSync(b, same);

    const refA = await backup(p, a);
    const refB = await backup(p, b);

    expect(refA).toEqual(refB); // same hash
    // Only one object physically stored despite two backups.
    expect(readdirSync(p.backups)).toHaveLength(1);
  });

  it('stores distinct objects for distinct content', async () => {
    const p = paths();
    const a = join(temp.home, 'a.txt');
    const b = join(temp.home, 'b.txt');
    writeFileSync(a, 'content one');
    writeFileSync(b, 'content two');

    const refA = await backup(p, a);
    const refB = await backup(p, b);

    expect(refA).not.toEqual(refB);
    expect(readdirSync(p.backups)).toHaveLength(2);
  });

  it('records an absent ref when the path does not exist (a CREATE has no backup)', async () => {
    const p = paths();
    const missing = join(temp.home, 'does-not-exist.txt');

    const ref = await backup(p, missing);

    expect(ref).toEqual({ kind: 'absent' });
    // No object stored for an absent path.
    expect(existsSync(p.backups) ? readdirSync(p.backups) : []).toHaveLength(0);
  });

  it('restoring an absent ref deletes the path (undo of a CREATE)', async () => {
    const p = paths();
    const created = join(temp.home, 'created-by-mutation.txt');
    const ref = await backup(p, created); // absent
    expect(ref).toEqual({ kind: 'absent' });

    // The mutation then created the file; undo must delete it.
    writeFileSync(created, 'materialised content');
    await restore(p, ref, created);

    expect(existsSync(created)).toBe(false);
  });

  it('restores into a destination whose parent directory does not yet exist', async () => {
    const p = paths();
    const file = join(temp.home, 'src.txt');
    writeFileSync(file, 'payload');
    const ref = await backup(p, file);

    const dest = join(temp.home, 'nested', 'deep', 'dest.txt');
    await restore(p, ref, dest);

    expect(readFileSync(dest, 'utf8')).toBe('payload');
  });

  it('backs up an empty file and restores it distinctly from an absent path', async () => {
    const p = paths();
    const file = join(temp.home, 'empty.txt');
    writeFileSync(file, '');
    const ref = await backup(p, file);
    expect(ref.kind).toBe('content');

    // Remove and restore — an empty file must reappear, not stay deleted.
    mkdirSync(join(temp.home, 'x'), { recursive: true });
    await restore(p, ref, file);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('');
  });

  it('round-trips a symlink, preserving link-ness and target (never follows it)', async () => {
    const p = paths();
    const target = join(temp.home, 'real-target.txt');
    writeFileSync(target, 'target contents');
    const link = join(temp.home, 'a-link');
    symlinkSync(target, link);

    const ref = await backup(p, link);
    expect(ref).toEqual({ kind: 'symlink', target });

    // Mutation replaced the link with a regular file; undo must restore the link.
    rmSync(link);
    writeFileSync(link, 'now a regular file');
    await restore(p, ref, link);

    const st = lstatSync(link);
    expect(st.isSymbolicLink()).toBe(true); // a symlink, NOT a regular file
    expect(readlinkSync(link)).toBe(target);
  });

  it('round-trips a dangling symlink — restored as a dangling link, not deleted', async () => {
    const p = paths();
    const missing = join(temp.home, 'no-such-target');
    const link = join(temp.home, 'dangling-link');
    symlinkSync(missing, link);
    expect(existsSync(missing)).toBe(false); // target genuinely absent

    const ref = await backup(p, link);
    expect(ref).toEqual({ kind: 'symlink', target: missing });

    rmSync(link);
    await restore(p, ref, link);

    // lstat (does not follow) proves the link itself exists...
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(missing);
    // ...and existsSync (follows) proves it is still dangling, not a real file.
    expect(existsSync(link)).toBe(false);
  });

  it('round-trips a directory subtree, preserving a nested file and a nested symlink', async () => {
    const p = paths();
    const dir = join(temp.home, 'tree');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'sub', 'file.txt'), 'nested contents');
    symlinkSync('file.txt', join(dir, 'sub', 'rel-link')); // relative nested symlink

    const ref = await backup(p, dir);
    expect(ref.kind).toBe('directory');

    // Destroy the tree, then restore it whole.
    rmSync(dir, { recursive: true, force: true });
    await restore(p, ref, dir);

    expect(readFileSync(join(dir, 'sub', 'file.txt'), 'utf8')).toBe('nested contents');
    const linkStat = lstatSync(join(dir, 'sub', 'rel-link'));
    expect(linkStat.isSymbolicLink()).toBe(true); // nested symlink preserved as a link
    expect(readlinkSync(join(dir, 'sub', 'rel-link'))).toBe('file.txt');
  });
});
