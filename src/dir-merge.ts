import { lstat, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { backup, restore, type BackupRef } from './backups.js';
import { beginTransaction } from './journal.js';
import { withLock } from './lock.js';
import type { Paths } from './paths.js';
import { findOwner, readState, type ManifestItemBase } from './state.js';

/**
 * The dir-merge surface: skills, agents and commands, whose harness home is a
 * directory the user shares with agentenv. Each env item gets its OWN symlink
 * (or copy) beside the user's items — never a symlink of the whole directory,
 * which would obliterate the user's own items (design D1). Ownership of every
 * link is recorded in the state manifest so deactivation removes exactly ours
 * and nothing else (D4) — there is no scan-and-guess path.
 */

/**
 * How a store item is placed into the surface dir:
 * - `symlink` — a per-item symlink to the store source (the default; edits to
 *   the item write through to the store).
 * - `copy` — a copy-with-write-back fallback for surfaces where symlinks are
 *   unsupported (Windows, unverified symlink-following); {@link syncBack} diffs
 *   the copy against the store and writes changes back (D1).
 */
export type DirMergeMode = 'symlink' | 'copy';

/**
 * A dir-merge ownership record: a per-item symlink or copy in a shared surface
 * dir. `path` is the placed item; `target` is the store source it points at (a
 * symlink target, or the copy source for write-back). Registered on the open
 * {@link import('./state.js').ManifestItemVariants} registry below.
 */
export interface DirMergeItem extends ManifestItemBase {
  surface: 'dir-merge';
  action: DirMergeMode;
  /** The store source: the symlink target, or the copy source for write-back. */
  target: string;
}

declare module './state.js' {
  interface ManifestItemVariants {
    'dir-merge': DirMergeItem;
  }
}

/** Options for {@link materialise}. */
export interface MaterialiseOptions {
  /** The environment that will own the placed item (exactly one owner, D5). */
  ownerEnv: string;
  /** Absolute path to the store item (a skill folder, or an agent/command file). */
  sourcePath: string;
  /** The shared surface directory (e.g. `~/.claude/skills`). */
  targetDir: string;
  /** The item's name within `targetDir` (its basename). */
  itemName: string;
  /** Placement mechanism; defaults to `symlink`. */
  mode?: DirMergeMode;
  /** Where skip-and-warn notices go. Defaults to {@link console.warn}. */
  onWarn?: (message: string) => void;
}

/**
 * The outcome of {@link materialise}: the item was placed and recorded, or it
 * was skipped because a non-owned item already holds the name (D1/D7 — a
 * non-owned item always wins; agentenv never clobbers the user).
 */
export type MaterialiseResult =
  | { status: 'materialised'; item: DirMergeItem }
  | { status: 'skipped'; reason: 'conflict'; path: string; itemName: string };

/** Whether a path exists as a link/file/dir WITHOUT following symlinks. */
async function lexists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** Place the store item at `targetPath` using `mode`. */
async function placeItem(mode: DirMergeMode, sourcePath: string, targetPath: string): Promise<void> {
  if (mode === 'symlink') {
    await symlink(sourcePath, targetPath);
    return;
  }
  throw new Error(`agentenv: dir-merge mode '${mode}' not implemented`);
}

/**
 * Materialise one store item into a shared surface dir as a per-item link (D1),
 * recording ownership through a write-ahead transaction so a crash rolls back
 * deterministically (D4). Runs under the machine lock (D11).
 */
export async function materialise(
  paths: Paths,
  options: MaterialiseOptions,
): Promise<MaterialiseResult> {
  const {
    ownerEnv,
    sourcePath,
    targetDir,
    itemName,
    mode = 'symlink',
    onWarn = (m: string) => console.warn(m),
  } = options;
  const targetPath = join(targetDir, itemName);

  return withLock(paths, async () => {
    await mkdir(targetDir, { recursive: true });

    const owned = findOwner(await readState(paths), targetPath);
    if (await lexists(targetPath)) {
      // Something already holds the name. If we own it, this is an idempotent
      // re-activation — return the existing record untouched. If we do NOT own
      // it, a non-owned item always wins (D1/D7): skip and warn, never clobber.
      if (owned) {
        return { status: 'materialised', item: owned as DirMergeItem };
      }
      onWarn(
        `agentenv: skipping '${itemName}' for env '${ownerEnv}' — a non-agentenv item ` +
          `already exists at ${targetPath}`,
      );
      return { status: 'skipped', reason: 'conflict', path: targetPath, itemName };
    }

    const backupRef: BackupRef = { kind: 'absent' };
    const item: DirMergeItem = {
      surface: 'dir-merge',
      action: mode,
      path: targetPath,
      target: sourcePath,
      ownerEnv,
      backupRef,
    };

    const tx = await beginTransaction(paths);
    try {
      await tx.apply({ op: 'add', item, undo: { path: targetPath, backupRef } }, () =>
        placeItem(mode, sourcePath, targetPath),
      );
      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }
    return { status: 'materialised', item };
  });
}

/**
 * Dematerialise a manifest-owned dir-merge item: remove ONLY the recorded
 * link/copy and restore any takeover backup (D4) — never scan and guess, so a
 * same-named user item is left untouched. The pre-effect state is journalled so
 * a crash mid-drop rolls back to the still-owned item.
 */
export async function dematerialise(paths: Paths, item: DirMergeItem): Promise<void> {
  await withLock(paths, async () => {
    const restoreRef: BackupRef = item.backupRef ?? { kind: 'absent' };
    const tx = await beginTransaction(paths);
    try {
      // Snapshot our current link/copy so a crash mid-drop restores it (the
      // manifest still owns it until commit).
      const undoRef = await backup(paths, item.path);
      await tx.apply({ op: 'remove', item, undo: { path: item.path, backupRef: undoRef } }, () =>
        restore(paths, restoreRef, item.path),
      );
      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  });
}
