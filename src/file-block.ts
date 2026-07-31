import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
 * was joined with a single leading `\n` separator (when user content precedes
 * it) and a single trailing `\n`, so both are removed here and nothing else.
 */
export function stripRegion(content: string, env: string): { user: string; region: string | null } {
  const span = regionSpan(content, env);
  if (!span) return { user: content, region: null };

  const before = content.slice(0, span.start);
  const region = content.slice(span.start, span.end);
  const after = content.slice(span.end);

  // Reverse appendRegion: content = user + SEP + region + "\n",
  // where SEP = "" when user is empty, else "\n". So remove one separator "\n"
  // from the tail of `before` and one trailing "\n" from `after`.
  const userHead = before.endsWith('\n') ? before.slice(0, -1) : before;
  const userTail = after.startsWith('\n') ? after.slice(1) : after;
  return { user: userHead + userTail, region };
}

/**
 * Append a rendered region `region` to user content, byte-reversibly by
 * {@link stripRegion}: exactly one `\n` separates existing content from the
 * region (giving a blank line when the content already ends in a newline), and
 * exactly one `\n` terminates the file.
 */
export function appendRegion(user: string, region: string): string {
  if (user === '') return `${region}\n`;
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
