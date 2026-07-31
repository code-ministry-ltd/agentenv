import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import type { BackupRef } from './backups.js';
import { backup } from './backups.js';
import { writeFileAtomic } from './fs-atomic.js';
import { beginTransaction } from './journal.js';
import { withLock } from './lock.js';
import type { Paths } from './paths.js';
import type { ManifestItem, StateManifest } from './state.js';
import { readState } from './state.js';

/**
 * The file-block surface (design D2): agentenv owns a **marked region** in a
 * user instruction file (CLAUDE.md / AGENTS.md). Content OUTSIDE the markers is
 * never read as ours and never touched — the round-trip guarantee (spec success
 * criterion) is that the bytes outside our markers survive materialise and
 * dematerialise unchanged.
 *
 * Each contributed store file renders as its **own sub-block with its own
 * markers**, so drift is attributable to exactly one store file: a `codex.md`
 * edit flows back to `codex.md`, never to the `base.md` every harness shares.
 * The marker label is therefore `<env>/<source>` — the design's `agentenv:<env>`
 * extended with the store-file basename so two sub-blocks in one file are
 * distinguishable (a minimal, necessary extension of the D2 illustration, which
 * only ever shows a single contributed file).
 *
 * Two modes, a per-harness property (D2):
 * - **import** — the harness has include syntax (Claude `@path`): the sub-block
 *   holds one import line pointing at the store file. The real content lives in
 *   the store, so the block never drifts and {@link syncBack} is a no-op.
 * - **inline** — no include syntax (Codex/Pi AGENTS.md): the sub-block holds the
 *   store file's content verbatim plus a recorded source hash. {@link syncBack}
 *   diffs each sub-block against its store file, writes drift back to the correct
 *   store file, then refreshes the block from the store.
 */

/** Import mode holds an include line; inline mode holds content + a source hash. */
export type FileBlockMode = 'import' | 'inline';

/** A store instruction file contributed to a target as one sub-block. */
export interface FileBlockSource {
  /**
   * The store file's basename identifier (e.g. `base.md`, `codex.md`). It forms
   * the second half of the marker label and, for inline mode, tells
   * {@link syncBack} which store file a drifted sub-block must be written back to.
   */
  source: string;
  /** Absolute path to the store instruction file this sub-block renders. */
  storePath: string;
}

/** A materialised sub-block, recorded in the manifest — one per source file. */
export interface FileSubBlock {
  /** The store file's basename identifier; the marker-label discriminator. */
  source: string;
  /** Absolute path to the store instruction file (drift write-back target). */
  storePath: string;
  /**
   * sha256 of the inlined body last synced, for drift detection (inline mode).
   * Absent for import mode, where the block holds an include line, not content.
   */
  hash?: string;
}

/**
 * The file-block ownership record. Keyed by `<env>` (the intra-file
 * discriminator — {@link ManifestItemBase.key}) so several environments can own
 * distinct regions of the same instruction file without identity collision, and
 * so deactivation removes exactly one env's region.
 */
declare module './state.js' {
  interface ManifestItemVariants {
    'file-block': import('./state.js').ManifestItemBase & {
      surface: 'file-block';
      action: 'file-block';
      /** The target user instruction file (CLAUDE.md / AGENTS.md). */
      path: string;
      /** The owning env — also the intra-file discriminator (`key`). */
      key: string;
      ownerEnv: string;
      /** import: include line, no drift. inline: content + per-source hash. */
      mode: FileBlockMode;
      /** One entry per contributed store file, in render order. */
      subBlocks: FileSubBlock[];
      /**
       * The target's state BEFORE agentenv first materialised into it, preserved
       * across re-materialise so dematerialise knows whether to delete a file it
       * created (`absent`) or restore user content. Distinct from a journal
       * undo, which captures the immediately-preceding state.
       */
      backupRef?: BackupRef | null;
    };
  }
}

/** Convenience alias for the registered file-block variant. */
export type FileBlockItem = import('./state.js').ManifestItemVariants['file-block'];

/** Inputs to {@link dematerialise} and {@link syncBack}. */
export interface FileBlockTargetOptions {
  /** Absolute path to the target user instruction file. */
  target: string;
  /** The owning environment whose region is operated on. */
  env: string;
}

/** Inputs to {@link materialise}. */
export interface MaterialiseOptions {
  /** Absolute path to the target user instruction file. */
  target: string;
  /** The owning environment (marker label + ownership). */
  env: string;
  /** Whether sub-blocks hold include lines (import) or content (inline). */
  mode: FileBlockMode;
  /** Contributed store files, rendered as sub-blocks in this order. */
  sources: FileBlockSource[];
}

// ---------------------------------------------------------------------------
// Markers and region rendering
// ---------------------------------------------------------------------------

/** The marker label for a sub-block: `<env>/<source>`. */
function label(env: string, source: string): string {
  return `${env}/${source}`;
}

/** The opening marker line for a sub-block (exact D2 text, em-dash included). */
export function openMarker(env: string, source: string): string {
  return `<!-- >>> agentenv:${label(env, source)} >>> managed — do not edit between markers -->`;
}

/** The closing marker line for a sub-block. */
export function closeMarker(env: string, source: string): string {
  return `<!-- <<< agentenv:${label(env, source)} <<< -->`;
}

/** Render one sub-block: open marker, body, close marker (body may be empty). */
function renderSubBlock(env: string, source: string, body: string): string {
  return `${openMarker(env, source)}\n${body}\n${closeMarker(env, source)}`;
}

/**
 * Render an env's whole managed region: its sub-blocks separated by a blank
 * line. `bodies` maps a source id to its rendered body (an include line for
 * import mode, inlined content for inline mode).
 */
function renderRegion(env: string, subBlocks: FileSubBlock[], bodies: Map<string, string>): string {
  return subBlocks
    .map((sb) => renderSubBlock(env, sb.source, bodies.get(sb.source) ?? ''))
    .join('\n\n');
}

/**
 * A sub-block located in file text: its byte span and its extracted body.
 * `label` is `<env>/<source>`.
 */
interface FoundBlock {
  label: string;
  env: string;
  source: string;
  body: string;
  start: number;
  end: number;
}

/**
 * Find every agentenv sub-block in `content`. The close marker is bound to the
 * same label as its open marker (a backreference), so an unrelated label cannot
 * terminate a block early. Bodies are captured exactly, including any trailing
 * newline, so an inline sub-block round-trips its store file byte-for-byte.
 */
function findBlocks(content: string): FoundBlock[] {
  const re =
    /<!-- >>> agentenv:([^\s>]+) >>> managed[^\n]*-->\n([\s\S]*?)\n<!-- <<< agentenv:\1 <<< -->/g;
  const found: FoundBlock[] = [];
  for (let m = re.exec(content); m !== null; m = re.exec(content)) {
    const lbl = m[1] ?? '';
    const slash = lbl.indexOf('/');
    found.push({
      label: lbl,
      env: slash >= 0 ? lbl.slice(0, slash) : lbl,
      source: slash >= 0 ? lbl.slice(slash + 1) : '',
      body: m[2] ?? '',
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return found;
}

/** Map each of `env`'s sub-blocks (by source id) to its current in-file body. */
function extractBodies(content: string, env: string): Map<string, string> {
  const bodies = new Map<string, string>();
  for (const b of findBlocks(content)) {
    if (b.env === env) bodies.set(b.source, b.body);
  }
  return bodies;
}

/** The contiguous [start, end) span of `env`'s sub-blocks, or null if none. */
function regionSpan(content: string, env: string): { start: number; end: number } | null {
  const mine = findBlocks(content).filter((b) => b.env === env);
  if (mine.length === 0) return null;
  const first = mine[0];
  const last = mine[mine.length - 1];
  if (!first || !last) return null;
  return { start: first.start, end: last.end };
}

/**
 * Strip `env`'s managed region from `content`, returning the surrounding user
 * content byte-for-byte. The exact inverse of {@link appendRegion}: the region
 * is always joined with exactly one leading `\n` separator and exactly one
 * trailing `\n`, so one of each is removed here and nothing else. Removing a
 * *fixed* one leading newline (never a heuristic count) is what lets a user
 * safely prepend their own content — e.g. `MY NOTES\n` above the region — and
 * keep it: their newline survives because only agentenv's single separator is
 * reclaimed.
 */
export function stripRegion(content: string, env: string): { user: string; region: string | null } {
  const span = regionSpan(content, env);
  if (!span) return { user: content, region: null };

  const before = content.slice(0, span.start);
  const region = content.slice(span.start, span.end);
  const after = content.slice(span.end);

  // Reverse appendRegion: content = user + "\n" + region + "\n". Remove the one
  // separator "\n" from the tail of `before` and the one trailing "\n" from
  // `after`; everything else is the user's, byte-for-byte.
  const userHead = before.endsWith('\n') ? before.slice(0, -1) : before;
  const userTail = after.startsWith('\n') ? after.slice(1) : after;
  return { user: userHead + userTail, region };
}

/**
 * Append a rendered region to user content, byte-reversibly by
 * {@link stripRegion}: exactly one `\n` always separates the (possibly empty)
 * user content from the region — giving a blank line whenever the content
 * already ends in a newline — and exactly one `\n` terminates the file. The
 * separator is inserted unconditionally (even for empty content) so its removal
 * is unambiguous regardless of any user edits made around the region later.
 */
export function appendRegion(user: string, region: string): string {
  return `${user}\n${region}\n`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashBody(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

async function readFileOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

/** The file-block record owning `target` for `env`, or undefined. */
function findRecord(
  manifest: StateManifest,
  target: string,
  env: string,
): FileBlockItem | undefined {
  return manifest.items.find(
    (i): i is FileBlockItem =>
      i.surface === 'file-block' && i.path === target && i.ownerEnv === env,
  );
}

/** The rendered body for a source: an include line (import) or content (inline). */
async function renderBody(mode: FileBlockMode, src: FileBlockSource): Promise<string> {
  if (mode === 'import') return `@${src.storePath}`;
  return readFileOrEmpty(src.storePath);
}

// ---------------------------------------------------------------------------
// materialise
// ---------------------------------------------------------------------------

/**
 * Materialise an env's managed region into a target instruction file. The file
 * is backed up before its first mutation; ownership (with per-sub-block hashes)
 * is recorded through the write-ahead journal so a crash rolls back cleanly.
 *
 * Idempotent: re-materialising the same sources produces byte-identical output
 * and never duplicates the block — the region is stripped and re-appended, so
 * an existing region is replaced in place rather than a second one added. User
 * content outside the markers is preserved byte-for-byte.
 *
 * Runs under {@link withLock} (design D11) around the read-modify-write of
 * state.json.
 */
export async function materialise(paths: Paths, opts: MaterialiseOptions): Promise<FileBlockItem> {
  const { target, env, mode, sources } = opts;
  return withLock(paths, async () => {
    const before = await readFileOrEmpty(target);

    // Render each sub-block's body and record its drift hash (inline only).
    const bodies = new Map<string, string>();
    const subBlocks: FileSubBlock[] = [];
    for (const src of sources) {
      const body = await renderBody(mode, src);
      bodies.set(src.source, body);
      subBlocks.push({
        source: src.source,
        storePath: src.storePath,
        ...(mode === 'inline' ? { hash: hashBody(body) } : {}),
      });
    }

    const region = renderRegion(env, subBlocks, bodies);
    const after = appendRegion(stripRegion(before, env).user, region);

    // Preserve the ORIGINAL pre-materialise state across re-materialise so
    // dematerialise can tell a file we created (delete on drop) from a file we
    // added a block to (restore user content). The journal undo, by contrast,
    // captures the immediately-preceding bytes to undo *this* write on a crash.
    const existing = findRecord(await readState(paths), target, env);
    const currentBackup = await backup(paths, target);
    const originalBackup = existing?.backupRef ?? currentBackup;

    const item: FileBlockItem = {
      surface: 'file-block',
      action: 'file-block',
      path: target,
      key: env,
      ownerEnv: env,
      mode,
      subBlocks,
      backupRef: originalBackup,
    };

    const tx = await beginTransaction(paths);
    try {
      await tx.apply(
        { op: 'add', item: item as ManifestItem, undo: { path: target, backupRef: currentBackup } },
        async () => {
          await writeFileAtomic(target, after);
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

// ---------------------------------------------------------------------------
// dematerialise
// ---------------------------------------------------------------------------

/**
 * Remove an env's managed region from a target instruction file. Only
 * agentenv's markers and their content are removed; the surrounding user
 * content is restored byte-for-byte (spec round-trip guarantee). If agentenv
 * created the file (its preserved backup is `absent`) and nothing else remains,
 * the file is deleted rather than left empty; a pre-existing empty file is
 * restored to empty, not deleted.
 *
 * Idempotent — a second drop with no region and no ownership record is a safe
 * no-op. Transactional and under {@link withLock}, like {@link materialise}:
 * the current file is backed up so a crash mid-drop rolls back.
 */
export async function dematerialise(paths: Paths, opts: FileBlockTargetOptions): Promise<void> {
  const { target, env } = opts;
  return withLock(paths, async () => {
    const manifest = await readState(paths);
    const record = findRecord(manifest, target, env);
    const before = await readFileOrEmpty(target);
    const span = regionSpan(before, env);
    // Nothing owned here and no region to strip: a safe no-op (idempotent drop).
    if (!record && !span) return;

    const after = stripRegion(before, env).user;
    // Delete only a file agentenv itself created that is now empty; never a file
    // that pre-existed (even empty) or that still holds user content.
    const deleteFile = after === '' && record?.backupRef?.kind === 'absent';

    const currentBackup = await backup(paths, target);
    const removalItem: ManifestItem =
      record ??
      ({
        surface: 'file-block',
        action: 'file-block',
        path: target,
        key: env,
        ownerEnv: env,
        mode: 'inline',
        subBlocks: [],
      } as FileBlockItem);

    const tx = await beginTransaction(paths);
    try {
      await tx.apply(
        { op: 'remove', item: removalItem, undo: { path: target, backupRef: currentBackup } },
        async () => {
          if (deleteFile) {
            await rm(target, { force: true });
          } else {
            await writeFileAtomic(target, after);
          }
        },
      );
      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  });
}

// ---------------------------------------------------------------------------
// syncBack (inline drift)
// ---------------------------------------------------------------------------

/** What {@link syncBack} reconciled, by store-file source id. */
export interface SyncBackResult {
  /** Sources whose in-file edit was written back to their store file (drift). */
  drifted: string[];
  /** Sources whose block was refreshed from a store file changed elsewhere. */
  refreshed: string[];
}

/**
 * Reconcile an env's inline sub-blocks with their store files (design D2's drift
 * pass). For each sub-block:
 *
 * - **drift** — the block was edited in-session (its body no longer hashes to
 *   the recorded value): the edit is written back to **that sub-block's own**
 *   store file (a `codex.md` sub-block edit lands in `codex.md`, never in the
 *   shared `base.md`); block edits win over concurrent store edits (D11
 *   last-write-wins).
 * - **refresh** — the block is unchanged but its store file changed elsewhere
 *   (another machine): the block is re-inlined from the store; nothing is
 *   written back.
 *
 * Either way the recorded hash is updated to the reconciled content. Import mode
 * has no drift (the block holds an include line, content lives in the store), so
 * this is a no-op there. Transactional and under {@link withLock}: the target
 * and each written store file are backed up first.
 */
export async function syncBack(paths: Paths, opts: FileBlockTargetOptions): Promise<SyncBackResult> {
  const { target, env } = opts;
  return withLock(paths, async () => {
    const result: SyncBackResult = { drifted: [], refreshed: [] };
    const manifest = await readState(paths);
    const record = findRecord(manifest, target, env);
    // Import mode (or nothing owned) never drifts — the content lives in the store.
    if (!record || record.mode === 'import') return result;

    const before = await readFileOrEmpty(target);
    const inFile = extractBodies(before, env);

    const newBodies = new Map<string, string>();
    const updatedSubBlocks: FileSubBlock[] = [];
    const storeWrites: { storePath: string; body: string }[] = [];

    for (const sb of record.subBlocks) {
      const storeBody = await readFileOrEmpty(sb.storePath);
      // A block missing from the file (markers mangled) self-heals from the store.
      const fileBody = inFile.get(sb.source) ?? storeBody;
      const recorded = sb.hash;

      let newBody: string;
      if (hashBody(fileBody) !== recorded) {
        // In-session edit → write drift back to THIS source's store file.
        newBody = fileBody;
        storeWrites.push({ storePath: sb.storePath, body: newBody });
        result.drifted.push(sb.source);
      } else if (hashBody(storeBody) !== recorded) {
        // Store changed elsewhere, block untouched → refresh block from store.
        newBody = storeBody;
        result.refreshed.push(sb.source);
      } else {
        newBody = fileBody; // identical everywhere — no change
      }
      newBodies.set(sb.source, newBody);
      updatedSubBlocks.push({ ...sb, hash: hashBody(newBody) });
    }

    const region = renderRegion(env, updatedSubBlocks, newBodies);
    const after = appendRegion(stripRegion(before, env).user, region);
    const hashesChanged = updatedSubBlocks.some((sb, i) => sb.hash !== record.subBlocks[i]?.hash);

    // Truly nothing to do: no drift, no refresh, no hash change, file unchanged.
    if (storeWrites.length === 0 && after === before && !hashesChanged) return result;

    const updatedItem: FileBlockItem = { ...record, subBlocks: updatedSubBlocks };
    const currentBackup = await backup(paths, target);
    for (const w of storeWrites) await backup(paths, w.storePath);

    const tx = await beginTransaction(paths);
    try {
      await tx.apply(
        {
          op: 'add',
          item: updatedItem as ManifestItem,
          undo: { path: target, backupRef: currentBackup },
        },
        async () => {
          for (const w of storeWrites) await writeFileAtomic(w.storePath, w.body);
          if (after !== before) await writeFileAtomic(target, after);
        },
      );
      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }
    return result;
  });
}
