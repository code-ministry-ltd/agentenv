import { readFile } from 'node:fs/promises';
import type { CommandPlan, OperationState } from './command-plan.js';
import type { GlobalProjection } from './global-projection.js';
import type { MigrationState } from './migration-state.js';
import type { BackupRef } from './backups.js';
import { writeFileAtomic } from './fs-atomic.js';
import type { Paths } from './paths.js';
import { validateProjectionRecord, type ProjectionRecord } from './projection.js';
import { parseVersion } from './schema-version.js';
import type { SyncCandidate } from './sync-candidate.js';
import type { ViewGeneration } from './view-generation.js';

/**
 * The state.json schema version this CLI understands, as {major, minor}.
 *
 * state.json is machine-local (never synced), but the same machine may run
 * different CLI versions across an upgrade/downgrade, so we tolerate skew the
 * same way env.yaml does (design D4): unknown fields and a newer MINOR load; a
 * newer MAJOR is refused with an upgrade message, not a cryptic schema error.
 */
export const STATE_SCHEMA_VERSION = { major: 2, minor: 0 } as const;
export const STATE_SCHEMA_VERSION_STRING = `${STATE_SCHEMA_VERSION.major}.${STATE_SCHEMA_VERSION.minor}`;

/**
 * A problem with state.json: corrupt JSON, a non-object root, a bad/missing
 * version, or a state file newer than this CLI. Mirrors {@link
 * import('./env-config.js').EnvYamlError}; always names the file.
 */
export class StateError extends Error {
  constructor(
    message: string,
    readonly file: string,
  ) {
    super(message);
    this.name = 'StateError';
  }
}

/**
 * Fields every ownership record carries, whatever its surface. A materialised
 * item is owned by exactly one environment (design D5); deactivation consults
 * only these records — it never scans and guesses (D4).
 */
export interface ManifestItemBase {
  /** The mechanism verb, e.g. `symlink` | `file-block` | `config-key`. */
  action: string;
  /** Discriminant — the surface type: `dir-merge` | `file-block` | `config-keys`. */
  surface: string;
  /** The real (global mode) or private-root (session mode) path this item touches. */
  path: string;
  /**
   * Optional intra-path discriminator for surfaces where one path holds several
   * independently-owned items — a config-keys key path, or an array-element
   * value (D3). Unset for whole-file surfaces (dir-merge symlink, file-block).
   */
  key?: string;
  /** The environment that owns this item — exactly one (D5). */
  ownerEnv: string;
  /** Content hash for drift detection (D2/D3); absent where not applicable. */
  hash?: string;
  /** Reference to pre-mutation bytes so the mutation can be undone (D4). */
  backupRef?: BackupRef | null;
}

/**
 * Open registry of surface-specific record variants. Each surface mechanism
 * augments this interface **from its own module** via declaration merging, so
 * new surfaces are added without editing a central union (no conflict-prone
 * shared file). For example, task 1.3 will declare:
 *
 * ```ts
 * declare module './state.js' {
 *   interface ManifestItemVariants {
 *     'dir-merge': ManifestItemBase & {
 *       surface: 'dir-merge';
 *       action: 'symlink';
 *       target: string; // the store item the symlink points at (D1)
 *     };
 *   }
 * }
 * ```
 *
 * Empty here so 1.2 ships without the surface mechanisms; {@link ManifestItem}
 * falls back to the tolerant base record until variants are registered.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ManifestItemVariants {}

/**
 * A forward-compatible record: the known base fields plus any extra fields a
 * newer CLI (or an as-yet-unregistered surface) wrote. Lets state.json written
 * by a newer minor round-trip without data loss, mirroring env.yaml tolerance.
 */
export type UnknownManifestItem = ManifestItemBase & Record<string, unknown>;

/**
 * A stored ownership record: a registered surface variant when one matches
 * (narrow on `surface`), else the tolerant base record. Discriminated by
 * `surface`.
 */
export type ManifestItem = ManifestItemVariants[keyof ManifestItemVariants] | UnknownManifestItem;

/**
 * One write-ahead journal entry: an intended manifest change plus the
 * information needed to UNDO the mutation on a crash. `item`/`op` are applied to
 * the manifest at commit; `undo` (restore these bytes to this path — or delete
 * it, for an `absent` backup) rolls the effect back on recovery. See journal.ts.
 */
export interface JournalEntry {
  op: 'add' | 'remove';
  item: ManifestItem;
  undo: { path: string; backupRef: BackupRef };
}

/**
 * The parsed state manifest. Known fields are typed; unknown top-level fields
 * are preserved via the index signature (forward compatibility). `journal` is
 * non-null only while a transaction is in flight or awaiting recovery.
 */
export interface StateManifest {
  version: string;
  items: ManifestItem[];
  journal: JournalEntry[] | null;
  commands: CommandPlan[];
  generations: ViewGeneration[];
  globalProjections: GlobalProjection[];
  projectionRecords: ProjectionRecord[];
  candidates: SyncCandidate[];
  quarantine: QuarantineRecord[];
  migration: MigrationState | null;
  [key: string]: unknown;
}

export interface QuarantineRecord {
  schemaVersion: 2;
  id: string;
  kind: string;
  path: string;
  retainedPath: string;
  reason: string;
  createdAt: number;
  resolved: boolean;
}

function normaliseStateVersion(raw: unknown, file: string): string {
  const v = parseVersion(raw);
  if (!v || v.major < 1) {
    throw new StateError(
      `${file}: missing or invalid 'version' field (expected e.g. "1.0")`,
      file,
    );
  }
  if (v.major > STATE_SCHEMA_VERSION.major) {
    throw new StateError(
      `${file}: state newer than CLI — upgrade agentenv ` +
        `(state.json is v${v.major}.${v.minor}, this agentenv supports up to v${STATE_SCHEMA_VERSION.major}.x)`,
      file,
    );
  }
  return `${v.major}.${v.minor}`;
}

function coerceItems(raw: unknown, file: string): ManifestItem[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new StateError(`${file}: 'items' must be an array`, file);
  }
  for (const [index, entry] of raw.entries()) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new StateError(`${file}: every entry in 'items' must be an object`, file);
    }
    const item = entry as Record<string, unknown>;
    for (const field of ['action', 'surface', 'path', 'ownerEnv']) {
      if (typeof item[field] !== 'string' || item[field] === '') {
        throw new StateError(`${file}: items[${index}] requires '${field}'`, file);
      }
    }
  }
  return raw as ManifestItem[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, field: string, label: string): string | null {
  return typeof record[field] === 'string' && record[field] !== ''
    ? null
    : `${label} requires '${field}'`;
}

function coerceVersionedRecords<T>(
  raw: unknown,
  field: string,
  file: string,
  validate: (record: Record<string, unknown>, label: string) => string | null,
): T[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new StateError(`${file}: '${field}' must be an array`, file);
  for (let index = 0; index < raw.length; index++) {
    const record = raw[index];
    const label = `${field}[${index}]`;
    if (!isObject(record)) throw new StateError(`${file}: ${label} must be an object`, file);
    if (record.schemaVersion !== 2) {
      throw new StateError(`${file}: ${label}.schemaVersion must be 2`, file);
    }
    const invalid = validate(record, label);
    if (invalid) throw new StateError(`${file}: ${invalid}`, file);
  }
  return raw as T[];
}

const COMMAND_PHASES = new Set([
  'planned',
  'applying',
  'committed',
  'git-pending',
  'complete',
  'rolling-back',
  'rolled-back',
]);
const OPERATION_STATES = new Set<OperationState>(['pending', 'applying', 'applied', 'undoing', 'undone']);
const GENERATION_PHASES = new Set(['building', 'published', 'closing', 'sweeping', 'swept', 'quarantined', 'collected']);
const GLOBAL_PROJECTION_PHASES = new Set(['building', 'active', 'retiring', 'retired', 'reconciling', 'reconciled', 'quarantined', 'collected']);
const CANDIDATE_PHASES = new Set(['fetched', 'validating', 'approved', 'deferred', 'rejected', 'promoting', 'promoted', 'abandoned']);
const MIGRATION_PHASES = new Set(['planned', 'backing-up', 'backed-up', 'importing', 'imported', 'probing', 'opened', 'rolling-back', 'rolled-back']);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry !== '');
}

function validatePathIdentity(value: unknown): string | null {
  if (!isObject(value) || typeof value.kind !== 'string') return 'must be a path identity object';
  if (value.kind === 'absent') return null;
  if (value.kind === 'symlink') {
    return typeof value.target === 'string' ? null : 'symlink target must be a string';
  }
  if (value.kind === 'file' || value.kind === 'directory') {
    if (typeof value.digest !== 'string' || value.digest === '') return 'digest must be a string';
    if (!Number.isSafeInteger(value.mode) || (value.mode as number) < 0) {
      return 'mode must be a non-negative integer';
    }
    return null;
  }
  return `kind '${value.kind}' is invalid`;
}

function validateBackupRef(value: unknown): string | null {
  if (!isObject(value) || typeof value.kind !== 'string') return 'must be a backup reference';
  if (value.kind === 'absent') return null;
  if (value.kind === 'content') return requireString(value, 'hash', 'content backup');
  if (value.kind === 'directory') return requireString(value, 'id', 'directory backup');
  if (value.kind === 'symlink') {
    return typeof value.target === 'string' ? null : 'symlink backup target must be a string';
  }
  return `backup kind '${value.kind}' is invalid`;
}

function validateCommand(record: Record<string, unknown>, label: string): string | null {
  const required = requireString(record, 'transactionId', label) ?? requireString(record, 'kind', label);
  if (required) return required;
  if (record.gitRequired !== undefined && typeof record.gitRequired !== 'boolean') {
    return `${label}.gitRequired must be boolean`;
  }
  if (record.gitMessage !== undefined && typeof record.gitMessage !== 'string') {
    return `${label}.gitMessage must be string`;
  }
  if (record.gitSteps !== undefined) {
    if (!Array.isArray(record.gitSteps)) return `${label}.gitSteps must be an array`;
    const stepIds = new Set<string>();
    for (const step of record.gitSteps) {
      if (
        !isObject(step) ||
        requireString(step, 'id', `${label}.gitSteps`) ||
        requireString(step, 'message', `${label}.gitSteps`) ||
        !isNonEmptyStringArray(step.paths) ||
        stepIds.has(step.id as string)
      ) {
        return `${label}.gitSteps contains an invalid step`;
      }
      stepIds.add(step.id as string);
    }
  }
  if (!COMMAND_PHASES.has(record.phase as string)) return `${label}.phase is invalid`;
  if (typeof record.commitPoint !== 'boolean') return `${label}.commitPoint must be boolean`;
  if (!Array.isArray(record.operations)) return `${label}.operations must be an array`;
  for (const operation of record.operations) {
    if (
      !isObject(operation) ||
      typeof operation.id !== 'string' ||
      operation.id === '' ||
      typeof operation.kind !== 'string' ||
      operation.kind === ''
    ) {
      return `${label}.operations contains an invalid operation`;
    }
    if (!OPERATION_STATES.has(operation.state as OperationState)) {
      return `${label}.operations contains an invalid state`;
    }
    if (operation.path !== undefined && typeof operation.path !== 'string') {
      return `${label}.operations contains an invalid path`;
    }
    for (const field of ['preIdentity', 'postIdentity'] as const) {
      if (operation[field] === undefined) continue;
      const invalid = validatePathIdentity(operation[field]);
      if (invalid) return `${label}.operations ${field} ${invalid}`;
    }
    if (operation.undoRef !== undefined && typeof operation.undoRef !== 'string') {
      return `${label}.operations contains an invalid undoRef`;
    }
  }
  return null;
}

function validateGeneration(record: Record<string, unknown>, label: string): string | null {
  const required = requireString(record, 'id', label);
  if (required) return required;
  if (!GENERATION_PHASES.has(record.phase as string)) return `${label}.phase is invalid`;
  if (
    !isNonEmptyStringArray(record.envs) ||
    !isNonEmptyStringArray(record.reservations) ||
    !Array.isArray(record.leases)
  ) {
    return `${label} requires envs, reservations, and leases arrays`;
  }
  if (new Set(record.reservations).size !== record.reservations.length) {
    return `${label}.reservations contains duplicates`;
  }
  const leaseIds = new Set<string>();
  for (const lease of record.leases) {
    if (!isObject(lease) || requireString(lease, 'reservationId', `${label}.lease`)) {
      return `${label}.leases contains an invalid reservationId`;
    }
    if (
      !Number.isSafeInteger(lease.pid) ||
      (lease.pid as number) <= 0 ||
      !Number.isSafeInteger(lease.processGroupId) ||
      (lease.processGroupId as number) <= 0
    ) {
      return `${label}.lease pid and processGroupId must be positive integers`;
    }
    if (requireString(lease, 'processStart', `${label}.lease`)) {
      return `${label}.lease processStart is invalid`;
    }
    const reservationId = lease.reservationId as string;
    if (leaseIds.has(reservationId)) return `${label}.leases contains duplicate reservation ids`;
    leaseIds.add(reservationId);
  }
  if (record.inventory !== undefined) {
    if (!Array.isArray(record.inventory)) return `${label}.inventory must be an array`;
    for (const entry of record.inventory) {
      if (!isObject(entry)) return `${label}.inventory contains an invalid entry`;
      for (const field of ['surfaceId', 'storeKind', 'mechanism', 'path']) {
        if (requireString(entry, field, `${label}.inventory`)) {
          return `${label}.inventory requires ${field}`;
        }
      }
      if (
        typeof entry.baseline !== 'string' &&
        !isNonEmptyStringArray(entry.baseline)
      ) {
        return `${label}.inventory baseline must be a string or string array`;
      }
      if (entry.ownerEnv !== null && typeof entry.ownerEnv !== 'string') {
        return `${label}.inventory ownerEnv must be a string or null`;
      }
    }
  }
  return null;
}

function validateGlobalProjection(record: Record<string, unknown>, label: string): string | null {
  const required = requireString(record, 'id', label);
  if (required) return required;
  if (!GLOBAL_PROJECTION_PHASES.has(record.phase as string)) return `${label}.phase is invalid`;
  const baseline = validatePathIdentity(record.baseline);
  if (baseline) return `${label}.baseline ${baseline}`;
  const observed = validatePathIdentity(record.observed);
  if (observed) return `${label}.observed ${observed}`;
  if (record.canonicalBaseline !== undefined) {
    const canonical = validatePathIdentity(record.canonicalBaseline);
    if (canonical) return `${label}.canonicalBaseline ${canonical}`;
  }
  if (record.retirementSurfaceIdentity !== undefined) {
    const restored = validatePathIdentity(record.retirementSurfaceIdentity);
    if (restored) return `${label}.retirementSurfaceIdentity ${restored}`;
  }
  return null;
}

function validateCandidate(record: Record<string, unknown>, label: string): string | null {
  const required = requireString(record, 'id', label) ?? requireString(record, 'ref', label) ?? requireString(record, 'worktree', label);
  if (required) return required;
  if (!CANDIDATE_PHASES.has(record.phase as string)) return `${label}.phase is invalid`;
  if (!isNonEmptyStringArray(record.blockers) || !isNonEmptyStringArray(record.touchedCanonicalPaths)) {
    return `${label} requires blockers and touchedCanonicalPaths arrays`;
  }
  if (!isFiniteNumber(record.fetchedAt)) return `${label}.fetchedAt must be a number`;
  for (const field of ['reason', 'promotedRevision', 'expectedCanonicalRevision', 'candidateRevision']) {
    if (record[field] !== null && typeof record[field] !== 'string') {
      return `${label}.${field} must be a string or null`;
    }
  }
  return null;
}

function coerceMigration(raw: unknown, file: string): MigrationState | null {
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw)) throw new StateError(`${file}: 'migration' must be an object or null`, file);
  if (raw.schemaVersion !== 2) throw new StateError(`${file}: migration.schemaVersion must be 2`, file);
  if (requireString(raw, 'id', 'migration') || !MIGRATION_PHASES.has(raw.phase as string)) {
    throw new StateError(`${file}: migration id or phase is invalid`, file);
  }
  if (raw.gate !== 'closed' && raw.gate !== 'open') {
    throw new StateError(`${file}: migration.gate is invalid`, file);
  }
  if (raw.sourceFormat !== 'cm-v1' && raw.sourceFormat !== 'jj-v1') {
    throw new StateError(`${file}: migration.sourceFormat is invalid`, file);
  }
  if (typeof raw.commitPoint !== 'boolean') {
    throw new StateError(`${file}: migration.commitPoint must be boolean`, file);
  }
  if (raw.backupRef !== null && typeof raw.backupRef !== 'string') {
    throw new StateError(`${file}: migration.backupRef must be a string or null`, file);
  }
  if (raw.failure !== null && typeof raw.failure !== 'string') {
    throw new StateError(`${file}: migration.failure must be a string or null`, file);
  }
  return raw as unknown as MigrationState;
}

/**
 * Validate a persisted journal the same way {@link coerceItems} validates items:
 * every entry must be a well-formed `{op, item, undo}` record. A malformed entry
 * is rejected here with a clear {@link StateError} naming the file — before it
 * can reach `rollbackEntries` and throw an uncaught `TypeError`, which would
 * wedge recovery (a pending journal blocks {@link beginTransaction}).
 */
function coerceJournal(raw: unknown, file: string): JournalEntry[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) {
    throw new StateError(`${file}: 'journal' must be an array`, file);
  }
  for (const entry of raw) {
    if (!isObject(entry)) {
      throw new StateError(`${file}: every entry in 'journal' must be an object`, file);
    }
    if (entry.op !== 'add' && entry.op !== 'remove') {
      throw new StateError(`${file}: journal entry 'op' must be "add" or "remove"`, file);
    }
    if (!isObject(entry.item)) {
      throw new StateError(`${file}: journal entry 'item' must be an object`, file);
    }
    if (!isObject(entry.undo)) {
      throw new StateError(`${file}: journal entry 'undo' must be an object`, file);
    }
    if (typeof entry.undo.path !== 'string') {
      throw new StateError(`${file}: journal entry 'undo.path' must be a string`, file);
    }
    const invalidBackup = validateBackupRef(entry.undo.backupRef);
    if (invalidBackup) throw new StateError(`${file}: journal entry undo.backupRef ${invalidBackup}`, file);
  }
  return raw as JournalEntry[];
}

/** A fresh, empty manifest at the current schema version. */
export function emptyManifest(): StateManifest {
  return {
    version: STATE_SCHEMA_VERSION_STRING,
    items: [],
    journal: null,
    commands: [],
    generations: [],
    globalProjections: [],
    projectionRecords: [],
    candidates: [],
    quarantine: [],
    migration: null,
  };
}

/**
 * Read and validate state.json. A missing file is not an error — it yields a
 * fresh empty manifest. Throws {@link StateError} on corrupt JSON, a non-object
 * root, a missing/invalid version, or a state file from a newer MAJOR.
 *
 * Read-modify-write: `readState`/`writeState`/`recoverState` are not internally
 * serialised — callers MUST run them under {@link import('./lock.js').withLock}
 * (design D11) so two processes never interleave a read and a write.
 */
export async function readState(paths: Paths): Promise<StateManifest> {
  const file = paths.state;
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyManifest();
    throw err;
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new StateError(`${file}: corrupt state.json (${(err as Error).message})`, file);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new StateError(`${file}: expected a JSON object at the top level`, file);
  }

  const obj = data as Record<string, unknown>;
  const version = normaliseStateVersion(obj.version, file);
  const items = coerceItems(obj.items, file);
  const journal = coerceJournal(obj.journal, file);
  const commands = coerceVersionedRecords<CommandPlan>(obj.commands, 'commands', file, validateCommand);
  const generations = coerceVersionedRecords<ViewGeneration>(
    obj.generations,
    'generations',
    file,
    validateGeneration,
  );
  const globalProjections = coerceVersionedRecords<GlobalProjection>(
    obj.globalProjections,
    'globalProjections',
    file,
    validateGlobalProjection,
  );
  const projectionRecords = coerceVersionedRecords<ProjectionRecord>(
    obj.projectionRecords,
    'projectionRecords',
    file,
    (record, label) => {
      const invalid = validateProjectionRecord(record as unknown as ProjectionRecord);
      return invalid ? `${label}: ${invalid}` : null;
    },
  );
  const candidates = coerceVersionedRecords<SyncCandidate>(
    obj.candidates,
    'candidates',
    file,
    validateCandidate,
  );
  const quarantine = coerceVersionedRecords<QuarantineRecord>(
    obj.quarantine,
    'quarantine',
    file,
    (record, label) => {
      const required =
        requireString(record, 'id', label) ??
        requireString(record, 'kind', label) ??
        requireString(record, 'path', label) ??
        requireString(record, 'retainedPath', label) ??
        requireString(record, 'reason', label);
      if (required) return required;
      if (!isFiniteNumber(record.createdAt)) return `${label}.createdAt must be a number`;
      if (typeof record.resolved !== 'boolean') return `${label}.resolved must be boolean`;
      return null;
    },
  );
  const migration = coerceMigration(obj.migration, file);
  return {
    ...obj,
    version,
    items,
    journal,
    commands,
    generations,
    globalProjections,
    projectionRecords,
    candidates,
    quarantine,
    migration,
  };
}

/**
 * Write state.json atomically (temp + rename). The current CLI's schema version
 * is stamped (this CLI is now the writer); unknown top-level fields loaded from
 * a newer minor are preserved. An empty/absent journal is omitted from disk.
 *
 * Read-modify-write: run under {@link import('./lock.js').withLock} (design D11);
 * see {@link readState}.
 */
export async function writeState(paths: Paths, manifest: StateManifest): Promise<void> {
  const out: Record<string, unknown> = {
    ...manifest,
    version: STATE_SCHEMA_VERSION_STRING,
    items: manifest.items,
    commands: manifest.commands,
    generations: manifest.generations,
    globalProjections: manifest.globalProjections,
    projectionRecords: manifest.projectionRecords,
    candidates: manifest.candidates,
    quarantine: manifest.quarantine,
    migration: manifest.migration,
  };
  if (manifest.journal && manifest.journal.length > 0) {
    out.journal = manifest.journal;
  } else {
    delete out.journal;
  }
  await writeFileAtomic(paths.state, `${JSON.stringify(out, null, 2)}\n`);
}

/**
 * Stable identity of an ownership record: `surface` + `path` + optional intra-
 * path `key`. Two records with the same identity describe the same materialised
 * item; {@link addItem} upserts by it and {@link removeItem} matches by it.
 */
export function itemIdentity(item: ManifestItemBase): string {
  return `${item.surface}\0${item.path}\0${item.key ?? ''}`;
}

/** The first record that owns `path` (whole-file surfaces have at most one). */
export function findOwner(manifest: StateManifest, path: string): ManifestItem | undefined {
  return manifest.items.find((item) => item.path === path);
}

/**
 * Every record that owns `path`. More than one only for a shared file where
 * several config-keys are independently owned (D3); one or none otherwise.
 */
export function findOwners(manifest: StateManifest, path: string): ManifestItem[] {
  return manifest.items.filter((item) => item.path === path);
}

/** Every record owned by `ownerEnv` (e.g. to dematerialise an environment). */
export function findItemsByEnv(manifest: StateManifest, ownerEnv: string): ManifestItem[] {
  return manifest.items.filter((item) => item.ownerEnv === ownerEnv);
}

/**
 * Upsert an ownership record: replace an existing record with the same identity
 * ({@link itemIdentity}), else append. Idempotent across re-activations.
 */
export function addItem(manifest: StateManifest, item: ManifestItem): void {
  const id = itemIdentity(item);
  const at = manifest.items.findIndex((existing) => itemIdentity(existing) === id);
  if (at >= 0) {
    manifest.items[at] = item;
  } else {
    manifest.items.push(item);
  }
}

/**
 * Remove the record with the same identity as `item`. Returns whether one was
 * removed (a missing record is a no-op — safe for idempotent deactivation).
 */
export function removeItem(manifest: StateManifest, item: ManifestItemBase): boolean {
  const id = itemIdentity(item);
  const at = manifest.items.findIndex((existing) => itemIdentity(existing) === id);
  if (at < 0) return false;
  manifest.items.splice(at, 1);
  return true;
}
