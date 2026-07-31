import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser';
import type { JSONPath, ParseError } from 'jsonc-parser';
import { backup } from './backups.js';
import { writeFileAtomic } from './fs-atomic.js';
import type { Transaction } from './journal.js';
import type { Paths } from './paths.js';
import type { ManifestItemBase } from './state.js';

/**
 * The config-keys surface mechanism (design D3). Injects/removes *real* keys into
 * JSON/JSONC/TOML config files, tracked by **key path and content hash — never by
 * text munging** — so a harness that reserialises or reorders a file cannot orphan
 * our ownership. Two ownership modes:
 *
 * - **keyed** — an object property at a key path (e.g. `mcpServers.linear`).
 *   JSON/JSONC edits are surgical (jsonc-parser `modify`), preserving the user's
 *   formatting *and* comments; TOML is appended as a whole marked `[table]` and
 *   removed by marker-splice, falling back to a full parse when a harness stripped
 *   the markers.
 * - **array-element** — a single value in an array (OpenCode `instructions`, Pi
 *   settings arrays). Ownership is surface + array path + **exact value**; removal
 *   matches by value (order-independent, so harness reordering is harmless) and a
 *   missing value at removal is a logged no-op.
 *
 * Drift runs on **every pass** ({@link syncBack}): each owned key is re-hashed, and
 * a changed value is written back — secret-flagged fields restored to their
 * `${VAR}` placeholders, never the literal (D6). Removal proceeds only when the
 * hash still matches, or after drift has been written back.
 *
 * This is a library module consumed by the engine (task 1.7). Each API takes an
 * open {@link Transaction} so the engine batches many key operations under one
 * write-ahead journal and one lock; the module never opens or commits the
 * transaction itself.
 */

/** The on-disk format of the config file an owned key lives in. */
export type ConfigFormat = 'json' | 'jsonc' | 'toml';

/** How ownership of a config entry is recorded and matched (D3). */
export type OwnershipMode = 'keyed' | 'array-element';

/** A path into a config document: object keys (strings) and array indices (numbers). */
export type KeyPath = readonly (string | number)[];

/** A JSON-compatible value — what we inject and what we read back for hashing. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * A problem manipulating a config file: unparseable JSON/JSONC/TOML, or a
 * structural mismatch (e.g. an array path that is not an array). Always names the
 * file, mirroring {@link import('./state.js').StateError} /
 * {@link import('./env-config.js').EnvYamlError}.
 */
export class ConfigKeysError extends Error {
  constructor(
    message: string,
    readonly file: string,
  ) {
    super(message);
    this.name = 'ConfigKeysError';
  }
}

/**
 * The config-keys ownership record. Registered on
 * {@link import('./state.js').ManifestItemVariants} by declaration merging below,
 * so `surface: 'config-keys'` narrows to this shape without a central union edit.
 * A plain data record (it round-trips through state.json), so it carries only
 * fields, never methods — the file it touches is `path`.
 */
export interface ConfigKeysItem extends ManifestItemBase {
  surface: 'config-keys';
  action: 'config-key';
  /** Keyed (object property) vs array-element (value in an array). */
  mode: OwnershipMode;
  /** Source format, so removal knows JSON-surgical vs TOML parse-fallback. */
  format: ConfigFormat;
  /** The owned key path (keyed) or the array's path (array-element). */
  keyPath: (string | number)[];
  /** array-element only: the exact owned value; removal matches by it. */
  value?: JsonValue;
  /** Content hash of the owned value (base `hash`, restated required here). */
  hash: string;
  /**
   * Subpaths *within* the owned value that carried a `${VAR}` placeholder, mapped
   * to that placeholder text (e.g. `{ "env.GITHUB_TOKEN": "${GITHUB_TOKEN}" }`).
   * On write-back these subfields are restored to the placeholder, never the
   * current literal, so a token baked over a passthrough placeholder mid-session
   * cannot leak into the store (D6). Secret values and resolution are task 2.4 —
   * here we only carry the flag + placeholder text.
   */
  secretFields?: Record<string, string>;
}

// Register the variant so `ManifestItem` narrows on `surface: 'config-keys'`
// (design: each surface augments the registry from its own module).
declare module './state.js' {
  interface ManifestItemVariants {
    'config-keys': ConfigKeysItem;
  }
}

/** Request to inject an object key at a key path (keyed mode). */
export interface InjectKeyedRequest {
  /** Absolute path to the config file. */
  file: string;
  /** The file's format. */
  format: ConfigFormat;
  /** The key path to own, e.g. `['mcpServers', 'linear']`. */
  keyPath: KeyPath;
  /** The value to inject at that path. */
  value: JsonValue;
  /** The environment that will own this key (D5). */
  ownerEnv: string;
  /** Optional secret-flagged subpaths → placeholder text (see {@link ConfigKeysItem.secretFields}). */
  secretFields?: Record<string, string>;
}

/** Request to inject one value into an array (array-element mode). */
export interface InjectArrayElementRequest {
  /** Absolute path to the config file. */
  file: string;
  /** The file's format (array-element is supported for `json`/`jsonc`). */
  format: ConfigFormat;
  /** The array's path, e.g. `['instructions']`. */
  arrayPath: KeyPath;
  /** The exact value to add; removal later matches by this value. */
  value: JsonValue;
  /** The environment that will own this element (D5). */
  ownerEnv: string;
}

/** Outcome of {@link removeKey}. */
export interface RemoveResult {
  /** Whether the key/element was actually removed from the file. */
  removed: boolean;
  /**
   * Why a removal did not happen: `hash-mismatch` (the value drifted — write it
   * back via {@link syncBack} first) or `absent` (nothing there to remove).
   */
  reason?: 'hash-mismatch' | 'absent';
  /** Human-readable note for the caller to log (e.g. the absent no-op, D3). */
  note?: string;
}

/** Outcome of {@link syncBack}. */
export interface SyncBackResult {
  /** Whether the owned value had drifted from its recorded hash. */
  drifted: boolean;
  /** The value currently in the file (verbatim; may hold a baked literal). Absent if the key vanished. */
  currentValue?: JsonValue;
  /**
   * The value to persist to the canonical store: `currentValue` with every
   * secret-flagged subfield restored to its `${VAR}` placeholder (D6). Present
   * only on drift.
   */
  canonicalValue?: JsonValue;
  /** The updated ownership record (new hash on drift; unchanged otherwise). */
  item: ConfigKeysItem;
  /** Human-readable note for the caller to log (e.g. the key vanished). */
  note?: string;
}

// ---------------------------------------------------------------------------
// Path / value helpers
// ---------------------------------------------------------------------------

/** Render a key path as a stable, human-readable discriminator, e.g. `a[0].b`. */
function displayPath(path: KeyPath): string {
  return path
    .map((seg, i) => (typeof seg === 'number' ? `[${seg}]` : i === 0 ? seg : `.${seg}`))
    .join('');
}

/** The intra-file `key` discriminator for a keyed ownership record (see {@link ManifestItemBase.key}). */
function keyedDiscriminator(keyPath: KeyPath): string {
  return displayPath(keyPath);
}

/** Deterministic stringification with object keys sorted — so key *reordering* is not drift. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** SHA-256 of the stable stringification — the drift-detection content hash (D3). */
function hashValue(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

/** Navigate `path` into `root`; report whether it existed and the value found. */
function getAtPath(root: unknown, path: KeyPath): { found: boolean; value: unknown } {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object') return { found: false, value: undefined };
    if (Array.isArray(cur)) {
      if (typeof seg !== 'number' || seg < 0 || seg >= cur.length) {
        return { found: false, value: undefined };
      }
      cur = cur[seg];
    } else {
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) return { found: false, value: undefined };
      cur = (cur as Record<string, unknown>)[seg as string];
    }
  }
  return { found: true, value: cur };
}

// ---------------------------------------------------------------------------
// Format read/parse
// ---------------------------------------------------------------------------

/** Read a file's text, treating a missing file as empty (a fresh create). */
async function readText(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

/**
 * Parse JSON/JSONC text into a value, tolerating comments and trailing commas.
 * Hard syntax errors throw {@link ConfigKeysError}.
 */
function parseJsonConfig(text: string, file: string): unknown {
  if (text.trim() === '') return {};
  const errors: ParseError[] = [];
  const value = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new ConfigKeysError(`${file}: could not parse JSON/JSONC config`, file);
  }
  return value;
}

/** Base text for a JSON/JSONC surgical edit — an empty/whitespace file seeds `{}`. */
function jsonBaseText(text: string): string {
  return text.trim() === '' ? '{}' : text;
}

// ---------------------------------------------------------------------------
// inject — keyed mode
// ---------------------------------------------------------------------------

/**
 * Inject an object key at `keyPath`, format- and comment-preserving. JSON/JSONC
 * uses jsonc-parser surgical `modify` with no reformatting, so a full
 * inject→remove cycle is byte-identical to the original. Records ownership via the
 * transaction (backup-first, write-ahead journal). Idempotent: re-injecting the
 * same key overwrites its value and refreshes the hash.
 *
 * Returns the ownership record the caller should surface in status; the engine's
 * `tx.commit()` upserts it into the manifest.
 */
export async function injectKeyed(
  paths: Paths,
  tx: Transaction,
  req: InjectKeyedRequest,
): Promise<ConfigKeysItem> {
  const text = await readText(req.file);
  const next = injectKeyedText(text, req);
  const item = makeKeyedItem(req);
  await applyFileMutation(paths, tx, 'add', item, req.file, next);
  return item;
}

/** Compute the post-injection file text for a keyed injection, dispatching on format. */
function injectKeyedText(text: string, req: InjectKeyedRequest): string {
  if (req.format === 'toml') {
    throw new ConfigKeysError(`${req.file}: TOML keyed injection not yet implemented`, req.file);
  }
  const base = jsonBaseText(text);
  return applyEdits(base, modify(base, req.keyPath as JSONPath, req.value, {}));
}

function makeKeyedItem(req: InjectKeyedRequest): ConfigKeysItem {
  const item: ConfigKeysItem = {
    action: 'config-key',
    surface: 'config-keys',
    path: req.file,
    key: keyedDiscriminator(req.keyPath),
    ownerEnv: req.ownerEnv,
    mode: 'keyed',
    format: req.format,
    keyPath: [...req.keyPath],
    hash: hashValue(req.value),
  };
  if (req.secretFields && Object.keys(req.secretFields).length > 0) {
    item.secretFields = { ...req.secretFields };
  }
  return item;
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

/**
 * Remove an owned key/element. **Keyed**: removes only when the current value's
 * hash still matches the record — a drifted value is refused (`hash-mismatch`)
 * until {@link syncBack} writes it back. **Array-element**: removes by value,
 * order-independent; an already-absent value is a logged no-op. A backup is taken
 * and the removal is journalled before the file is written.
 */
export async function removeKey(
  paths: Paths,
  tx: Transaction,
  item: ConfigKeysItem,
): Promise<RemoveResult> {
  if (item.mode === 'array-element') {
    throw new ConfigKeysError(`${item.path}: array-element removal not yet implemented`, item.path);
  }
  const text = await readText(item.path);
  const { found, value } = readKeyed(text, item);
  if (!found) {
    return {
      removed: false,
      reason: 'absent',
      note: `config key ${item.key ?? displayPath(item.keyPath)} already absent`,
    };
  }
  if (hashValue(value) !== item.hash) {
    return {
      removed: false,
      reason: 'hash-mismatch',
      note: `config key ${item.key ?? displayPath(item.keyPath)} drifted — write it back before removing`,
    };
  }
  const next = removeKeyedText(text, item);
  await applyFileMutation(paths, tx, 'remove', item, item.path, next);
  return { removed: true };
}

/** Read an owned keyed value from file text, dispatching on format. */
function readKeyed(text: string, item: ConfigKeysItem): { found: boolean; value: unknown } {
  if (item.format === 'toml') {
    throw new ConfigKeysError(`${item.path}: TOML parsing not yet implemented`, item.path);
  }
  return getAtPath(parseJsonConfig(text, item.path), item.keyPath);
}

/** Produce file text with the owned keyed value removed, dispatching on format. */
function removeKeyedText(text: string, item: ConfigKeysItem): string {
  if (item.format === 'toml') {
    throw new ConfigKeysError(`${item.path}: TOML keyed removal not yet implemented`, item.path);
  }
  const base = jsonBaseText(text);
  return applyEdits(base, modify(base, item.keyPath as JSONPath, undefined, {}));
}

// ---------------------------------------------------------------------------
// Shared transaction plumbing
// ---------------------------------------------------------------------------

/**
 * Back up `file`, then journal + apply the write of `text` in one write-ahead
 * step. On a crash the journalled backup restores the file; `op` decides whether
 * commit upserts (`add`) or drops (`remove`) the ownership record.
 */
async function applyFileMutation(
  paths: Paths,
  tx: Transaction,
  op: 'add' | 'remove',
  item: ConfigKeysItem,
  file: string,
  text: string,
): Promise<void> {
  const backupRef = await backup(paths, file);
  await tx.apply({ op, item, undo: { path: file, backupRef } }, async () => {
    await writeFileAtomic(file, text);
  });
}
