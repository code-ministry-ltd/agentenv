import { createHash, randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { BackupRef } from './backups.js';
import { backup } from './backups.js';
import { writeFileAtomic } from './fs-atomic.js';
import { beginTransaction } from './journal.js';
import { withLock } from './lock.js';
import {
  capturePathIdentity,
  identitiesEqual,
  type PathIdentity,
} from './path-identity.js';
import type { Paths } from './paths.js';
import type { ManifestItem, QuarantineRecord, StateManifest } from './state.js';
import { readState, writeState } from './state.js';

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

/** Canonical identity captured when a whole-file global projection was rendered. */
export interface RetainedFileBlockCanonical {
  storePath: string;
  baseline: PathIdentity;
}

/** Field-level provenance retained after a global instruction file is detached. */
export interface RetainedFileBlockItem {
  item: FileBlockItem;
  canonical: RetainedFileBlockCanonical[];
}

export interface RetainedFileBlockProvenance {
  items: RetainedFileBlockItem[];
}

export interface RetainedCanonicalWrite {
  path: string;
  text: string;
  mode?: number;
}

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

/**
 * Raised when a target's in-file markers do not match the region the manifest
 * records this env owns — duplicated, extra, non-contiguous, or relabelled
 * markers, i.e. text agentenv did not write or that has been mangled/copied.
 *
 * The marker text (`>>> managed — do not edit between markers`) forbids editing
 * *between* markers but cannot stop a user or agent copying, pasting a lookalike,
 * or relabelling the markers themselves. Rather than trust marker-shaped text and
 * bound the reclaimed span as first-marker → last-marker (which swallows any user
 * content caught between hostile markers, and can even collapse to the whole
 * file), the surface **fails closed**: it refuses to strip, delete, or write back
 * anything and surfaces this error (doctor philosophy — warn, do not corrupt).
 */
export class FileBlockConflictError extends Error {
  constructor(
    /** The target instruction file agentenv refused to modify. */
    readonly file: string,
    /** Why the in-file markers could not be trusted as agentenv's own region. */
    readonly detail: string,
  ) {
    super(`agentenv: refusing to modify ${file}: ${detail}`);
    this.name = 'FileBlockConflictError';
  }
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
function renderSubBlock(
  env: string,
  source: string,
  body: string,
  eol: '\n' | '\r\n',
): string {
  return openMarker(env, source) + eol + body + eol + closeMarker(env, source);
}

/**
 * Render an env's whole managed region: its sub-blocks separated by a blank
 * line. `bodies` maps a source id to its rendered body (an include line for
 * import mode, inlined content for inline mode).
 */
function renderRegion(
  env: string,
  subBlocks: FileSubBlock[],
  bodies: Map<string, string>,
  eol: '\n' | '\r\n',
): string {
  return subBlocks
    .map((sb) => renderSubBlock(env, sb.source, bodies.get(sb.source) ?? '', eol))
    .join(eol + eol);
}

/** One marker line located in file text (open or close), with its byte span. */
interface MarkerHit {
  kind: 'open' | 'close';
  /** The full `<env>/<source>` label. */
  label: string;
  start: number;
  end: number;
}

/**
 * Scan `content` for EVERY agentenv marker line — opens and closes independently,
 * not as paired blocks — returned in document order. Scanning each marker on its
 * own (rather than a non-greedy open…close regex) is what lets {@link
 * locateOwnedRegion} detect a marker nested inside another block's body: a
 * non-greedy pair would silently swallow it, collapsing the span.
 */
function scanMarkers(content: string): MarkerHit[] {
  const hits: MarkerHit[] = [];
  const open = /<!-- >>> agentenv:([^\s>]+) >>> managed[^\n]*-->/g;
  for (let m = open.exec(content); m !== null; m = open.exec(content)) {
    hits.push({ kind: 'open', label: m[1] ?? '', start: m.index, end: m.index + m[0].length });
  }
  const close = /<!-- <<< agentenv:([^\s<]+) <<< -->/g;
  for (let m = close.exec(content); m !== null; m = close.exec(content)) {
    hits.push({ kind: 'close', label: m[1] ?? '', start: m.index, end: m.index + m[0].length });
  }
  return hits.sort((a, b) => a.start - b.start);
}

/**
 * The result of anchoring a target's markers to the manifest record:
 * - `clean` — the file holds EXACTLY this env's recorded sub-blocks, in order,
 *   as a single contiguous run; `[start, end)` is the safe-to-reclaim span and
 *   `bodies` maps each source id to its in-file body.
 * - `absent` — the region is entirely gone (no markers claim this env); there is
 *   nothing to strip, so callers may re-insert or drop the record without risk.
 * - `conflict` — markers claim this env but do not match the record (duplicated,
 *   extra, missing, non-contiguous, or relabelled): mangled or hostile, so the
 *   caller must refuse rather than guess a span and eat content.
 */
type OwnedRegion =
  | {
      status: 'clean';
      start: number;
      end: number;
      bodies: Map<string, string>;
      eol: '\n' | '\r\n';
    }
  | { status: 'absent' }
  | { status: 'conflict'; detail: string };

/**
 * Locate the region agentenv may safely reclaim, anchored to the manifest.
 *
 * The reclaimable region is a SINGLE CONTIGUOUS run of exactly the env's recorded
 * `subBlocks` — in order, each an `open(label) … close(label)` pair with the full
 * label `<env>/<source>` (so an env name containing a slash still attributes
 * correctly, Finding 2), separated only by the renderer's `\n\n`. Any deviation
 * — a duplicated or extra pair, a missing/relabelled marker, a nested marker in a
 * body, or user content wedged between sub-blocks — yields `conflict`, never a
 * best-effort span. Ownership comes from the manifest, never from trusting
 * marker-shaped text found in the file.
 */
function locateOwnedRegion(content: string, env: string, subBlocks: FileSubBlock[]): OwnedRegion {
  const prefix = `${env}/`;
  const mine = scanMarkers(content).filter((h) => h.label.startsWith(prefix));
  if (mine.length === 0) return { status: 'absent' };

  const expected = subBlocks.length * 2;
  if (mine.length !== expected) {
    return {
      status: 'conflict',
      detail:
        `expected ${subBlocks.length} managed sub-block(s) for env "${env}" ` +
        `(${expected} markers) but found ${mine.length} claiming this env`,
    };
  }

  const bodies = new Map<string, string>();
  let structuralEol: '\n' | '\r\n' | null = null;
  for (let i = 0; i < subBlocks.length; i++) {
    const sb = subBlocks[i];
    const openHit = mine[i * 2];
    const closeHit = mine[i * 2 + 1];
    if (!sb || !openHit || !closeHit) {
      return { status: 'conflict', detail: `malformed marker run for env "${env}"` };
    }
    const want = `${env}/${sb.source}`;
    if (openHit.kind !== 'open' || openHit.label !== want) {
      return { status: 'conflict', detail: `sub-block ${i + 1} open marker does not match manifest (${want})` };
    }
    if (closeHit.kind !== 'close' || closeHit.label !== want) {
      return { status: 'conflict', detail: `sub-block ${i + 1} close marker does not match manifest (${want})` };
    }
    const afterOpen = lineBreakAfter(content, openHit.end);
    const beforeClose = lineBreakBefore(content, closeHit.start);
    if (!afterOpen || !beforeClose || afterOpen.value !== beforeClose.value) {
      return { status: 'conflict', detail: `sub-block ${i + 1} has malformed line boundaries` };
    }
    structuralEol ??= afterOpen.value;
    if (afterOpen.value !== structuralEol) {
      return { status: 'conflict', detail: `mixed structural line endings for env "${env}"` };
    }
    if (i > 0) {
      const prevClose = mine[(i - 1) * 2 + 1];
      if (
        !prevClose ||
        content.slice(prevClose.end, openHit.start) !== structuralEol + structuralEol
      ) {
        return { status: 'conflict', detail: `unexpected content between managed sub-blocks of env "${env}"` };
      }
    }
    bodies.set(
      sb.source,
      content.slice(openHit.end + afterOpen.length, closeHit.start - beforeClose.length),
    );
  }

  const first = mine[0];
  const last = mine[mine.length - 1];
  if (!first || !last) return { status: 'conflict', detail: `malformed marker run for env "${env}"` };
  return {
    status: 'clean',
    start: first.start,
    end: last.end,
    bodies,
    eol: structuralEol ?? '\n',
  };
}

function lineBreakAfter(
  content: string,
  index: number,
): { value: '\n' | '\r\n'; length: 1 | 2 } | null {
  if (content.startsWith('\r\n', index)) return { value: '\r\n', length: 2 };
  if (content.startsWith('\n', index)) return { value: '\n', length: 1 };
  return null;
}

function lineBreakBefore(
  content: string,
  index: number,
): { value: '\n' | '\r\n'; length: 1 | 2 } | null {
  if (content.slice(index - 2, index) === '\r\n') return { value: '\r\n', length: 2 };
  if (content.slice(index - 1, index) === '\n') return { value: '\n', length: 1 };
  return null;
}

/**
 * Strip the byte span `[start, end)` from `content`, returning the surrounding
 * user content byte-for-byte. The exact inverse of {@link appendRegion}: the
 * region is always joined with exactly one leading line-ending separator and
 * exactly one trailing line ending, so one of each is removed here and nothing else. Removing a
 * *fixed* one leading newline (never a heuristic count) is what lets a user
 * safely prepend their own content — e.g. `MY NOTES\n` above the region — and
 * keep it: their newline survives because only agentenv's single separator is
 * reclaimed. The span itself comes from {@link locateOwnedRegion}, so only a
 * manifest-confirmed region is ever removed.
 */
function stripSpan(content: string, start: number, end: number): string {
  const before = content.slice(0, start);
  const after = content.slice(end);
  const userHead = before.endsWith('\r\n')
    ? before.slice(0, -2)
    : before.endsWith('\n')
      ? before.slice(0, -1)
      : before;
  const userTail = after.startsWith('\r\n')
    ? after.slice(2)
    : after.startsWith('\n')
      ? after.slice(1)
      : after;
  return userHead + userTail;
}

/**
 * Append a rendered region to user content, byte-reversibly by
 * {@link stripSpan}: exactly one line ending always separates the (possibly
 * empty) user content from the region — giving a blank line whenever the content
 * already ends in a newline — and exactly one line ending terminates the file. The
 * separator is inserted unconditionally (even for empty content) so its removal
 * is unambiguous regardless of any user edits made around the region later.
 */
export function appendRegion(
  user: string,
  region: string,
  preferredEol?: '\n' | '\r\n',
): string {
  const eol = preferredEol ?? detectEol(user);
  return user + eol + region + eol;
}

function detectEol(text: string): '\n' | '\r\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** Remove only adjacent duplicate marker lines, a common formatter/harness failure. */
function collapseDuplicateMarkers(
  content: string,
  env: string,
  subBlocks: FileSubBlock[],
): string {
  let repaired = content;
  const markers = subBlocks.flatMap((sb) => [
    openMarker(env, sb.source),
    closeMarker(env, sb.source),
  ]);
  for (const marker of markers) {
    for (const eol of ['\r\n', '\n'] as const) {
      const duplicate = `${marker}${eol}${marker}`;
      while (repaired.includes(duplicate)) repaired = repaired.replace(duplicate, marker);
    }
  }
  return repaired;
}

/**
 * Resolve a Git conflict only when choosing one complete side yields a manifest-
 * anchored region. The unchosen bytes are retained by {@link repairMangled} before
 * this helper is called; content outside the conflict block is never rewritten.
 */
function stripGeneratedConflict(
  content: string,
  env: string,
  subBlocks: FileSubBlock[],
): string | null {
  const conflict =
    /^<<<<<<<[^\r\n]*(?:\r?\n)([\s\S]*?)^=======[^\r\n]*(?:\r?\n)([\s\S]*?)^>>>>>>>[^\r\n]*(?:\r?\n|$)/gm;
  for (let match = conflict.exec(content); match !== null; match = conflict.exec(content)) {
    const whole = match[0];
    if (!whole.includes(`agentenv:${env}/`)) continue;
    for (const side of [match[1], match[2]]) {
      if (side === undefined) continue;
      const candidate = collapseDuplicateMarkers(
        content.slice(0, match.index) + side + content.slice(match.index + whole.length),
        env,
        subBlocks,
      );
      const owned = locateOwnedRegion(candidate, env, subBlocks);
      if (owned.status === 'clean') return stripSpan(candidate, owned.start, owned.end);
    }
  }
  return null;
}

/** Index of `needle` only when it occurs exactly once. */
function uniqueIndex(content: string, needle: string): number | null {
  const first = content.indexOf(needle);
  if (first < 0 || content.indexOf(needle, first + 1) >= 0) return null;
  return first;
}

/**
 * Strip a one-sub-block region whose open OR close marker was truncated, but only
 * when the remaining bytes exactly match the current canonical rendering. If the
 * body also changed, its boundary is ambiguous and automatic repair refuses it.
 */
async function stripCanonicalTruncation(
  content: string,
  item: FileBlockItem,
): Promise<string | null> {
  if (item.subBlocks.length !== 1) return null;
  const sb = item.subBlocks[0];
  if (!sb) return null;
  const body = await renderBody(item.mode, { source: sb.source, storePath: sb.storePath });
  const open = openMarker(item.ownerEnv, sb.source);
  const close = closeMarker(item.ownerEnv, sb.source);

  for (const eol of [detectEol(content), detectEol(content) === '\n' ? '\r\n' : '\n'] as const) {
    const renderedBody = body.replace(/\r?\n/g, eol);
    const fragments = [
      `${open}${eol}${renderedBody}${eol}`,
      `${renderedBody}${eol}${close}`,
    ];
    for (const fragment of fragments) {
      const start = uniqueIndex(content, fragment);
      if (start === null) continue;
      const candidate = stripSpan(content, start, start + fragment.length);
      const mine = scanMarkers(candidate).filter((hit) =>
        hit.label.startsWith(`${item.ownerEnv}/`),
      );
      if (mine.length === 0) return candidate;
    }
  }
  return null;
}

/**
 * Derive user-owned bytes from a damaged managed region without restoring the
 * activation-time whole-file backup. Only damage with a demonstrable boundary is
 * repaired automatically; all other corruption remains quarantined for explicit
 * resolution.
 */
async function stripRepairableDamage(
  content: string,
  item: FileBlockItem,
): Promise<string | null> {
  const collapsed = collapseDuplicateMarkers(content, item.ownerEnv, item.subBlocks);
  const collapsedOwned = locateOwnedRegion(collapsed, item.ownerEnv, item.subBlocks);
  if (collapsedOwned.status === 'clean') {
    return stripSpan(collapsed, collapsedOwned.start, collapsedOwned.end);
  }

  const resolvedConflict = stripGeneratedConflict(content, item.ownerEnv, item.subBlocks);
  if (resolvedConflict !== null) return resolvedConflict;

  return stripCanonicalTruncation(content, item);
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

    // Preserve the ORIGINAL pre-materialise state across re-materialise so
    // dematerialise can tell a file we created (delete on drop) from a file we
    // added a block to (restore user content). The journal undo, by contrast,
    // captures the immediately-preceding bytes to undo *this* write on a crash.
    const existing = findRecord(await readState(paths), target, env);

    // Reclaim ONLY a region the manifest confirms this env already owns. On a
    // first materialise (no record) nothing is stripped — a user's pasted
    // lookalike markers are left as their content and the region is inserted
    // cleanly below them, never swallowing what falls between them.
    let userContent = before;
    if (existing) {
      const owned = locateOwnedRegion(before, env, existing.subBlocks);
      if (owned.status === 'conflict') throw new FileBlockConflictError(target, owned.detail);
      if (owned.status === 'clean') userContent = stripSpan(before, owned.start, owned.end);
      // 'absent' → the region was removed out-of-band; re-insert without stripping.
    }

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

    const eol = detectEol(before);
    const region = renderRegion(env, subBlocks, bodies, eol);
    const after = appendRegion(userContent, region, eol);

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

/**
 * Repair a manifest-owned region whose markers are damaged without rolling the
 * target back to its activation-time bytes.
 *
 * The exact pre-repair file is first copied to retained storage and referenced by
 * `state.quarantine`, outside content-addressed backup GC. Automatic repair then
 * proceeds only when the damaged region has a demonstrable boundary: adjacent
 * duplicate markers, one complete side of a Git conflict, or a canonical body
 * with one truncated boundary marker. Ambiguous damage is retained and refused.
 */
export async function repairMangled(paths: Paths, opts: FileBlockTargetOptions): Promise<void> {
  const { target, env } = opts;
  return withLock(paths, async () => {
    let manifest = await readState(paths);
    const record = findRecord(manifest, target, env);
    if (!record) return;

    const before = await readFileOrEmpty(target);
    const owned = locateOwnedRegion(before, env, record.subBlocks);
    if (owned.status !== 'conflict') return;

    const id = `doctor-file-block-${Date.now()}-${randomBytes(6).toString('hex')}`;
    const retainedPath = join(paths.live, 'quarantine', id, 'content');
    await writeFileAtomic(retainedPath, before);
    const rescue: QuarantineRecord = {
      schemaVersion: 2,
      id,
      kind: 'doctor-file-block-rescue',
      path: target,
      retainedPath,
      reason: `managed marker repair for env '${env}' retained the ambiguous input bytes`,
      createdAt: Date.now(),
      resolved: false,
    };
    manifest.quarantine.push(rescue);
    await writeState(paths, manifest);

    const userContent = await stripRepairableDamage(before, record);
    if (userContent === null) {
      throw new FileBlockConflictError(
        target,
        `marker damage has no safe automatic boundary; retained at ${retainedPath}`,
      );
    }

    const bodies = new Map<string, string>();
    const subBlocks: FileSubBlock[] = [];
    for (const sb of record.subBlocks) {
      const body = await renderBody(record.mode, { source: sb.source, storePath: sb.storePath });
      bodies.set(sb.source, body);
      subBlocks.push({
        source: sb.source,
        storePath: sb.storePath,
        ...(record.mode === 'inline' ? { hash: hashBody(body) } : {}),
      });
    }
    const eol = detectEol(before);
    const after = appendRegion(userContent, renderRegion(env, subBlocks, bodies, eol), eol);
    const updated: FileBlockItem = { ...record, subBlocks };
    const currentBackup = await backup(paths, target);
    const tx = await beginTransaction(paths);
    try {
      await tx.apply(
        {
          op: 'add',
          item: updated as ManifestItem,
          undo: { path: target, backupRef: currentBackup },
        },
        async () => writeFileAtomic(target, after),
      );
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw error;
    }

    manifest = await readState(paths);
    const retained = manifest.quarantine.find((entry) => entry.id === id);
    if (retained) retained.resolved = true;
    await writeState(paths, manifest);
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
    // Without a manifest record agentenv cannot confirm it owns anything here, so
    // it touches nothing — a safe no-op (idempotent drop). It never strips a
    // region on the strength of marker-shaped text alone.
    if (!record) return;

    const before = await readFileOrEmpty(target);
    const owned = locateOwnedRegion(before, env, record.subBlocks);
    // Mangled/hostile markers (duplicated, relabelled, nested, non-contiguous):
    // refuse rather than reclaim a guessed span — this is what stops a lookalike
    // open marker collapsing the span and `rm`-ing the whole file.
    if (owned.status === 'conflict') throw new FileBlockConflictError(target, owned.detail);

    let after = before;
    let deleteFile = false;
    if (owned.status === 'clean') {
      after = stripSpan(before, owned.start, owned.end);
      // Delete only a file agentenv itself created that is now empty; never a
      // file that pre-existed (even empty) or that still holds user content.
      deleteFile = after === '' && record.backupRef?.kind === 'absent';
    }
    // 'absent' → the region is already gone; only the manifest record is removed.

    const currentBackup = await backup(paths, target);
    const tx = await beginTransaction(paths);
    try {
      await tx.apply(
        { op: 'remove', item: record as ManifestItem, undo: { path: target, backupRef: currentBackup } },
        async () => {
          if (deleteFile) await rm(target, { force: true });
          else if (after !== before) await writeFileAtomic(target, after);
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

export interface FileBlockSyncBackPlan extends SyncBackResult {
  target: string;
  before: string;
  after: string;
  storeWrites: { storePath: string; body: string }[];
  updatedItem?: FileBlockItem;
}

/** Discover the complete inline reconciliation without mutating target, store, or state. */
export async function planSyncBack(
  paths: Paths,
  opts: FileBlockTargetOptions,
  overrides: {
    manifest?: StateManifest;
    targetText?: string;
    storeTexts?: ReadonlyMap<string, string>;
  } = {},
): Promise<FileBlockSyncBackPlan> {
  const { target, env } = opts;
  const empty: FileBlockSyncBackPlan = {
    target,
    before: '',
    after: '',
    storeWrites: [],
    drifted: [],
    refreshed: [],
  };
  const manifest = overrides.manifest ?? await readState(paths);
  const record = findRecord(manifest, target, env);
  if (!record || record.mode === 'import') return empty;
  const before = overrides.targetText ?? await readFileOrEmpty(target);
  const owned = locateOwnedRegion(before, env, record.subBlocks);
  if (owned.status === 'conflict') throw new FileBlockConflictError(target, owned.detail);
  if (owned.status === 'absent') return { ...empty, before, after: before };

  const drifted: string[] = [];
  const refreshed: string[] = [];
  const newBodies = new Map<string, string>();
  const updatedSubBlocks: FileSubBlock[] = [];
  const storeWrites: { storePath: string; body: string }[] = [];
  for (const sb of record.subBlocks) {
    const storeBody = overrides.storeTexts?.get(sb.storePath) ?? await readFileOrEmpty(sb.storePath);
    const fileBody = owned.bodies.get(sb.source) ?? storeBody;
    let newBody: string;
    if (hashBody(fileBody) !== sb.hash) {
      newBody = fileBody;
      storeWrites.push({ storePath: sb.storePath, body: newBody });
      drifted.push(sb.source);
    } else if (hashBody(storeBody) !== sb.hash) {
      newBody = storeBody;
      refreshed.push(sb.source);
    } else {
      newBody = fileBody;
    }
    newBodies.set(sb.source, newBody);
    updatedSubBlocks.push({ ...sb, hash: hashBody(newBody) });
  }
  const region = renderRegion(env, updatedSubBlocks, newBodies, owned.eol);
  const after = appendRegion(stripSpan(before, owned.start, owned.end), region, owned.eol);
  const hashesChanged = updatedSubBlocks.some((sb, index) => sb.hash !== record.subBlocks[index]?.hash);
  return {
    target,
    before,
    after,
    storeWrites,
    drifted,
    refreshed,
    ...(storeWrites.length > 0 || after !== before || hashesChanged
      ? { updatedItem: { ...record, subBlocks: updatedSubBlocks } }
      : {}),
  };
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
  return withLock(paths, async () => {
    const plan = await planSyncBack(paths, opts);
    if (!plan.updatedItem) return { drifted: plan.drifted, refreshed: plan.refreshed };
    const currentBackup = await backup(paths, plan.target);
    for (const w of plan.storeWrites) await backup(paths, w.storePath);

    const tx = await beginTransaction(paths);
    try {
      await tx.apply(
        {
          op: 'add',
          item: plan.updatedItem as ManifestItem,
          undo: { path: plan.target, backupRef: currentBackup },
        },
        async () => {
          for (const w of plan.storeWrites) await writeFileAtomic(w.storePath, w.body);
          if (plan.after !== plan.before) await writeFileAtomic(plan.target, plan.after);
        },
      );
      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }
    return { drifted: plan.drifted, refreshed: plan.refreshed };
  });
}

/**
 * Reverse only manifest-anchored inline bodies from a quiescent retained file.
 * Every changed source is validated before the first write and revalidated at
 * its destructive boundary. User bytes outside markers are never copied.
 */
export async function reconcileRetainedFileBlockProjection(
  retainedPath: string,
  provenance: RetainedFileBlockProvenance,
): Promise<RetainedCanonicalWrite[]> {
  const content = await readFileOrEmpty(retainedPath);
  const writes: { path: string; body: string; baseline: PathIdentity }[] = [];

  for (const entry of provenance.items) {
    const { item } = entry;
    const owned = locateOwnedRegion(content, item.ownerEnv, item.subBlocks);
    if (owned.status !== 'clean') {
      const detail = owned.status === 'conflict' ? owned.detail : 'managed region is absent';
      throw new FileBlockConflictError(retainedPath, detail);
    }
    for (const subBlock of item.subBlocks) {
      const observedBody = owned.bodies.get(subBlock.source);
      if (observedBody === undefined) {
        throw new FileBlockConflictError(
          retainedPath,
          `managed sub-block '${subBlock.source}' is absent`,
        );
      }
      if (item.mode === 'import') {
        if (observedBody !== `@${subBlock.storePath}`) {
          throw new FileBlockConflictError(
            retainedPath,
            `import sub-block '${subBlock.source}' changed and is not reversible`,
          );
        }
        continue;
      }
      if (!subBlock.hash || hashBody(observedBody) === subBlock.hash) continue;
      const canonical = entry.canonical.find(
        (candidate) => candidate.storePath === subBlock.storePath,
      );
      if (!canonical) {
        throw new Error(`canonical provenance missing for '${subBlock.source}'`);
      }
      if (!identitiesEqual(await capturePathIdentity(subBlock.storePath), canonical.baseline)) {
        throw new Error(`canonical source changed concurrently for '${subBlock.source}'`);
      }
      writes.push({ path: subBlock.storePath, body: observedBody, baseline: canonical.baseline });
    }
  }

  return writes.map((write) => ({
    path: write.path,
    text: write.body,
    ...(write.baseline.kind === 'file' ? { mode: write.baseline.mode } : {}),
  }));
}

// ---------------------------------------------------------------------------
// inspect (read-only) — for `agentenv doctor`
// ---------------------------------------------------------------------------

/**
 * The read-only health of an env's managed region, anchored to the manifest:
 * - `clean`    — the file holds exactly the recorded sub-blocks, well-formed.
 * - `absent`   — the manifest owns a region but no markers claim this env (a
 *   harness deleted the whole block).
 * - `conflict` — markers claim this env but were mangled (duplicated, relabelled,
 *   non-contiguous, nested): a harness rewrite broke them.
 * - `unowned`  — the manifest has no file-block record for (target, env).
 */
export type RegionStatus = 'clean' | 'absent' | 'conflict' | 'unowned';

/** Result of {@link inspectOwnedRegion}: a status and, for `conflict`, why. */
export interface RegionInspection {
  status: RegionStatus;
  detail?: string;
}

/**
 * Report whether the manifest-owned marker region in `target` for `env` is intact,
 * WITHOUT modifying anything (design D4 doctor). Reuses the exact {@link
 * locateOwnedRegion} anchoring that {@link materialise}/{@link dematerialise}
 * trust, so `doctor` never re-implements marker parsing and its verdict matches
 * what a repair would then face.
 */
export async function inspectOwnedRegion(
  paths: Paths,
  opts: FileBlockTargetOptions,
): Promise<RegionInspection> {
  const record = findRecord(await readState(paths), opts.target, opts.env);
  if (!record) return { status: 'unowned' };
  const content = await readFileOrEmpty(opts.target);
  const owned = locateOwnedRegion(content, opts.env, record.subBlocks);
  if (owned.status === 'conflict') return { status: 'conflict', detail: owned.detail };
  return { status: owned.status };
}
