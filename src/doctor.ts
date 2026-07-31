import { access, readdir, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { BackupRef } from './backups.js';
import { restore } from './backups.js';
import {
  dematerialise as dmDematerialise,
  materialise as dmMaterialise,
  type DirMergeItem,
} from './dir-merge.js';
import {
  inspectOwnedRegion,
  materialise as fbMaterialise,
  type FileBlockItem,
} from './file-block.js';
import { recoverState } from './journal.js';
import { withLock } from './lock.js';
import type { Paths } from './paths.js';
import { readState, type StateManifest } from './state.js';

/**
 * The base `doctor` (design D4, spec criterion 6). It DETECTS inconsistencies
 * between the write-ahead manifest and the real surfaces it owns, REPORTS each
 * one read-only, and — under `--repair` — returns every surface to a consistent
 * state by rolling the journal forward/back ({@link recoverState}) and re-driving
 * the surface mechanisms it already owns. Repair reuses the journalled, lock-
 * guarded mechanisms, so it is itself crash-safe: a kill mid-repair leaves at most
 * one pending journal the next run rolls back, and every repair is idempotent (a
 * second run reports clean).
 *
 * The manifest is self-describing (each item records its own path, store source,
 * markers and hash), so diagnosis and repair need no adapter registry — they work
 * off `state.json` + the surfaces on disk alone, which keeps `doctor` hermetic.
 */

/** The six base detectors (design D4 / spec criterion 6). */
export type DoctorProblemKind =
  | 'journal-pending'
  | 'dangling-symlink'
  | 'store-drift'
  | 'mangled-markers'
  | 'reserialised-config'
  | 'orphaned-backup';

/** One reported inconsistency: WHAT is wrong, WHERE, and what `--repair` will do. */
export interface DoctorProblem {
  kind: DoctorProblemKind;
  /** The surface / backup / state file the problem concerns. */
  where: string;
  /** Plain description of what is wrong. */
  what: string;
  /** What `--repair` would do about it. */
  repair: string;
}

/** Outcome of {@link repair}: the actions taken, then a fresh read-only re-scan. */
export interface RepairResult {
  /** Human-readable lines describing every fix applied, in order. */
  actions: string[];
  /** Problems still present after repair (should be empty on success). */
  remaining: DoctorProblem[];
}

// ---------------------------------------------------------------------------
// small fs helpers
// ---------------------------------------------------------------------------

/** Whether `p` exists (following symlinks — a broken link reads as absent). */
async function resolves(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** Whether `p` exists WITHOUT following symlinks (the link/file/dir is present). */
async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// dir-merge: a manifest-owned link whose on-disk target no longer resolves
// ---------------------------------------------------------------------------

/**
 * A manifest-owned dir-merge SYMLINK is dangling when its store source still
 * EXISTS but the on-disk link no longer resolves (broken, or replaced by a broken
 * link) — re-materialisable from the manifest + store. When the store source
 * itself is gone the item is store-vs-manifest drift instead (a later slice), so
 * that case is excluded here.
 */
async function isDangling(item: DirMergeItem): Promise<boolean> {
  if (item.action !== 'symlink') return false;
  if (!(await exists(item.target))) return false; // store source gone → store-drift, not dangling
  return !(await resolves(item.path)); // link present but resolves to nothing
}

/**
 * A manifest dir-merge item is store-vs-manifest drift when its store SOURCE is
 * gone (the env store folder it points at no longer exists, design D4). It cannot
 * be re-materialised, so repair drops the orphaned materialisation + its record.
 * Mutually exclusive with {@link isDangling}, which requires the source present.
 */
async function isStoreSourceGone(item: DirMergeItem): Promise<boolean> {
  return !(await exists(item.target));
}

// ---------------------------------------------------------------------------
// backups: referenced set + enumeration
// ---------------------------------------------------------------------------

/** The on-disk basename of a backup ref, or null for a ref that stores no file. */
function backupEntryName(ref: BackupRef | null | undefined): string | null {
  if (!ref) return null;
  if (ref.kind === 'content') return ref.hash;
  if (ref.kind === 'directory') return ref.id;
  return null; // symlink / absent refs store no file under backups/
}

/**
 * Every backup entry name the manifest still references — from committed item
 * `backupRef`s AND from any pending journal `undo.backupRef` (a pending journal's
 * backups must survive so recovery can use them). Anything under `backups/` NOT in
 * this set is orphaned (design D4).
 */
function referencedBackups(manifest: StateManifest): Set<string> {
  const set = new Set<string>();
  for (const item of manifest.items) {
    const name = backupEntryName((item as { backupRef?: BackupRef | null }).backupRef);
    if (name) set.add(name);
  }
  for (const entry of manifest.journal ?? []) {
    const name = backupEntryName(entry.undo?.backupRef);
    if (name) set.add(name);
  }
  return set;
}

/** List backup entry names on disk (empty when the dir does not exist yet). */
async function listBackupEntries(paths: Paths): Promise<string[]> {
  try {
    return await readdir(paths.backups);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** Backup entry names present on disk but referenced by no manifest item/journal. */
async function orphanedBackups(paths: Paths, manifest: StateManifest): Promise<string[]> {
  const referenced = referencedBackups(manifest);
  const entries = await listBackupEntries(paths);
  return entries.filter((name) => !referenced.has(name));
}

// ---------------------------------------------------------------------------
// detectors (read-only)
// ---------------------------------------------------------------------------

/** A pending/uncommitted journal — an interrupted transaction (design D4). */
function detectJournal(paths: Paths, manifest: StateManifest): DoctorProblem[] {
  const pending = manifest.journal?.length ?? 0;
  if (pending === 0) return [];
  return [
    {
      kind: 'journal-pending',
      where: paths.state,
      what: `an interrupted transaction is pending in state.json (${pending} journalled mutation(s))`,
      repair: 'roll the journal forward/back with recoverState, leaving the manifest consistent',
    },
  ];
}

/** Manifest-owned dir-merge links whose target no longer resolves (design D4). */
async function detectDanglingSymlinks(manifest: StateManifest): Promise<DoctorProblem[]> {
  const out: DoctorProblem[] = [];
  for (const item of manifest.items) {
    if (item.surface !== 'dir-merge') continue;
    const dm = item as DirMergeItem;
    if (!(await isDangling(dm))) continue;
    out.push({
      kind: 'dangling-symlink',
      where: dm.path,
      what: `owned dir-merge link '${dm.path}' does not resolve (its store source is present)`,
      repair: `re-materialise the symlink to ${dm.target}`,
    });
  }
  return out;
}

/** Manifest dir-merge items whose store source is gone (design D4). */
async function detectStoreDrift(manifest: StateManifest): Promise<DoctorProblem[]> {
  const out: DoctorProblem[] = [];
  for (const item of manifest.items) {
    if (item.surface !== 'dir-merge') continue;
    const dm = item as DirMergeItem;
    if (!(await isStoreSourceGone(dm))) continue;
    out.push({
      kind: 'store-drift',
      where: dm.path,
      what: `owned item '${dm.path}' has no store source — '${dm.target}' is gone`,
      repair: 'remove the orphaned materialisation and drop its ownership record',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// file-block: a manifest-owned marker region a harness rewrite broke
// ---------------------------------------------------------------------------

/** The file-block records in the manifest (one per (file, env) region). */
function fileBlockItems(manifest: StateManifest): FileBlockItem[] {
  return manifest.items.filter((i): i is FileBlockItem => i.surface === 'file-block');
}

/** A manifest-owned region that is no longer well-formed: `conflict` or `absent`. */
async function isRegionBroken(paths: Paths, item: FileBlockItem): Promise<boolean> {
  const insp = await inspectOwnedRegion(paths, { target: item.path, env: item.ownerEnv });
  return insp.status === 'conflict' || insp.status === 'absent';
}

/** Manifest-owned file-block regions whose markers a harness broke (design D4). */
async function detectMangledMarkers(
  paths: Paths,
  manifest: StateManifest,
): Promise<DoctorProblem[]> {
  const out: DoctorProblem[] = [];
  for (const item of fileBlockItems(manifest)) {
    const insp = await inspectOwnedRegion(paths, { target: item.path, env: item.ownerEnv });
    if (insp.status !== 'conflict' && insp.status !== 'absent') continue;
    const why =
      insp.status === 'conflict'
        ? `its markers were mangled (${insp.detail ?? 'no longer well-formed'})`
        : 'its managed marker region is missing';
    out.push({
      kind: 'mangled-markers',
      where: `${item.path} (env '${item.ownerEnv}')`,
      what: `the region env '${item.ownerEnv}' owns in ${item.path} is broken — ${why}`,
      repair: 'restore the file to its pre-materialise backup and re-materialise a clean region',
    });
  }
  return out;
}

/** Orphaned content/directory backups under `~/.agentenv/backups/` (design D4). */
async function detectOrphanedBackups(
  paths: Paths,
  manifest: StateManifest,
): Promise<DoctorProblem[]> {
  const orphans = await orphanedBackups(paths, manifest);
  return orphans.map((name) => ({
    kind: 'orphaned-backup',
    where: join(paths.backups, name),
    what: `backup '${name}' is referenced by no manifest item`,
    repair: 'delete the orphaned backup',
  }));
}

// ---------------------------------------------------------------------------
// diagnose (read-only) — never mutates
// ---------------------------------------------------------------------------

/**
 * Scan the manifest + the surfaces it owns and return every inconsistency found.
 * Purely read-only — `doctor` with no flag calls this and mutates nothing.
 */
export async function diagnose(paths: Paths): Promise<DoctorProblem[]> {
  const manifest = await readState(paths);
  const problems: DoctorProblem[] = [];
  problems.push(...detectJournal(paths, manifest));
  problems.push(...(await detectDanglingSymlinks(manifest)));
  problems.push(...(await detectStoreDrift(manifest)));
  problems.push(...(await detectMangledMarkers(paths, manifest)));
  problems.push(...(await detectOrphanedBackups(paths, manifest)));
  return problems;
}

// ---------------------------------------------------------------------------
// repair
// ---------------------------------------------------------------------------

/** Delete an orphaned backup entry (file or directory subtree). */
async function removeBackupEntry(paths: Paths, name: string): Promise<void> {
  await rm(join(paths.backups, name), { recursive: true, force: true });
}

/**
 * Re-materialise every dangling dir-merge symlink from the manifest + store. The
 * broken link is removed first (raw), because `dir-merge.materialise` treats an
 * already-present owned link as an idempotent no-op and would not replace it; the
 * fresh materialise is then journalled and lock-guarded. A crash between the two
 * leaves the record with a missing link + present source, which the next run
 * re-detects and re-repairs (idempotent).
 */
async function repairDanglingSymlinks(
  paths: Paths,
  manifest: StateManifest,
  actions: string[],
): Promise<void> {
  for (const item of manifest.items) {
    if (item.surface !== 'dir-merge') continue;
    const dm = item as DirMergeItem;
    if (!(await isDangling(dm))) continue;
    await rm(dm.path, { recursive: true, force: true });
    await dmMaterialise(paths, {
      ownerEnv: dm.ownerEnv,
      sourcePath: dm.target,
      targetDir: dirname(dm.path),
      itemName: basename(dm.path),
      mode: 'symlink',
    });
    actions.push(`re-materialised dangling link ${dm.path}`);
  }
}

/**
 * Drop every dir-merge materialisation whose store source is gone: remove the
 * (now sourceless) link and its ownership record via the manifest-driven,
 * journalled `dir-merge.dematerialise` — never scan-and-guess. It restores any
 * recorded takeover backup, so a user item the env had shadowed reappears.
 */
async function repairStoreDrift(
  paths: Paths,
  manifest: StateManifest,
  actions: string[],
): Promise<void> {
  for (const item of manifest.items) {
    if (item.surface !== 'dir-merge') continue;
    const dm = item as DirMergeItem;
    if (!(await isStoreSourceGone(dm))) continue;
    await dmDematerialise(paths, dm, () => {});
    actions.push(`dropped orphaned materialisation ${dm.path} (store source gone)`);
  }
}

/**
 * Restore a broken file-block region. The mechanisms fail CLOSED on mangled
 * markers (they refuse to reclaim a guessed span), so repair goes back to the
 * item's preserved pre-materialise backup — removing the mangled markers as bytes,
 * not by trusting them — then re-materialises a clean region from the manifest's
 * recorded sub-blocks + store. The re-materialise is journalled and lock-guarded.
 *
 * Scope: one region per file. Several envs owning regions in ONE file with mangled
 * markers is a hardening case (Task 5.1); here each broken region is repaired from
 * its own backup.
 */
async function repairMangledMarkers(
  paths: Paths,
  manifest: StateManifest,
  actions: string[],
): Promise<void> {
  for (const item of fileBlockItems(manifest)) {
    if (!(await isRegionBroken(paths, item))) continue;
    // Back to the pre-materialise state (markers gone), then rebuild the region.
    if (item.backupRef) await restore(paths, item.backupRef, item.path);
    await fbMaterialise(paths, {
      target: item.path,
      env: item.ownerEnv,
      mode: item.mode,
      sources: item.subBlocks.map((sb) => ({ source: sb.source, storePath: sb.storePath })),
    });
    actions.push(`restored mangled marker region in ${item.path} (env '${item.ownerEnv}')`);
  }
}

/**
 * Return every owned surface to a consistent state, then re-scan. Order matters:
 *
 * 1. `recoverState` first — roll back any pending journal so the manifest is
 *    consistent before any surface is re-driven (design D4).
 * 2. (later slices) re-materialise dangling links, reconcile drifted config,
 *    restore mangled marker regions, drop sourceless materialisations.
 * 3. garbage-collect orphaned backups LAST — repairs above legitimately create
 *    fresh transaction backups that de-reference on commit, so GC runs against the
 *    FINAL manifest to leave `backups/` clean and the next run idempotent.
 *
 * Every step reuses a journalled, lock-guarded mechanism, so a crash mid-repair is
 * itself recoverable and the whole operation is idempotent.
 */
export async function repair(paths: Paths): Promise<RepairResult> {
  const actions: string[] = [];

  // 1. Journal: roll forward/back a crashed transaction (lock-guarded).
  const recovery = await withLock(paths, () => recoverState(paths));
  if (recovery.recovered) {
    actions.push(
      `rolled back ${recovery.rolledBack} journalled mutation(s) from an interrupted transaction`,
    );
  }

  // 2. Re-drive broken owned surfaces from the manifest + store.
  await repairStoreDrift(paths, await readState(paths), actions);
  await repairDanglingSymlinks(paths, await readState(paths), actions);
  await repairMangledMarkers(paths, await readState(paths), actions);

  // 3. Orphaned backups: GC against the final manifest.
  const manifest = await readState(paths);
  for (const name of await orphanedBackups(paths, manifest)) {
    await removeBackupEntry(paths, name);
    actions.push(`removed orphaned backup '${name}'`);
  }

  const remaining = await diagnose(paths);
  return { actions, remaining };
}
