import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { BackupRef } from './backups.js';
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

  // 3. Orphaned backups: GC against the final manifest.
  const manifest = await readState(paths);
  for (const name of await orphanedBackups(paths, manifest)) {
    await removeBackupEntry(paths, name);
    actions.push(`removed orphaned backup '${name}'`);
  }

  const remaining = await diagnose(paths);
  return { actions, remaining };
}
