import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import { backup, restore, type BackupRef } from './backups.js';
import { retainGlobalCowBytes } from './global-cow.js';
import { observeProjection, retireProjection, type GlobalProjection } from './global-projection.js';
import { beginTransaction } from './journal.js';
import { withLock } from './lock.js';
import { capturePathIdentity } from './path-identity.js';
import type { Paths } from './paths.js';
import { findOwner, readState, writeState, type ManifestItemBase } from './state.js';

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
export type DirMergeMode = 'symlink' | 'copy' | 'cow';

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
  /** Durable retained-COW lifecycle record for unsupervised global writers. */
  projectionId?: string;
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
  /** Associate this copy with a retained global COW projection. */
  projectionId?: string;
  /**
   * Take over a conflicting non-owned item instead of skipping it: back it up
   * (dir, symlink or file — {@link backup} handles each) and record the ref so
   * {@link dematerialise} restores it. Defaults to `false` (D1). No effect on a
   * free name or an item we already own.
   */
  force?: boolean;
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

/**
 * Whether `name` is a single path segment safe to place inside a surface dir.
 * Rejects `..`/`.`, path separators, and anything `basename` would rewrite —
 * without this, `join(targetDir, '../x')` escapes the surface entirely (and in
 * `force` mode would back up and clobber an arbitrary out-of-surface path).
 */
function isSingleSegment(name: string): boolean {
  return (
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    basename(name) === name
  );
}

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

/**
 * Whether the item on disk is still the link/copy agentenv placed. Guards a
 * destructive `absent`-backup undo: if the user replaced our symlink with their
 * own content out-of-band, we must not delete it. A missing path counts as
 * still-ours (deleting it would be a harmless no-op anyway).
 */
async function isStillOurs(item: DirMergeItem): Promise<boolean> {
  let st;
  try {
    st = await lstat(item.path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw err;
  }
  if (item.action === 'symlink') {
    return st.isSymbolicLink() && (await readlink(item.path)) === item.target;
  }
  return true; // a copy is our own managed content; deleting it on drop is correct
}

/** Recursively copy a directory, preserving nested files and symlinks. */
async function copyDir(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isSymbolicLink()) {
      await symlink(await readlink(from), to);
    } else if (entry.isDirectory()) {
      await copyDir(from, to);
    } else if (entry.isFile()) {
      await copyFile(from, to);
    }
    // else: a special file we cannot meaningfully copy — skip it.
  }
}

/** Copy a store item (a file, directory, or symlink) to `dest`. */
async function copyPath(src: string, dest: string): Promise<void> {
  const st = await lstat(src);
  if (st.isSymbolicLink()) {
    await symlink(await readlink(src), dest);
  } else if (st.isDirectory()) {
    await copyDir(src, dest);
  } else {
    await copyFile(src, dest);
  }
}

/** Copy for an unsupervised writer, dereferencing store-contained symlinks. */
async function copyCowPath(paths: Paths, src: string, dest: string): Promise<void> {
  const st = await lstat(src);
  if (st.isSymbolicLink()) {
    const resolved = await realpath(src);
    const storeRoot = await realpath(paths.store).catch(() => paths.store);
    if (resolved !== storeRoot && !resolved.startsWith(storeRoot + sep)) {
      throw new Error(`global COW source symlink escapes the canonical store: ${src}`);
    }
    await copyCowPath(paths, resolved, dest);
    return;
  }
  if (st.isDirectory()) {
    await mkdir(dest, { recursive: true });
    for (const entry of await readdir(src)) {
      await copyCowPath(paths, join(src, entry), join(dest, entry));
    }
    return;
  }
  if (st.isFile()) await copyFile(src, dest);
}

/** Place the store item at `targetPath` using `mode`. */
async function placeItem(
  paths: Paths,
  mode: DirMergeMode,
  sourcePath: string,
  targetPath: string,
): Promise<void> {
  if (mode === 'symlink') {
    await symlink(sourcePath, targetPath);
    return;
  }
  if (mode === 'cow') {
    await copyCowPath(paths, sourcePath, targetPath);
    return;
  }
  await copyPath(sourcePath, targetPath);
}

/** Whether two regular files hold identical bytes. */
async function sameFile(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([readFile(a), readFile(b)]);
  return da.equals(db);
}

/**
 * Make `dest` mirror the directory `src`, writing only what differs: changed or
 * new files are copied, files absent from `src` are removed (the working copy
 * is authoritative). Nested dirs recurse; nested symlinks are recreated.
 */
async function mirrorDir(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const srcEntries = await readdir(src, { withFileTypes: true });
  const srcNames = new Set(srcEntries.map((e) => e.name));

  // Drop anything in the store no longer present in the working copy.
  for (const entry of await readdir(dest, { withFileTypes: true })) {
    if (!srcNames.has(entry.name)) {
      await rm(join(dest, entry.name), { recursive: true, force: true });
    }
  }

  for (const entry of srcEntries) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isSymbolicLink()) {
      await rm(to, { recursive: true, force: true });
      await symlink(await readlink(from), to);
    } else if (entry.isDirectory()) {
      await mirrorPath(from, to);
    } else if (entry.isFile()) {
      await mirrorPath(from, to);
    }
  }
}

/**
 * Make `dest` a byte-identical mirror of `src`, replacing it wholesale if their
 * kinds differ. Only differing regular files are rewritten, so an unchanged
 * store stays untouched (no spurious drift).
 */
async function mirrorPath(src: string, dest: string): Promise<void> {
  const st = await lstat(src);
  if (st.isDirectory()) {
    const destSt = await lstat(dest).catch(() => null);
    if (!destSt || !destSt.isDirectory()) {
      await rm(dest, { recursive: true, force: true });
      await copyDir(src, dest);
      return;
    }
    await mirrorDir(src, dest);
    return;
  }
  if (st.isSymbolicLink()) {
    await rm(dest, { recursive: true, force: true });
    await symlink(await readlink(src), dest);
    return;
  }
  // regular file
  const destSt = await lstat(dest).catch(() => null);
  if (!destSt || !destSt.isFile()) {
    await rm(dest, { recursive: true, force: true });
    await copyFile(src, dest);
    return;
  }
  if (!(await sameFile(src, dest))) {
    await writeFile(dest, await readFile(src));
  }
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
    projectionId,
    force = false,
    onWarn = (m: string) => console.warn(m),
  } = options;
  if (!isSingleSegment(itemName)) {
    throw new Error(
      `dir-merge: invalid item name '${itemName}' — must be a single path segment ` +
        `(no '/', '\\', '.' or '..')`,
    );
  }
  const targetPath = join(targetDir, itemName);

  return withLock(paths, async () => {
    await mkdir(targetDir, { recursive: true });

    const owned = findOwner(await readState(paths), targetPath);
    const present = await lexists(targetPath);

    // Something already holds the name. If we own it, this is an idempotent
    // re-activation — return the existing record untouched.
    if (present && owned) {
      return { status: 'materialised', item: owned as DirMergeItem };
    }
    // A non-owned item always wins (D1/D7): skip and warn unless `force` takes
    // it over.
    if (present && !force) {
      onWarn(
        `agentenv: skipping '${itemName}' for env '${ownerEnv}' — a non-agentenv item ` +
          `already exists at ${targetPath}`,
      );
      return { status: 'skipped', reason: 'conflict', path: targetPath, itemName };
    }

    // Free name → create. Non-owned + force → take over: back up the existing
    // item first (dir/symlink/file) so the takeover is reversible on drop or
    // crash (D1/D4). `present` here implies `force` (the skip branch returned).
    const takeover = present;
    const backupRef: BackupRef = takeover ? await backup(paths, targetPath) : { kind: 'absent' };
    const item: DirMergeItem = {
      surface: 'dir-merge',
      action: mode,
      path: targetPath,
      target: sourcePath,
      ownerEnv,
      backupRef,
      ...(projectionId ? { projectionId } : {}),
    };

    const tx = await beginTransaction(paths);
    try {
      await tx.apply({ op: 'add', item, undo: { path: targetPath, backupRef } }, async () => {
        if (takeover) await rm(targetPath, { recursive: true, force: true });
        await placeItem(paths, mode, sourcePath, targetPath);
      });
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
export async function dematerialise(
  paths: Paths,
  item: DirMergeItem,
  onWarn: (message: string) => void = (m: string) => console.warn(m),
): Promise<void> {
  await withLock(paths, async () => {
    const restoreRef: BackupRef = item.backupRef ?? { kind: 'absent' };
    // Defensive: an `absent` backup means "we created this from nothing, so undo
    // = delete item.path". Only delete if it is still the item we placed; if the
    // user replaced it out-of-band, restoring `absent` would rm THEIR data — so
    // leave their content in place and drop only our ownership.
    const initial = await readState(paths);
    const projection = item.projectionId
      ? initial.globalProjections.find((candidate) => candidate.id === item.projectionId)
      : undefined;
    let effect = (): Promise<void> => restore(paths, restoreRef, item.path);
    if ((item.action === 'copy' || item.action === 'cow') && projection?.phase === 'active') {
      effect = async (): Promise<void> => {
        await retainGlobalCowBytes(projection);
        await restore(paths, restoreRef, item.path);
      };
    }
    if (restoreRef.kind === 'absent' && !(await isStillOurs(item))) {
      onWarn(
        `agentenv: '${item.path}' is no longer the item agentenv placed — leaving it ` +
          `in place and dropping ownership only`,
      );
      effect = async (): Promise<void> => {
        /* leave the user's replacement in place — drop ownership only */
      };
    }
    const tx = await beginTransaction(paths);
    try {
      // Snapshot our current link/copy so a crash mid-drop restores it (the
      // manifest still owns it until commit).
      const undoRef = await backup(paths, item.path);
      await tx.apply(
        { op: 'remove', item, undo: { path: item.path, backupRef: undoRef } },
        effect,
      );
      await tx.commit();
      if (projection?.phase === 'active' && projection.retainedPath) {
        const manifest = await readState(paths);
        const index = manifest.globalProjections.findIndex(
          (candidate) => candidate.id === projection.id,
        );
        if (index !== -1) {
          const observed = await capturePathIdentity(projection.retainedPath);
          manifest.globalProjections[index] = {
            ...observeProjection(retireProjection(manifest.globalProjections[index]!), observed),
            retiredAt: Date.now(),
          } as GlobalProjection;
          await writeState(paths, manifest);
        }
      }
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  });
}

/**
 * Copy-mode write-back: diff a copied item (`item.path`) against its store
 * source (`item.target`) and write every change back to the store, so an agent
 * editing the working copy has its edits persisted (D1). Changed and new files
 * are written; files deleted from the copy are removed from the store. A no-op
 * for a symlink item (edits already write through). Touches no state, so it
 * needs no lock.
 */
export async function syncBack(paths: Paths, item: DirMergeItem): Promise<void> {
  if (item.action === 'symlink') return;
  await mirrorPath(item.path, item.target);
}
