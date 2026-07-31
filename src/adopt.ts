import { copyFile, lstat, mkdir, readdir, readFile, readlink, rm, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { backup } from './backups.js';
import type { DirMergeItem } from './dir-merge.js';
import { scanTextForSecrets } from './git.js';
import { beginTransaction, recoverState } from './journal.js';
import { withLock } from './lock.js';
import type { Paths } from './paths.js';
import { findOwner, readState, writeState, type ManifestItem, type StateManifest } from './state.js';
import { environmentExists } from './store.js';

/**
 * Auto-adoption (design D10). When a harness creates a NEW skill/agent/command
 * inside an activated managed dir mid-session, the next invocation's sweep MOVES
 * it into the store, symlinks it back so it stays live, records ownership, and
 * (at the command layer) auto-commits + announces it — so a skill an agent made
 * on one machine syncs to the other without anyone remembering a command.
 *
 * The mechanism has two halves:
 * 1. {@link snapshotInventory} at activation records the baseline item names of
 *    every dir-merge surface, so the sweep can tell a NEW item from one that was
 *    already there (a user's static skill is never adopted).
 * 2. {@link adoptSweep} on each later invocation diffs current names against the
 *    baseline and adopts every NEW, UNOWNED item into the top active env — behind
 *    four guardrails, in order (D10):
 *      1. an item that is already a symlink into a NON-agentenv root belongs to
 *         another manager (the Vercel `skills` CLI, a hand-rolled setup) → NEVER
 *         touched; moving its target would corrupt that manager's registry;
 *      2. content matching secret patterns → PROMPT before adopting;
 *      3. an item in a PROJECT config directory → never auto-adopted (it is
 *         project-static, shared with the team; a manual `adopt --into` is the
 *         deliberate path);
 *      4. no active env for the surface → the item stays global (not adopted).
 *
 * Guardrails 4 (no active env) and 3 (project) make an item a NON-candidate, so
 * they are evaluated BEFORE the content guardrails — that also means a project or
 * env-less item never triggers a spurious secret prompt. Among the per-item
 * content guardrails the documented order holds: foreign-symlink (1) is checked
 * BEFORE the secret scan (2), so a foreign manager's item is never even read
 * through, let alone prompted about or moved.
 *
 * Adoption is TRANSACTIONAL (write-ahead journal, D4) and does no git — the
 * caller commits each adoption with its own `agentenv: adopt <kind> <name> → <env>`
 * message and announces it (never silent).
 */

/** A dir-merge surface the sweep watches: skills / agents / commands. */
export interface AdoptSurface {
  /** Absolute path to the surface directory (e.g. `~/.claude/skills`). */
  dir: string;
  /**
   * Where the surface lives, which decides adoption policy:
   * - `global`  — a real global config dir; a new item is adopted with its
   *               original real path recorded so `disown` can restore it.
   * - `session` — a private composed view dir (D15); a session-born item has no
   *               real incarnation, so `disown` prompts keep-ephemeral vs place-global.
   * - `project` — a repo's `.claude/…`; NEVER auto-adopted (guardrail 3).
   */
  scope: 'global' | 'session' | 'project';
  /** The store content subdir + announce noun source: skills | agents | commands. */
  storeKind: 'skills' | 'agents' | 'commands';
  /** The top active env new items are adopted into (D5). */
  ownerEnv: string;
  /** Session id, for `session`-scope attribution (D15). */
  session?: string;
  /**
   * `session` scope only: the REAL global dir a session-born item is placed into
   * on a `disown … place-global`. Absent → place-global is unavailable.
   */
  realDir?: string;
}

/** A snapshotted surface: an {@link AdoptSurface} plus its activation-time baseline. */
export interface SnapshotSurface extends AdoptSurface {
  /** Item names present at snapshot — the baseline that marks NEW items. */
  baseline: string[];
}

/** Adoption metadata attached to the dir-merge ownership record (D10). */
export interface AdoptionMeta {
  /** Marks this dir-merge item as an adoption (vs a normal materialised item). */
  adopted: true;
  /** `global` (had a real path) vs `session` (session-born, no real incarnation). */
  origin: 'global' | 'session';
  /** The path the item is restored to on `disown` (its original / view location). */
  originalPath: string;
  /** `session` origin only: the real global dir path for a `disown … place-global`. */
  realPath?: string;
}

/** A dir-merge ownership record produced by adoption. */
export type AdoptedDirMergeItem = DirMergeItem & AdoptionMeta;

/** One item the sweep adopted (or, in dry-run, would adopt). */
export interface AdoptedRecord {
  name: string;
  storeKind: 'skills' | 'agents' | 'commands';
  ownerEnv: string;
  origin: 'global' | 'session';
  /** Where the symlink lives after adoption (== the item's former real path). */
  surfacePath: string;
  /** `environments/<env>/<storeKind>/<name>` — the moved-in store content. */
  storePath: string;
}

/** Why the sweep left a new item alone. */
export type AdoptSkipReason = 'foreign-symlink' | 'secret-declined' | 'project' | 'no-env' | 'owned';

/** One item the sweep did not adopt, with the guardrail that stopped it. */
export interface AdoptSkip {
  name: string;
  surfacePath: string;
  reason: AdoptSkipReason;
}

/** Outcome of {@link adoptSweep}. */
export interface AdoptSweepResult {
  /** Adopted items (in dry-run: the items that WOULD be adopted). */
  adopted: AdoptedRecord[];
  /** New items left alone, with the reason. */
  skipped: AdoptSkip[];
  /** Whether this was a preview (nothing was moved/owned/committed). */
  dryRun: boolean;
}

export interface AdoptSweepRequest {
  paths: Paths;
  /** Surfaces to sweep; defaults to the manifest inventory ({@link readInventory}). */
  surfaces?: readonly SnapshotSurface[];
  /** Preview only — report would-adopt, change nothing (`capture --dry-run`). */
  dryRun?: boolean;
  /** Confirm adopting a secret-bearing item (guardrail 2). Absent → decline. */
  confirm?: (question: string) => Promise<boolean>;
  /** Called after each REAL adoption so the caller can auto-commit it (D9). */
  onAdopt?: (record: AdoptedRecord) => Promise<void>;
  /** Announcement / notice sink (never silent — D10). */
  note?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Inventory snapshot (stored as a tolerated top-level field in state.json,
// exactly like engine.ts's globalStack — machine-local, never synced)
// ---------------------------------------------------------------------------

/** The snapshotted dir-merge surfaces recorded in the manifest. */
export function readInventory(manifest: StateManifest): SnapshotSurface[] {
  const raw = (manifest as { inventory?: unknown }).inventory;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (s): s is SnapshotSurface =>
      s !== null && typeof s === 'object' && typeof (s as SnapshotSurface).dir === 'string',
  );
}

/**
 * Record the baseline inventory of each surface into the manifest (D10). Upserts
 * by `dir`, so re-activation refreshes a surface's baseline (already-adopted
 * items are owned and thus filtered regardless). Under the lock (RMW of state.json).
 */
export async function snapshotInventory(
  paths: Paths,
  surfaces: readonly AdoptSurface[],
): Promise<void> {
  if (surfaces.length === 0) return;
  await withLock(paths, async () => {
    const manifest = await readState(paths);
    const byDir = new Map(readInventory(manifest).map((s) => [s.dir, s]));
    for (const surface of surfaces) {
      byDir.set(surface.dir, { ...surface, baseline: await listNames(surface.dir) });
    }
    (manifest as { inventory?: SnapshotSurface[] }).inventory = [...byDir.values()];
    await writeState(paths, manifest);
  });
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

/**
 * Run the auto-adopt sweep (D10). Recovery-first (a crash journal is rolled back
 * before any transaction opens). For each surface, the NEW, UNOWNED items are
 * classified against the guardrails and adopted into the surface's top env. Does
 * NO git — `onAdopt` lets the caller commit each adoption under its own message.
 */
export async function adoptSweep(req: AdoptSweepRequest): Promise<AdoptSweepResult> {
  const { paths } = req;
  const dryRun = req.dryRun ?? false;
  const note = req.note ?? (() => {});
  const result: AdoptSweepResult = { adopted: [], skipped: [], dryRun };

  // Fast no-op when nothing was snapshotted (the common case for every command
  // that never activated a surface): no lock, no recovery, no state write — so
  // wiring this into the per-invocation lifecycle costs unactivated installs zero.
  const surfaces = req.surfaces ?? readInventory(await readState(paths));
  if (surfaces.length === 0) return result;

  if (!dryRun) await withLock(paths, () => recoverState(paths));

  for (const surface of surfaces) {
    const current = await listNames(surface.dir);
    const newNames = current.filter((n) => !surface.baseline.includes(n));
    if (newNames.length === 0) continue;

    // Guardrail 4 (no active env): the surface's target env is gone → nothing is
    // adopted; the items stay global. Evaluated per surface so no content is read.
    const envActive = surface.ownerEnv !== '' && (await environmentExists(paths, surface.ownerEnv));

    for (const name of newNames) {
      const surfacePath = join(surface.dir, name);

      // Already agentenv-owned (e.g. the env's own materialised item) → not new content.
      if (findOwner(await readState(paths), surfacePath)) {
        result.skipped.push({ name, surfacePath, reason: 'owned' });
        continue;
      }
      if (!envActive) {
        result.skipped.push({ name, surfacePath, reason: 'no-env' });
        continue;
      }
      // Guardrail 3 (project dir): never auto-adopt — project-static, team-shared.
      if (surface.scope === 'project') {
        result.skipped.push({ name, surfacePath, reason: 'project' });
        continue;
      }
      // Guardrail 1 (foreign-manager symlink): a symlink into a non-agentenv root
      // belongs to another manager → never touched (checked BEFORE reading content).
      if (await isForeignSymlink(surfacePath, paths.store)) {
        result.skipped.push({ name, surfacePath, reason: 'foreign-symlink' });
        note(
          `agentenv: leaving '${name}' alone — it is a symlink into another manager's root ` +
            `(${await readlink(surfacePath)}); adopting it would corrupt that manager.`,
        );
        continue;
      }
      // Guardrail 2 (secret patterns): prompt before adopting secret-bearing content.
      if (await pathHasSecret(surfacePath)) {
        const ok = req.confirm
          ? await req.confirm(
              `agentenv: '${name}' looks like it contains a secret. Adopt it into '${surface.ownerEnv}' anyway? [y/N] `,
            )
          : false;
        if (!ok) {
          result.skipped.push({ name, surfacePath, reason: 'secret-declined' });
          note(`agentenv: NOT adopting '${name}' — it matches a secret pattern (declined).`);
          continue;
        }
      }

      const record = describeAdoption(paths, surface, name);
      if (dryRun) {
        result.adopted.push(record);
        continue;
      }
      await adoptItem(paths, surface, name);
      result.adopted.push(record);
      note(`agentenv: adopted ${singular(surface.storeKind)} '${name}' → ${surface.ownerEnv}`);
      if (req.onAdopt) await req.onAdopt(record);
    }
  }

  return result;
}

/** The store path and record shape for adopting `name` from `surface`. */
function describeAdoption(paths: Paths, surface: AdoptSurface, name: string): AdoptedRecord {
  return {
    name,
    storeKind: surface.storeKind,
    ownerEnv: surface.ownerEnv,
    origin: surface.scope === 'session' ? 'session' : 'global',
    surfacePath: join(surface.dir, name),
    storePath: join(paths.envDir(surface.ownerEnv), surface.storeKind, name),
  };
}

/**
 * Adopt one new item: MOVE it into the store, SYMLINK it back into the surface
 * (so it stays live), and RECORD ownership — all under a write-ahead transaction
 * so a crash rolls back to the original real item (D4). Under the machine lock.
 */
export async function adoptItem(
  paths: Paths,
  surface: AdoptSurface,
  name: string,
): Promise<AdoptedDirMergeItem> {
  const record = describeAdoption(paths, surface, name);
  const { surfacePath, storePath } = record;

  return withLock(paths, async () => {
    await mkdir(dirname(storePath), { recursive: true });
    // Backup the ORIGINAL item so a crash mid-adoption restores it to the surface.
    const undoBackup = await backup(paths, surfacePath);

    const item: AdoptedDirMergeItem = {
      surface: 'dir-merge',
      action: 'symlink',
      path: surfacePath,
      target: storePath,
      ownerEnv: surface.ownerEnv,
      backupRef: { kind: 'absent' },
      adopted: true,
      origin: record.origin,
      originalPath: surfacePath,
      ...(record.origin === 'session' && surface.realDir
        ? { realPath: join(surface.realDir, name) }
        : {}),
    };

    const tx = await beginTransaction(paths);
    try {
      await tx.apply(
        { op: 'add', item, undo: { path: surfacePath, backupRef: undoBackup } },
        async () => {
          await copyTree(surfacePath, storePath);
          await rm(surfacePath, { recursive: true, force: true });
          await symlink(storePath, surfacePath);
        },
      );
      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }
    return item;
  });
}

/**
 * Reverse an adoption (`disown`). Removes the symlink, moves the store content to
 * `dest`, and drops ownership — transactionally. For a global-mode-adopted item
 * `dest` is its recorded original path (restoring it byte-identically, a
 * sanctioned real-path write carved out of the Never list, D10); for a session-born
 * item `dest` is either its view path (keep-ephemeral) or its real global dir
 * (place-global), decided by the caller's prompt.
 */
export async function disownItem(
  paths: Paths,
  item: AdoptedDirMergeItem,
  dest: string,
): Promise<void> {
  await withLock(paths, async () => {
    const tx = await beginTransaction(paths);
    try {
      // Snapshot the current symlink so a crash mid-disown restores ownership.
      const undoBackup = await backup(paths, item.path);
      await tx.apply(
        { op: 'remove', item, undo: { path: item.path, backupRef: undoBackup } },
        async () => {
          await rm(item.path, { recursive: true, force: true });
          await mkdir(dirname(dest), { recursive: true });
          await copyTree(item.target, dest);
          await rm(item.target, { recursive: true, force: true });
        },
      );
      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  });
}

/** Find a manifest-owned adopted dir-merge item by its item name (basename). */
export function findAdoptedByName(manifest: StateManifest, name: string): AdoptedDirMergeItem[] {
  return manifest.items.filter((i): i is AdoptedDirMergeItem => isAdopted(i) && baseName(i.path) === name);
}

/**
 * Record `name` into the baseline of every inventory surface at `dir`, so an item
 * a `disown` just restored to a real/view surface is treated as PRE-EXISTING and
 * is not immediately re-adopted by the next sweep. Under the lock (RMW). A no-op
 * when no snapshotted surface covers `dir`.
 */
export async function markBaseline(paths: Paths, dir: string, name: string): Promise<void> {
  await withLock(paths, async () => {
    const manifest = await readState(paths);
    const inventory = readInventory(manifest);
    let changed = false;
    for (const surface of inventory) {
      if (surface.dir === dir && !surface.baseline.includes(name)) {
        surface.baseline.push(name);
        changed = true;
      }
    }
    if (changed) {
      (manifest as { inventory?: SnapshotSurface[] }).inventory = inventory;
      await writeState(paths, manifest);
    }
  });
}

/**
 * A new, UNOWNED item named `name` found in a snapshotted surface, for a MANUAL
 * `adopt <name> --into <env>` (design D10). Searches the inventory so the manual
 * path reuses the same surface metadata (scope, realDir) the sweep would. Returns
 * every match (0 = not found / already owned, >1 = ambiguous across surfaces).
 */
export async function findAdoptableItem(
  paths: Paths,
  name: string,
): Promise<{ surface: SnapshotSurface; surfacePath: string }[]> {
  const manifest = await readState(paths);
  const matches: { surface: SnapshotSurface; surfacePath: string }[] = [];
  for (const surface of readInventory(manifest)) {
    const surfacePath = join(surface.dir, name);
    const names = await listNames(surface.dir);
    if (!names.includes(name)) continue;
    if (findOwner(manifest, surfacePath)) continue; // already owned
    matches.push({ surface, surfacePath });
  }
  return matches;
}

/** Whether an item at `surfacePath` is a foreign-manager symlink (guardrail 1). */
export function isForeignManagerSymlink(surfacePath: string, storeRoot: string): Promise<boolean> {
  return isForeignSymlink(surfacePath, storeRoot);
}

/** Whether the item at `surfacePath` matches a secret pattern (guardrail 2). */
export function itemHasSecret(surfacePath: string): Promise<boolean> {
  return pathHasSecret(surfacePath);
}

/** Whether a manifest record is an adoption. */
export function isAdopted(item: ManifestItem): item is AdoptedDirMergeItem {
  return item.surface === 'dir-merge' && (item as { adopted?: unknown }).adopted === true;
}

// ---------------------------------------------------------------------------
// Guardrail detection
// ---------------------------------------------------------------------------

/**
 * Guardrail 1: whether `itemPath` is a symlink whose target is OUTSIDE the store
 * — the signature of another manager (the `skills` CLI links into `~/.agents/`).
 * A symlink INTO the store is ours; a non-symlink is not foreign.
 */
async function isForeignSymlink(itemPath: string, storeRoot: string): Promise<boolean> {
  const st = await lstat(itemPath);
  if (!st.isSymbolicLink()) return false;
  const target = await readlink(itemPath);
  const abs = isAbsolute(target) ? target : resolve(dirname(itemPath), target);
  const store = resolve(storeRoot);
  return !(abs === store || abs.startsWith(store + sep));
}

/**
 * Guardrail 2: whether the item (a file or a whole skill/agent folder) contains
 * anything matching a secret pattern (reusing the D6/D9 scan). Conservative — the
 * same rules that gate store commits.
 */
async function pathHasSecret(itemPath: string): Promise<boolean> {
  const st = await lstat(itemPath);
  if (st.isSymbolicLink()) return false; // handled by guardrail 1; never followed
  if (st.isDirectory()) {
    for (const entry of await readdir(itemPath, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (await pathHasSecret(join(itemPath, entry.name))) return true;
    }
    return false;
  }
  if (!st.isFile() || !isProbablyText(itemPath)) return false;
  let text: string;
  try {
    text = await readFile(itemPath, 'utf8');
  } catch {
    return false;
  }
  return scanTextForSecrets(text).length > 0;
}

// ---------------------------------------------------------------------------
// Small fs helpers
// ---------------------------------------------------------------------------

/** Sorted entry names of `dir`; an absent dir yields `[]`. */
async function listNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** Recursively copy a file / directory / symlink from `src` to `dest`. */
async function copyTree(src: string, dest: string): Promise<void> {
  const st = await lstat(src);
  if (st.isSymbolicLink()) {
    await symlink(await readlink(src), dest);
    return;
  }
  if (st.isDirectory()) {
    await mkdir(dest, { recursive: true });
    for (const entry of await readdir(src, { withFileTypes: true })) {
      await copyTree(join(src, entry.name), join(dest, entry.name));
    }
    return;
  }
  await copyFile(src, dest);
}

/** Whether a filename looks like text worth secret-scanning (skip obvious binaries). */
function isProbablyText(name: string): boolean {
  return !/\.(?:png|jpg|jpeg|gif|webp|ico|pdf|zip|gz|tar|woff2?|ttf|otf|mp4|mp3|wasm|node)$/i.test(name);
}

/** The last path segment (item name) of a surface path. */
function baseName(p: string): string {
  const parts = p.split(sep);
  return parts[parts.length - 1] ?? p;
}

/** Singular announce noun for a store kind: skills → skill, agents → agent. */
export function singular(storeKind: 'skills' | 'agents' | 'commands'): string {
  return storeKind.replace(/s$/, '');
}
