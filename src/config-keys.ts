import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser';
import type { JSONPath, ParseError } from 'jsonc-parser';
import { parse as parseToml, stringify as stringifyToml, TomlError } from 'smol-toml';
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
  /**
   * keyed JSON/JSONC only: how many ancestor object levels this inject CREATED
   * (were absent before). On removal those parents are pruned back — deepest-first
   * and only while each is still empty — so an inject→remove cycle is byte-identical
   * and never leaves an orphaned `{}` in the user's file (D3, fix B1). A parent the
   * user already had (even an empty `{}`) is never counted, so never pruned. Absent
   * (treated as 0) when the inject created no parents, or for TOML (whose marked
   * `[table]` mechanism removes the whole block, orphaning nothing).
   */
  createdParents?: number;
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

/**
 * The intra-file `key` discriminator for a keyed ownership record (see {@link
 * ManifestItemBase.key}). Unlike {@link displayPath} (human-readable), this is an
 * IDENTITY, so it must be injective: literal dots (and backslashes) inside a string
 * segment are escaped, so `['a.b','c']` and `['a','b','c']` map to distinct keys
 * rather than both to `"a.b.c"` (fix C2). Segments with no dot render unchanged.
 */
function keyedDiscriminator(keyPath: KeyPath): string {
  return keyPath
    .map((seg, i) => {
      if (typeof seg === 'number') return `[${seg}]`;
      const escaped = seg.replace(/\\/g, '\\\\').replace(/\./g, '\\.');
      return i === 0 ? escaped : `.${escaped}`;
    })
    .join('');
}

/** The intra-file `key` discriminator for an array-element record: array path + exact value. */
function arrayElementDiscriminator(arrayPath: KeyPath, value: JsonValue): string {
  return `${keyedDiscriminator(arrayPath)}[]=${stableStringify(value)}`;
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
 * transaction (backup-first, write-ahead journal).
 *
 * Refuses (a {@link ConfigKeysError}) when a NON-owned value already sits at
 * `keyPath` — it will not silently overwrite a user's JSON key (which a later
 * removal would then delete) nor emit a doubled `[table]` in TOML (fix B2). See
 * {@link assertNoCollision} for the scope boundary between this refusal and the
 * engine's skip/force/re-activation policy (task 1.7).
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
  assertNoCollision(text, req);
  // Record which ancestor levels we CREATE, so removal can prune exactly them and
  // no more (fix B1). TOML uses whole marked [table] blocks — nothing to prune.
  const createdParents =
    req.format === 'toml'
      ? 0
      : countCreatedParents(parseJsonConfig(jsonBaseText(text), req.file), req.keyPath);
  const item = makeKeyedItem(req, createdParents);
  const next = writeKeyedValueText(text, item, req.value);
  await applyFileMutation(paths, tx, 'add', item, req.file, next);
  return item;
}

/**
 * Count the ancestor levels of `keyPath` absent in `root` — the contiguous suffix
 * of parents an inject would create. Absence is monotonic (a missing parent makes
 * every deeper parent missing too), so this is exactly the count of levels we own
 * after the inject and may prune on removal.
 */
function countCreatedParents(root: unknown, keyPath: KeyPath): number {
  let created = 0;
  for (let depth = 1; depth < keyPath.length; depth++) {
    if (!getAtPath(root, keyPath.slice(0, depth)).found) created++;
  }
  return created;
}

/**
 * Refuse a keyed inject that would land on a value/table the environment does not
 * own (fix B2).
 *
 * SCOPE BOUNDARY: this module owns key paths but cannot see the manifest, so
 * "owned" is judged from the file alone. For TOML, our marked block is stripped
 * first, so re-injecting/overwriting *our own* key is fine; a value that still
 * resolves at `keyPath` afterwards is the user's unmarked table → refuse (rather
 * than emit a second `[table]`, which is invalid TOML). For JSON/JSONC there are
 * no markers, so ANY pre-existing value at `keyPath` is treated as a collision and
 * refused (rather than silently overwrite a key a later removal would then delete).
 * Deciding to skip, force, or re-activate an owned key over a collision is the
 * engine's policy (task 1.7); this module's contract is only to REFUSE rather than
 * corrupt, and to surface the collision as a {@link ConfigKeysError}.
 */
function assertNoCollision(text: string, req: InjectKeyedRequest): void {
  const preexisting =
    req.format === 'toml'
      ? getAtPath(
          parseTomlConfig(tomlStripMarkedBlock(text, keyedDiscriminator(req.keyPath)).text, req.file),
          req.keyPath,
        ).found
      : getAtPath(parseJsonConfig(jsonBaseText(text), req.file), req.keyPath).found;
  if (preexisting) {
    throw new ConfigKeysError(
      `${req.file}: refusing to inject over an existing non-owned value at ` +
        `${displayPath(req.keyPath)} — resolve the collision first (skip/force is the engine's call)`,
      req.file,
    );
  }
}

/**
 * Compute file text with `value` written at a keyed value's path, dispatching on
 * format. JSON/JSONC uses surgical `modify` (creates missing parents, preserves
 * surrounding formatting/comments); TOML follows in a later slice.
 */
function writeKeyedValueText(text: string, item: ConfigKeysItem, value: JsonValue): string {
  if (item.format === 'toml') {
    return tomlInjectText(text, item, value);
  }
  const base = jsonBaseText(text);
  return applyEdits(base, modify(base, item.keyPath as JSONPath, value, {}));
}

function makeKeyedItem(req: InjectKeyedRequest, createdParents: number): ConfigKeysItem {
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
  if (createdParents > 0) {
    item.createdParents = createdParents;
  }
  return item;
}

// ---------------------------------------------------------------------------
// inject — array-element mode (JSON/JSONC)
// ---------------------------------------------------------------------------

/**
 * Inject one value into an array (OpenCode `instructions`, Pi settings arrays).
 * Ownership is the array path + **exact value**, so later removal is by value and
 * order-independent — a harness reordering the array is harmless. Appends at the
 * end; idempotent (a value already present is not duplicated); creates the array
 * if the path is absent. JSON/JSONC only.
 *
 * The whole array literal is rewritten in place (the rest of the document stays
 * surgical) rather than editing a single index, because jsonc-parser's
 * position-based array-index edits mishandle the last element of an inline array;
 * a whole-array replacement is always well-formed.
 */
export async function injectArrayElement(
  paths: Paths,
  tx: Transaction,
  req: InjectArrayElementRequest,
): Promise<ConfigKeysItem> {
  if (req.format === 'toml') {
    throw new ConfigKeysError(`${req.file}: array-element injection is JSON/JSONC only`, req.file);
  }
  const text = await readText(req.file);
  const base = jsonBaseText(text);
  const current = readArray(base, req.arrayPath, req.file);
  const present = current.some((v) => stableStringify(v) === stableStringify(req.value));

  const next = present
    ? base // already present — idempotent re-injection
    : applyEdits(base, modify(base, req.arrayPath as JSONPath, [...current, req.value], {}));

  const item = makeArrayElementItem(req);
  await applyFileMutation(paths, tx, 'add', item, req.file, next);
  return item;
}

/**
 * Read the array at `arrayPath` from JSON/JSONC text: an empty array if the path
 * is absent, or {@link ConfigKeysError} if the path exists but is not an array
 * (refusing to clobber a non-array value the user put there).
 */
function readArray(text: string, arrayPath: KeyPath, file: string): JsonValue[] {
  const { found, value } = getAtPath(parseJsonConfig(text, file), arrayPath);
  if (!found) return [];
  if (!Array.isArray(value)) {
    throw new ConfigKeysError(`${file}: ${displayPath(arrayPath)} is not an array`, file);
  }
  return value as JsonValue[];
}

function makeArrayElementItem(req: InjectArrayElementRequest): ConfigKeysItem {
  return {
    action: 'config-key',
    surface: 'config-keys',
    path: req.file,
    key: arrayElementDiscriminator(req.arrayPath, req.value),
    ownerEnv: req.ownerEnv,
    mode: 'array-element',
    format: req.format,
    keyPath: [...req.arrayPath],
    value: req.value,
    hash: hashValue(req.value),
  };
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
    return removeArrayElement(paths, tx, item);
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

/**
 * Remove an owned array element by its exact value (order-independent, so a
 * reordered array is harmless). A value already absent — because a harness
 * removed it, or a double-removal — is a logged no-op, never an error (D3).
 */
async function removeArrayElement(
  paths: Paths,
  tx: Transaction,
  item: ConfigKeysItem,
): Promise<RemoveResult> {
  if (item.format === 'toml') {
    throw new ConfigKeysError(`${item.path}: array-element removal is JSON/JSONC only`, item.path);
  }
  const text = await readText(item.path);
  const base = jsonBaseText(text);
  const { found, value: arr } = getAtPath(parseJsonConfig(base, item.path), item.keyPath);
  if (!found || !Array.isArray(arr)) {
    return {
      removed: false,
      reason: 'absent',
      note: `array ${displayPath(item.keyPath)} absent in ${item.path} — nothing to remove`,
    };
  }
  // NOTE (B3): this filters out EVERY entry equal to our value, so if the user
  // independently added an identical value we over-remove theirs too. Ownership is
  // by exact value with no per-entry marker, so the duplicates are indistinguishable;
  // accepted for the D3 array-element surface (identical-value collisions are rare
  // and the value is one we injected). No behaviour change.
  const filtered = (arr as JsonValue[]).filter(
    (v) => stableStringify(v) !== stableStringify(item.value),
  );
  if (filtered.length === arr.length) {
    return {
      removed: false,
      reason: 'absent',
      note: `array element ${item.key ?? ''} already absent — no-op`,
    };
  }
  // Rewrite the whole array (see injectArrayElement's note on the jsonc-parser
  // index-edit bug). Matching by value makes this order-independent.
  const next = applyEdits(base, modify(base, item.keyPath as JSONPath, filtered, {}));
  await applyFileMutation(paths, tx, 'remove', item, item.path, next);
  return { removed: true };
}

/** Read an owned keyed value from file text, dispatching on format. */
function readKeyed(text: string, item: ConfigKeysItem): { found: boolean; value: unknown } {
  return getAtPath(parseConfig(text, item), item.keyPath);
}

/** Produce file text with the owned keyed value removed, dispatching on format. */
function removeKeyedText(text: string, item: ConfigKeysItem): string {
  if (item.format === 'toml') {
    return removeKeyedTomlText(text, item);
  }
  const base = jsonBaseText(text);
  const out = applyEdits(base, modify(base, item.keyPath as JSONPath, undefined, {}));
  return pruneCreatedParents(out, item);
}

/**
 * After the owned leaf is removed, prune the ancestor levels this inject created
 * ({@link ConfigKeysItem.createdParents}) — deepest-first, and only while each is
 * still an empty object — so an inject→remove cycle is byte-identical (fix B1). We
 * stop at the first parent that is non-empty (the user added siblings) or that the
 * user owned, and never touch the document root.
 */
function pruneCreatedParents(text: string, item: ConfigKeysItem): string {
  let out = text;
  const created = item.createdParents ?? 0;
  for (let i = 0; i < created; i++) {
    const parentPath = item.keyPath.slice(0, item.keyPath.length - 1 - i);
    if (parentPath.length === 0) break; // never prune the document root
    const { found, value } = getAtPath(parseJsonConfig(out, item.path), parentPath);
    if (!found || value === null || typeof value !== 'object' || Array.isArray(value)) break;
    if (Object.keys(value as Record<string, unknown>).length !== 0) break; // user populated it
    out = applyEdits(out, modify(out, parentPath as JSONPath, undefined, {}));
  }
  return out;
}

// ---------------------------------------------------------------------------
// syncBack — drift detection + write-back (runs every pass, D3)
// ---------------------------------------------------------------------------

/**
 * Re-hash an owned key's current value and, if it drifted, write it back —
 * secret-flagged fields restored to their `${VAR}` placeholders, never the
 * current literal (D6). Returns the value the caller should persist to the
 * canonical store (`canonicalValue`) and the updated record (new hash). This runs
 * on **every** invocation so mid-session edits to injected config survive, and it
 * is what lets {@link removeKey} proceed after drift: the record's hash is brought
 * back into agreement with the file.
 *
 * A no-op (no journal mutation) when the value is unchanged or the key has
 * vanished. **Keyed** mode only carries drift; an **array-element**'s identity is
 * its exact value, so a changed value simply reads as absent (reported, never
 * rewritten).
 */
export async function syncBack(
  paths: Paths,
  tx: Transaction,
  item: ConfigKeysItem,
): Promise<SyncBackResult> {
  const text = await readText(item.path);

  if (item.mode === 'array-element') {
    const { found, value } = getAtPath(parseConfig(text, item), item.keyPath);
    const present =
      found &&
      Array.isArray(value) &&
      value.some((v) => stableStringify(v) === stableStringify(item.value));
    return present
      ? { drifted: false, item }
      : { drifted: false, item, note: `array element ${item.key ?? ''} absent — nothing to sync` };
  }

  const { found, value } = readKeyed(text, item);
  if (!found) {
    return {
      drifted: false,
      item,
      note: `config key ${item.key ?? displayPath(item.keyPath)} vanished from ${item.path}`,
    };
  }

  const current = value as JsonValue;
  if (hashValue(current) === item.hash) {
    return { drifted: false, item };
  }

  // Drift: restore secret-flagged subfields to placeholders, then write back and
  // re-hash so the file, the store value we return, and the record all agree.
  const canonical = restoreSecrets(current, item.secretFields);
  const updated: ConfigKeysItem = { ...item, hash: hashValue(canonical) };
  const next = writeKeyedValueText(text, item, canonical);
  await applyFileMutation(paths, tx, 'add', updated, item.path, next);
  return { drifted: true, currentValue: current, canonicalValue: canonical, item: updated };
}

/** Parse an owned item's file, dispatching on format. */
function parseConfig(text: string, item: ConfigKeysItem): unknown {
  if (item.format === 'toml') {
    return parseTomlConfig(text, item.path);
  }
  return parseJsonConfig(text, item.path);
}

/**
 * Deep-clone `value` and reset each secret-flagged subpath to its placeholder, so
 * a baked literal is never carried into the store (D6). Best-effort: a subpath
 * that no longer exists is skipped.
 */
function restoreSecrets(value: JsonValue, secretFields?: Record<string, string>): JsonValue {
  if (!secretFields || Object.keys(secretFields).length === 0) return value;
  const clone = structuredClone(value);
  for (const [dotted, placeholder] of Object.entries(secretFields)) {
    setAtDottedPath(clone, splitDotted(dotted), placeholder);
  }
  return clone;
}

/**
 * Split a dotted secret-field path into segments on UNescaped dots, unescaping
 * `\.` → `.` and `\\` → `\` — symmetric with {@link keyedDiscriminator}'s escaping,
 * so a real key name containing a dot can be addressed as `\.` without being split
 * into two segments (fix C2).
 */
export function splitDotted(dotted: string): string[] {
  const segments: string[] = [];
  let current = '';
  let escaped = false;
  for (const ch of dotted) {
    if (escaped) {
      current += ch;
      escaped = false;
    } else if (ch === '\\') {
      escaped = true;
    } else if (ch === '.') {
      segments.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (escaped) current += '\\'; // a trailing lone backslash is kept literal
  segments.push(current);
  return segments;
}

/**
 * Resolve a path segment to a valid ARRAY index, or `undefined` when `cur` is not an
 * array or the segment is not an in-bounds non-negative integer — so restore can
 * reach an array-nested placeholder (canonical MCP `args.<i>`), mirroring the
 * substitute side in `secrets.ts`.
 */
function arrayIndexSegment(cur: JsonValue, seg: string): number | undefined {
  if (!Array.isArray(cur) || !/^\d+$/.test(seg)) return undefined;
  const idx = Number(seg);
  return idx < cur.length ? idx : undefined;
}

/** Set `leaf` at a dotted subpath within an object OR array value; a missing segment is a no-op. */
function setAtDottedPath(root: JsonValue, path: string[], leaf: string): void {
  let cur: JsonValue = root;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i] as string;
    const idx = arrayIndexSegment(cur, seg);
    if (idx !== undefined) {
      cur = (cur as JsonValue[])[idx] as JsonValue;
      continue;
    }
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return;
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return;
    cur = (cur as { [k: string]: JsonValue })[seg] as JsonValue;
  }
  const last = path[path.length - 1] as string;
  const lastIdx = arrayIndexSegment(cur, last);
  if (lastIdx !== undefined) {
    (cur as JsonValue[])[lastIdx] = leaf;
    return;
  }
  if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return;
  (cur as { [k: string]: JsonValue })[last] = leaf;
}

// ---------------------------------------------------------------------------
// TOML keyed mechanism — append a marked [table]; remove by marker-splice, else
// fall back to a full parse when a harness reserialised and stripped the markers.
// ---------------------------------------------------------------------------

/** Parse TOML into a value; a syntax error surfaces as a {@link ConfigKeysError}. */
function parseTomlConfig(text: string, file: string): unknown {
  if (text.trim() === '') return {};
  try {
    return parseToml(text);
  } catch (err) {
    if (err instanceof TomlError) {
      throw new ConfigKeysError(`${file}: could not parse TOML config (${err.message})`, file);
    }
    throw err;
  }
}

function tomlBeginMarker(key: string): string {
  return `# >>> agentenv:config-key ${key} >>> managed by agentenv, do not edit`;
}

function tomlEndMarker(key: string): string {
  return `# <<< agentenv:config-key ${key} <<<`;
}

/** Wrap a value under its key path, e.g. `(['a','b'], v)` → `{ a: { b: v } }`. */
function wrapPath(keyPath: (string | number)[], value: JsonValue): { [k: string]: JsonValue } {
  const root: { [k: string]: JsonValue } = {};
  let cur = root;
  for (let i = 0; i < keyPath.length - 1; i++) {
    const seg = String(keyPath[i]);
    const child: { [k: string]: JsonValue } = {};
    cur[seg] = child;
    cur = child;
  }
  cur[String(keyPath[keyPath.length - 1])] = value;
  return root;
}

/**
 * Append the owned key as a whole marked `[table]` (format-preserving: the user's
 * existing TOML is untouched). Idempotent — any prior owned table for this key is
 * removed first, so re-injection/write-back replaces rather than duplicates.
 *
 * Parse-aware, mirroring {@link removeKeyedTomlText}: a marked block is stripped
 * textually, but after a harness reserialised the file our table survives
 * **unmarked** at `keyPath`. We own that path, so it too is removed (from the
 * parsed tree) before appending. Without this, a drift write-back would emit a
 * SECOND `[table]` beside the survivor — invalid TOML ("redefine an already
 * defined table") — and any baked secret literal in the survivor would never be
 * scrubbed (fix A1).
 */
function tomlInjectText(text: string, item: ConfigKeysItem, value: JsonValue): string {
  const key = item.key ?? displayPath(item.keyPath);
  // Preserve the original file's trailing-newline state so a marker-splice removal
  // round-trips byte-for-byte (fix C1). A fresh/empty file gets the conventional
  // trailing newline.
  const trailer = text === '' || text.endsWith('\n') ? '\n' : '';
  const stripped = tomlStripMarkedBlock(text, key).text;
  const base = removeOwnedTomlTableIfPresent(stripped, item);
  const body = stringifyToml(wrapPath(item.keyPath, value));
  const prefix = base === '' || base.endsWith('\n') ? base : `${base}\n`;
  return `${prefix}${tomlBeginMarker(key)}\n${body}${tomlEndMarker(key)}${trailer}`;
}

/**
 * If `keyPath` still resolves in `text` after marked blocks were stripped — an
 * unmarked table that a harness reserialisation left behind for a path we own —
 * delete it from the parsed tree and re-stringify, so the caller can append a
 * fresh marked block without redefining the table. A no-op (text returned
 * unchanged) when nothing resolves there, preserving the surgical marker path for
 * the common case. Sibling tables the user owns are carried through the parse.
 */
function removeOwnedTomlTableIfPresent(text: string, item: ConfigKeysItem): string {
  if (text.trim() === '') return text;
  const data = parseTomlConfig(text, item.path) as { [k: string]: unknown };
  if (!getAtPath(data, item.keyPath).found) return text;
  deleteAtPath(data, item.keyPath);
  return stringifyToml(data);
}

/**
 * Remove the owned TOML key. First tries a marker-splice (format-preserving for
 * the rest of the file). If the markers are gone — a harness reserialised the file
 * and stripped our comments — falls back to a full parse: delete the key path and
 * re-stringify, so ownership by key path still resolves.
 */
function removeKeyedTomlText(text: string, item: ConfigKeysItem): string {
  const key = item.key ?? displayPath(item.keyPath);
  const spliced = tomlStripMarkedBlock(text, key);
  if (spliced.changed) return spliced.text;

  const data = parseTomlConfig(text, item.path) as { [k: string]: unknown };
  deleteAtPath(data, item.keyPath);
  return stringifyToml(data);
}

/** Drop the marker-delimited block for `key`; report whether one was present. */
function tomlStripMarkedBlock(text: string, key: string): { text: string; changed: boolean } {
  const beginPrefix = `# >>> agentenv:config-key ${key} >>>`;
  const endPrefix = `# <<< agentenv:config-key ${key} <<<`;
  const out: string[] = [];
  let inside = false;
  let changed = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!inside && trimmed.startsWith(beginPrefix)) {
      inside = true;
      changed = true;
      continue;
    }
    if (inside) {
      // Drop every line of the block, including its end marker.
      if (trimmed.startsWith(endPrefix)) inside = false;
      continue;
    }
    out.push(line);
  }
  return { text: out.join('\n'), changed };
}

/** Delete the value at `keyPath` from a parsed object tree; a missing segment is a no-op. */
function deleteAtPath(root: { [k: string]: unknown }, keyPath: (string | number)[]): void {
  if (keyPath.length === 0) return;
  let cur: unknown = root;
  for (let i = 0; i < keyPath.length - 1; i++) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return;
    cur = (cur as { [k: string]: unknown })[String(keyPath[i])];
  }
  if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return;
  delete (cur as { [k: string]: unknown })[String(keyPath[keyPath.length - 1])];
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
