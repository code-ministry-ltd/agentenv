import { access, readdir, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { BackupRef } from './backups.js';
import { restore } from './backups.js';
import {
  inspectOwnedKey,
  syncBack as cfgSyncBack,
  type ConfigKeysItem,
} from './config-keys.js';
import {
  dematerialise as dmDematerialise,
  materialise as dmMaterialise,
  type DirMergeItem,
} from './dir-merge.js';
import {
  dematerialise as fbDematerialise,
  inspectOwnedRegion,
  materialise as fbMaterialise,
  type FileBlockItem,
} from './file-block.js';
import { beginTransaction, recoverState } from './journal.js';
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

/**
 * Whether EVERY store file a file-block record renders is gone — the env's store
 * contribution to this region has vanished (the store was deleted under a live
 * activation, Task 5.1). Deliberately all-or-nothing: repair drops the whole
 * region, so a PARTIAL loss (one of several sources) must not qualify, or a
 * still-good sub-block would be thrown away with the missing one.
 */
async function isRegionSourceGone(item: FileBlockItem): Promise<boolean> {
  if (item.subBlocks.length === 0) return false;
  for (const sb of item.subBlocks) {
    if (await exists(sb.storePath)) return false;
  }
  return true;
}

/** Manifest items whose store source is gone — dir-merge or file-block (design D4). */
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
  for (const item of fileBlockItems(manifest)) {
    if (!(await isRegionSourceGone(item))) continue;
    out.push({
      kind: 'store-drift',
      where: `${item.path} (env '${item.ownerEnv}')`,
      what:
        `the region env '${item.ownerEnv}' owns in ${item.path} has no store source — ` +
        `every store file it renders is gone`,
      repair: "remove the managed region and drop its ownership record (the user's content stays)",
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

/** Manifest-owned file-block regions whose markers a harness broke (design D4). */
async function detectMangledMarkers(
  paths: Paths,
  manifest: StateManifest,
): Promise<DoctorProblem[]> {
  const out: DoctorProblem[] = [];
  for (const item of fileBlockItems(manifest)) {
    const insp = await inspectOwnedRegion(paths, { target: item.path, env: item.ownerEnv });
    if (insp.status !== 'conflict' && insp.status !== 'absent') continue;
    const conflict = insp.status === 'conflict';
    const why = conflict
      ? `its markers were mangled (${insp.detail ?? 'no longer well-formed'})`
      : 'its managed marker region is missing';
    out.push({
      kind: 'mangled-markers',
      where: `${item.path} (env '${item.ownerEnv}')`,
      what: `the region env '${item.ownerEnv}' owns in ${item.path} is broken — ${why}`,
      // The two statuses need different — and differently destructive — fixes, so
      // say which one this problem will get rather than promising a rollback the
      // absent case does not (and must not) perform.
      repair: conflict
        ? 'restore the file to its pre-materialise backup and re-materialise a clean region'
        : 're-insert the managed region from the manifest + store, leaving the rest of the file as it is',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// config-keys: an owned key whose file a harness reserialised (hash mismatch)
// ---------------------------------------------------------------------------

/** The config-keys records in the manifest. */
function configKeysItems(manifest: StateManifest): ConfigKeysItem[] {
  return manifest.items.filter((i): i is ConfigKeysItem => i.surface === 'config-keys');
}

/** Owned config keys whose value drifted — a harness reserialised the file (D4). */
async function detectReserialisedConfig(manifest: StateManifest): Promise<DoctorProblem[]> {
  const out: DoctorProblem[] = [];
  for (const item of configKeysItems(manifest)) {
    let status;
    try {
      status = await inspectOwnedKey(item);
    } catch (err) {
      out.push({
        kind: 'reserialised-config',
        where: `${item.path} (${item.key ?? ''})`,
        what: `could not parse ${item.path} to check owned key '${item.key ?? ''}': ${(err as Error).message}`,
        // The one problem in this file that `--repair` deliberately cannot act on:
        // reconciliation is BY PARSE, so a file that does not parse can only be
        // fixed by a human (or by restoring a backup). Say so plainly rather than
        // promising a repair that will never come.
        repair:
          'NOT repairable automatically — agentenv will not guess at a config it cannot parse. ' +
          "Fix the file by hand (or 'agentenv doctor --restore <backup>'), then re-run 'agentenv doctor --repair'",
      });
      continue;
    }
    if (status !== 'drifted') continue;
    out.push({
      kind: 'reserialised-config',
      where: `${item.path} (${item.key ?? ''})`,
      what: `owned config key '${item.key ?? ''}' in ${item.path} drifted — the file was reserialised/rewritten`,
      repair: 'reconcile the record to the parsed value (restoring secret placeholders)',
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
  problems.push(...(await detectReserialisedConfig(manifest)));
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
 * Rebuild a broken file-block region, by HOW it is broken (Task 5.1):
 *
 * - **conflict** — markers claim this env but do not match the record (duplicated,
 *   relabelled, non-contiguous, CRLF-rewritten, wrapped in merge fences). The
 *   mechanisms fail CLOSED on these (they refuse to reclaim a guessed span), so the
 *   only way to remove the mangled text is to go back to the item's preserved
 *   pre-materialise backup — removing the markers as bytes, not by trusting them —
 *   and re-materialise from the manifest's recorded sub-blocks + store. This DOES
 *   discard edits made to the file since activation; it is the fail-closed price of
 *   not guessing a span, and the reported `repair` line says so.
 * - **absent** — the region is simply gone (a harness rewrote the file without it).
 *   Nothing mangled remains to remove, and `materialise` re-inserts into the file
 *   exactly as it stands, so rolling the file back would destroy the user's later
 *   edits for no reason at all. Re-materialise ONLY.
 *
 * Either way the re-materialise is journalled and lock-guarded.
 *
 * Several envs owning regions in ONE file are handled by re-inspecting each record
 * against the file as it stands at its turn: a conflict repair that rolls the file
 * back also removes a sibling env's region, which then reads as `absent` and is
 * re-materialised in the same pass — so the pass converges with every env's region
 * present (pinned by doctor.hardening's shared-file test).
 */
async function repairMangledMarkers(
  paths: Paths,
  manifest: StateManifest,
  actions: string[],
): Promise<void> {
  for (const item of fileBlockItems(manifest)) {
    const insp = await inspectOwnedRegion(paths, { target: item.path, env: item.ownerEnv });
    if (insp.status !== 'conflict' && insp.status !== 'absent') continue;
    if (insp.status === 'conflict' && item.backupRef) {
      await restore(paths, item.backupRef, item.path);
    }
    await fbMaterialise(paths, {
      target: item.path,
      env: item.ownerEnv,
      mode: item.mode,
      sources: item.subBlocks.map((sb) => ({ source: sb.source, storePath: sb.storePath })),
    });
    actions.push(
      insp.status === 'conflict'
        ? `restored mangled marker region in ${item.path} (env '${item.ownerEnv}')`
        : `re-inserted the missing marker region in ${item.path} (env '${item.ownerEnv}')`,
    );
  }
}

/**
 * Drop every managed region whose whole store contribution is gone: strip the
 * region and its ownership record via the manifest-driven, journalled
 * `file-block.dematerialise`, which restores the surrounding user content
 * byte-for-byte (and deletes a file agentenv itself created).
 *
 * Runs AFTER {@link repairMangledMarkers} on purpose. `dematerialise` fails closed
 * on a `conflict` region — it will not reclaim a guessed span — so a region that is
 * BOTH sourceless and mangled must be made well-formed first; otherwise the throw
 * would escape `repair()` as a stack trace. A region still in conflict at this
 * point is skipped rather than forced, and `diagnose` reports it again with the
 * mangled-marker guidance.
 */
async function repairRegionStoreDrift(
  paths: Paths,
  manifest: StateManifest,
  actions: string[],
): Promise<void> {
  for (const item of fileBlockItems(manifest)) {
    if (!(await isRegionSourceGone(item))) continue;
    const insp = await inspectOwnedRegion(paths, { target: item.path, env: item.ownerEnv });
    if (insp.status === 'conflict') continue;
    await fbDematerialise(paths, { target: item.path, env: item.ownerEnv });
    actions.push(
      `dropped orphaned managed region in ${item.path} (env '${item.ownerEnv}', store source gone)`,
    );
  }
}

/**
 * Reconcile every drifted config key with the file a harness reserialised, under
 * ONE lock + transaction (the config-keys contract). `config-keys.syncBack` re-hashes
 * the owned value and, on drift, writes it back with secret-flagged fields restored
 * to their `${VAR}` placeholders (never the literal, D6) and the record's hash
 * brought into agreement — so the file, the record, and the store all match again.
 *
 * A key whose FILE cannot be read or parsed is SKIPPED, not thrown on (Task 5.1).
 * Reconciliation is by parse, so such a file is genuinely unrepairable here — but
 * `doctor --repair` is the one command whose whole job is broken states, and
 * letting the parse error escape killed the entire run with a stack trace, taking
 * every OTHER surface's fix down with it. Nothing has been mutated when `syncBack`
 * throws (it parses before it journals), so skipping is safe; the closing re-scan
 * re-reports the key with guidance naming it as needing a human.
 */
async function repairReserialisedConfig(
  paths: Paths,
  manifest: StateManifest,
  actions: string[],
): Promise<void> {
  const items = configKeysItems(manifest);
  if (items.length === 0) return;
  await withLock(paths, async () => {
    const tx = await beginTransaction(paths);
    try {
      for (const item of items) {
        let sync;
        try {
          sync = await cfgSyncBack(paths, tx, item);
        } catch {
          continue;
        }
        if (sync.drifted) {
          actions.push(`reconciled reserialised config key '${item.key ?? ''}' in ${item.path}`);
        }
      }
      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  });
}

/**
 * Return every owned surface to a consistent state, then re-scan. Order matters:
 *
 * 1. `recoverState` first — roll back any pending journal so the manifest is
 *    consistent before any surface is re-driven (design D4).
 * 2. re-drive broken owned surfaces: drop sourceless materialisations, re-link
 *    dangling symlinks, restore mangled marker regions, drop sourceless regions
 *    (only once their markers are well-formed again), reconcile drifted config.
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
  await repairRegionStoreDrift(paths, await readState(paths), actions);
  await repairReserialisedConfig(paths, await readState(paths), actions);

  // 3. Orphaned backups: GC against the final manifest.
  const manifest = await readState(paths);
  for (const name of await orphanedBackups(paths, manifest)) {
    await removeBackupEntry(paths, name);
    actions.push(`removed orphaned backup '${name}'`);
  }

  const remaining = await diagnose(paths);
  return { actions, remaining };
}

// ---------------------------------------------------------------------------
// --restore <backup>
// ---------------------------------------------------------------------------

/** Outcome of {@link restoreBackup}. */
export interface RestoreResult {
  restored: boolean;
  /** The manifest-recorded path the backup was restored to (on success). */
  path?: string;
  /** Why the restore did not happen (on failure). */
  error?: string;
}

/** Find the manifest ref + recorded path a backup id belongs to (item, then journal). */
function findBackupTarget(
  manifest: StateManifest,
  backupId: string,
): { ref: BackupRef; path: string } | null {
  for (const item of manifest.items) {
    const ref = (item as { backupRef?: BackupRef | null }).backupRef;
    if (ref && backupEntryName(ref) === backupId) return { ref, path: item.path };
  }
  for (const entry of manifest.journal ?? []) {
    const ref = entry.undo?.backupRef;
    if (ref && backupEntryName(ref) === backupId) return { ref, path: entry.undo.path };
  }
  return null;
}

/**
 * Restore one content-addressed backup to its manifest-recorded path (design D4).
 * The backup id is a `backups/` entry name — a content sha256 or a `dir-…` id. The
 * path is not passed in: it is read from whichever manifest item (or pending
 * journal undo) references the backup, so a backup is always returned to exactly
 * where it was captured. Runs under the lock and reuses {@link restore}.
 */
export async function restoreBackup(paths: Paths, backupId: string): Promise<RestoreResult> {
  const id = backupId.trim();
  if (id === '') return { restored: false, error: 'a backup id is required' };
  const manifest = await readState(paths);
  const match = findBackupTarget(manifest, id);
  if (!match) {
    return { restored: false, error: `no manifest item references backup '${id}'` };
  }
  if (!(await exists(join(paths.backups, id)))) {
    return { restored: false, error: `backup '${id}' is not present under ${paths.backups}` };
  }
  await withLock(paths, () => restore(paths, match.ref, match.path));
  return { restored: true, path: match.path };
}
