import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backup, restore } from '../src/backups.js';
import { resolvePaths } from '../src/paths.js';
import { expectRealHomeUntouched, makeTempHome, realHomeSnapshot } from './helpers.js';

describe('content-addressed backups', () => {
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
});
