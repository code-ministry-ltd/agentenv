import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backup } from '../src/backups.js';
import { beginTransaction, recoverState, type PlannedMutation } from '../src/journal.js';
import { resolvePaths } from '../src/paths.js';
import { findOwner, readState, writeState, type ManifestItem } from '../src/state.js';
import { expectRealHomeUntouched, makeTempHome, realHomeSnapshot } from './helpers.js';

function item(path: string, ownerEnv = 'work'): ManifestItem {
  return { action: 'symlink', surface: 'dir-merge', path, ownerEnv } as ManifestItem;
}

describe('write-ahead journal / transaction', () => {
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

  it('journals a mutation to disk BEFORE its effect runs', async () => {
    const p = paths();
    const target = join(temp.home, 'target.txt');
    const backupRef = await backup(p, target); // absent — this is a CREATE

    const mutation: PlannedMutation = {
      op: 'add',
      item: item(target),
      undo: { path: target, backupRef },
    };

    let journalledWhenEffectRan = false;
    const tx = await beginTransaction(p);
    await tx.apply(mutation, async () => {
      // At the moment the effect runs, the entry must already be on disk.
      const onDisk = await readState(p);
      journalledWhenEffectRan = (onDisk.journal ?? []).some((e) => e.item.path === target);
      writeFileSync(target, 'materialised');
    });

    expect(journalledWhenEffectRan).toBe(true);
  });

  it('persists a journal entry with the documented {op, item, undo} shape', async () => {
    const p = paths();
    const target = join(temp.home, 'x.txt');
    const backupRef = await backup(p, target);
    const tx = await beginTransaction(p);
    await tx.apply(
      { op: 'add', item: item(target), undo: { path: target, backupRef } },
      async () => writeFileSync(target, 'v1'),
    );

    const entry = (await readState(p)).journal?.[0];
    expect(entry).toMatchObject({
      op: 'add',
      item: { surface: 'dir-merge', path: target },
      undo: { path: target, backupRef: { kind: 'absent' } },
    });
  });

  it('commit applies the manifest change and clears the journal', async () => {
    const p = paths();
    const target = join(temp.home, 'skill');
    const backupRef = await backup(p, target);
    const tx = await beginTransaction(p);
    await tx.apply(
      { op: 'add', item: item(target), undo: { path: target, backupRef } },
      async () => writeFileSync(target, 'link'),
    );
    await tx.commit();

    const manifest = await readState(p);
    expect(manifest.journal).toBeNull();
    expect(findOwner(manifest, target)?.ownerEnv).toBe('work');
    expect(existsSync(target)).toBe(true); // effect stands after commit
  });

  it('rollback (in-process) restores backups and leaves the manifest unchanged', async () => {
    const p = paths();
    const file = join(temp.home, 'user.md');
    writeFileSync(file, 'ORIGINAL');
    const backupRef = await backup(p, file); // content backup of ORIGINAL

    const tx = await beginTransaction(p);
    await tx.apply(
      { op: 'add', item: item(file), undo: { path: file, backupRef } },
      async () => writeFileSync(file, 'MUTATED'),
    );
    await tx.rollback();

    expect(readFileSync(file, 'utf8')).toBe('ORIGINAL'); // effect undone
    const manifest = await readState(p);
    expect(manifest.items).toHaveLength(0); // never committed
    expect(manifest.journal).toBeNull();
  });

  it('rolls back multiple mutations to the same path in reverse order', async () => {
    const p = paths();
    const file = join(temp.home, 'multi.txt');
    writeFileSync(file, 'V0');

    const tx = await beginTransaction(p);

    const ref0 = await backup(p, file); // V0
    await tx.apply(
      { op: 'add', item: item(file), undo: { path: file, backupRef: ref0 } },
      async () => writeFileSync(file, 'V1'),
    );

    const ref1 = await backup(p, file); // V1
    await tx.apply(
      { op: 'add', item: { ...item(file), key: 'second' } as ManifestItem, undo: { path: file, backupRef: ref1 } },
      async () => writeFileSync(file, 'V2'),
    );

    await tx.rollback();
    // Reverse restore: V1 then V0 => back to the original.
    expect(readFileSync(file, 'utf8')).toBe('V0');
  });

  it('recovers a crash BETWEEN journal-write and apply (effect never mutated)', async () => {
    const p = paths();
    const target = join(temp.home, 'created.txt'); // does not exist -> a CREATE
    const backupRef = await backup(p, target); // absent

    const tx = await beginTransaction(p);
    // Simulate a crash right after the write-ahead journal, before the effect
    // does anything: the effect throws immediately without mutating.
    await expect(
      tx.apply({ op: 'add', item: item(target), undo: { path: target, backupRef } }, async () => {
        throw new Error('killed before mutation');
      }),
    ).rejects.toThrow('killed before mutation');
    // Process dies here — no commit, no rollback. A fresh invocation recovers.

    const result = await recoverState(p);
    expect(result).toEqual({ recovered: true, rolledBack: 1 });
    expect(existsSync(target)).toBe(false); // undo of a CREATE = delete
    expect((await readState(p)).journal).toBeNull();
  });

  it('recovers a crash MID-apply (effect partially mutated, then died)', async () => {
    const p = paths();
    const file = join(temp.home, 'config.json');
    writeFileSync(file, 'ORIGINAL');
    const backupRef = await backup(p, file); // content backup

    const tx = await beginTransaction(p);
    await expect(
      tx.apply({ op: 'add', item: item(file), undo: { path: file, backupRef } }, async () => {
        writeFileSync(file, 'HALF-WRITTEN CORRUPT'); // partial mutation
        throw new Error('killed mid-write');
      }),
    ).rejects.toThrow('killed mid-write');
    // Process dies with a corrupt file on disk and an uncommitted journal.

    const result = await recoverState(p);
    expect(result.recovered).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('ORIGINAL'); // restored to consistent state
    expect((await readState(p)).journal).toBeNull();
  });

  it('refuses to begin a new transaction while a journal is pending', async () => {
    const p = paths();
    const manifest = await readState(p);
    manifest.journal = [
      { op: 'add', item: item('/x'), undo: { path: '/x', backupRef: { kind: 'absent' } } },
    ];
    await writeState(p, manifest);

    await expect(beginTransaction(p)).rejects.toThrow(/unfinished|recover/i);
  });

  it('recoverState is a no-op when there is no pending journal', async () => {
    const p = paths();
    expect(await recoverState(p)).toEqual({ recovered: false, rolledBack: 0 });
  });
});
