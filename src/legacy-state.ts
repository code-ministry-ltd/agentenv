import type { BackupRef } from './backups.js';
import { createMigrationState, type LegacyStateFormat } from './migration-state.js';
import type { Paths } from './paths.js';
import { emptyManifest, type ManifestItem, type StateManifest } from './state.js';

type JsonObject = Record<string, unknown>;

export interface LegacyCmState {
  format: 'cm-v1';
  raw: {
    items: ManifestItem[];
    globalStack?: string[];
  } & JsonObject;
}

export interface LegacyJjState {
  format: 'jj-v1';
  raw: {
    ownership: JjOwnership[];
    blocks: JjBlock[];
    configKeys: JjConfigKey[];
    globalActivations: JjGlobalActivation[];
    adoptions: JjAdoption[];
    approvedProjects: string[];
    inventories: JsonObject[];
    shadowing: JsonObject[];
  } & JsonObject;
}

export type LegacyState = LegacyCmState | LegacyJjState;

interface JjOwnership extends JsonObject {
  backupKind?: 'directory' | 'file' | 'symlink';
  backupRef?: string;
  env: string;
  hash: string;
  kind: 'copy' | 'symlink';
  path: string;
  source: string;
  surface: string;
  targetDirectoryCreated?: boolean;
}

interface JjBlock extends JsonObject {
  env: string;
  mode: 'import' | 'inline';
  sourceHash: string;
  sourceId: string;
  sourcePath: string;
  surface: string;
  target: string;
  targetExisted: boolean;
}

interface JjSecretReference extends JsonObject {
  path: (number | string)[];
  template: string;
}

interface JjConfigKey extends JsonObject {
  createdParents: (number | string)[][];
  env: string;
  format: 'jsonc' | 'toml';
  hash: string;
  id: string;
  mode: 'array-element' | 'keyed';
  path: (number | string)[];
  secretReferences?: JjSecretReference[];
  surface: string;
  target: string;
  targetExisted: boolean;
  value: unknown;
}

interface JjGlobalActivation extends JsonObject {
  adapterId: string;
  environments: string[];
}

interface JjAdoption extends JsonObject {
  environmentSubpath: 'agents' | 'commands' | 'skills';
  env: string;
  id: string;
  name: string;
  origin: 'global' | 'session';
  originalPath: string;
  storePath: string;
}

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function string(record: JsonObject, field: string, label: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value === '') throw new Error(`${label}.${field} must be a string`);
  return value;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string' && entry !== '')) {
    throw new Error(`${label} must be a string array`);
  }
  return value;
}

function records(value: unknown, label: string): JsonObject[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => object(entry, `${label}[${index}]`));
}

function pathSegments(value: unknown, label: string): (number | string)[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((segment) => typeof segment === 'string' || Number.isSafeInteger(segment))
  ) {
    throw new Error(`${label} must be a non-empty key path`);
  }
  return value as (number | string)[];
}

/** Strict read-only parser for the two reviewed and pinned v1 state formats. */
export function parseLegacyState(text: string, file: string): LegacyState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file}: corrupt legacy state (${(error as Error).message})`, { cause: error });
  }
  const raw = object(parsed, file);
  const version = raw.version;
  if (typeof version !== 'string' || Number.parseInt(version.split('.')[0] ?? '', 10) !== 1) {
    throw new Error(`${file}: not a pinned v1 state manifest`);
  }

  const cm = raw.items !== undefined;
  const jj = raw.ownership !== undefined;
  if (cm && jj) throw new Error(`${file}: state mixes CM and JJ v1 fields`);
  if (!cm && !jj) throw new Error(`${file}: cannot identify the pinned v1 state format`);

  if (cm) return parseCm(raw, file);
  return parseJj(raw, file);
}

function parseCm(raw: JsonObject, file: string): LegacyCmState {
  const journal = raw.journal;
  if (journal !== undefined && journal !== null) {
    if (!Array.isArray(journal)) throw new Error(`${file}: CM v1 journal must be an array or null`);
    if (journal.length > 0) {
      throw new Error(`${file}: unfinished CM v1 journal; repair it with the pinned CM v1 CLI before migration`);
    }
  }
  const items = records(raw.items, `${file}: items`);
  for (const [index, item] of items.entries()) {
    const label = `${file}: items[${index}]`;
    for (const field of ['surface', 'action', 'path', 'ownerEnv']) string(item, field, label);
  }
  const globalStack = raw.globalStack === undefined ? undefined : strings(raw.globalStack, `${file}: globalStack`);
  return { format: 'cm-v1', raw: { ...raw, items: items as ManifestItem[], ...(globalStack ? { globalStack } : {}) } };
}

function parseJj(raw: JsonObject, file: string): LegacyJjState {
  const journal = records(raw.journal, `${file}: journal`);
  if (journal.length > 0) {
    throw new Error(`${file}: unfinished JJ v1 journal; repair it with the pinned JJ v1 CLI before migration`);
  }

  const ownership = records(raw.ownership, `${file}: ownership`).map((entry, index) => {
    const label = `${file}: ownership[${index}]`;
    for (const field of ['env', 'hash', 'path', 'source', 'surface']) string(entry, field, label);
    if (entry.kind !== 'copy' && entry.kind !== 'symlink') throw new Error(`${label}.kind is invalid`);
    if (
      entry.backupKind !== undefined &&
      entry.backupKind !== 'directory' &&
      entry.backupKind !== 'file' &&
      entry.backupKind !== 'symlink'
    ) {
      throw new Error(`${label}.backupKind is invalid`);
    }
    if (entry.backupRef !== undefined && typeof entry.backupRef !== 'string') {
      throw new Error(`${label}.backupRef must be a string`);
    }
    return entry as JjOwnership;
  });

  const blocks = records(raw.blocks, `${file}: blocks`).map((entry, index) => {
    const label = `${file}: blocks[${index}]`;
    for (const field of ['env', 'sourceHash', 'sourceId', 'sourcePath', 'surface', 'target']) {
      string(entry, field, label);
    }
    if (entry.mode !== 'import' && entry.mode !== 'inline') throw new Error(`${label}.mode is invalid`);
    if (typeof entry.targetExisted !== 'boolean') throw new Error(`${label}.targetExisted must be boolean`);
    return entry as JjBlock;
  });

  const configKeys = records(raw.configKeys, `${file}: configKeys`).map((entry, index) => {
    const label = `${file}: configKeys[${index}]`;
    for (const field of ['env', 'hash', 'id', 'surface', 'target']) string(entry, field, label);
    if (entry.format !== 'jsonc' && entry.format !== 'toml') throw new Error(`${label}.format is invalid`);
    if (entry.mode !== 'array-element' && entry.mode !== 'keyed') throw new Error(`${label}.mode is invalid`);
    entry.path = pathSegments(entry.path, `${label}.path`);
    if (!Array.isArray(entry.createdParents)) throw new Error(`${label}.createdParents must be an array`);
    for (const [parentIndex, parent] of entry.createdParents.entries()) {
      pathSegments(parent, `${label}.createdParents[${parentIndex}]`);
    }
    if (typeof entry.targetExisted !== 'boolean') throw new Error(`${label}.targetExisted must be boolean`);
    if (entry.secretReferences !== undefined) {
      entry.secretReferences = records(entry.secretReferences, `${label}.secretReferences`).map((reference, refIndex) => {
        reference.path = pathSegments(reference.path, `${label}.secretReferences[${refIndex}].path`);
        string(reference, 'template', `${label}.secretReferences[${refIndex}]`);
        return reference;
      });
    }
    return entry as JjConfigKey;
  });

  const globalActivations = records(raw.globalActivations, `${file}: globalActivations`).map((entry, index) => {
    const label = `${file}: globalActivations[${index}]`;
    string(entry, 'adapterId', label);
    entry.environments = strings(entry.environments, `${label}.environments`);
    return entry as JjGlobalActivation;
  });
  const adoptions = records(raw.adoptions, `${file}: adoptions`).map((entry, index) => {
    const label = `${file}: adoptions[${index}]`;
    for (const field of ['env', 'id', 'name', 'originalPath', 'storePath']) string(entry, field, label);
    if (!['agents', 'commands', 'skills'].includes(entry.environmentSubpath as string)) {
      throw new Error(`${label}.environmentSubpath is invalid`);
    }
    if (entry.origin !== 'global' && entry.origin !== 'session') throw new Error(`${label}.origin is invalid`);
    return entry as JjAdoption;
  });
  const approvedProjects = raw.approvedProjects === undefined
    ? []
    : strings(raw.approvedProjects, `${file}: approvedProjects`);

  return {
    format: 'jj-v1',
    raw: {
      ...raw,
      ownership,
      blocks,
      configKeys,
      globalActivations,
      adoptions,
      approvedProjects,
      inventories: records(raw.inventories, `${file}: inventories`),
      shadowing: records(raw.shadowing, `${file}: shadowing`),
    },
  };
}

function jjBackup(record: JjOwnership): BackupRef {
  if (record.backupKind === 'file' && record.backupRef) {
    return { kind: 'content', hash: record.backupRef };
  }
  if (record.backupKind === 'directory' && record.backupRef) {
    return { kind: 'directory', id: record.backupRef };
  }
  if (record.backupKind === 'symlink' && record.backupRef !== undefined) {
    return { kind: 'symlink', target: record.backupRef };
  }
  return { kind: 'absent' };
}

function escapedPath(path: readonly (number | string)[]): string {
  return path
    .map((segment, index) => {
      if (typeof segment === 'number') return `[${segment}]`;
      const escaped = segment.replace(/\\/g, '\\\\').replace(/\./g, '\\.');
      return index === 0 ? escaped : `.${escaped}`;
    })
    .join('');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as JsonObject).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
}

function translateJj(source: LegacyJjState): ManifestItem[] {
  const items: ManifestItem[] = source.raw.ownership.map((record) => ({
    surface: 'dir-merge',
    action: record.kind,
    path: record.path,
    target: record.source,
    ownerEnv: record.env,
    hash: record.hash,
    backupRef: jjBackup(record),
    legacySurfaceId: record.surface,
  }));

  const groupedBlocks = new Map<string, JjBlock[]>();
  for (const block of source.raw.blocks) {
    const key = JSON.stringify([block.target, block.env, block.mode]);
    const group = groupedBlocks.get(key);
    if (group) group.push(block);
    else groupedBlocks.set(key, [block]);
  }
  for (const blocks of groupedBlocks.values()) {
    const first = blocks[0]!;
    items.push({
      surface: 'file-block',
      action: 'file-block',
      path: first.target,
      key: first.env,
      ownerEnv: first.env,
      mode: first.mode,
      subBlocks: blocks.map((block) => ({
        source: block.sourceId,
        storePath: block.sourcePath,
        ...(block.mode === 'inline' ? { hash: block.sourceHash } : {}),
        legacyOpenMarker: block.openMarker,
        legacyCloseMarker: block.closeMarker,
      })),
      backupRef: null,
      legacySurfaceId: first.surface,
    });
  }

  for (const record of source.raw.configKeys) {
    const keyPath = [...record.path];
    const key = record.mode === 'array-element'
      ? `${escapedPath(keyPath)}[]=${stableStringify(record.value)}`
      : escapedPath(keyPath);
    const secretFields = Object.fromEntries(
      (record.secretReferences ?? []).map((reference) => [escapedPath(reference.path), reference.template]),
    );
    items.push({
      surface: 'config-keys',
      action: 'config-key',
      path: record.target,
      key,
      ownerEnv: record.env,
      mode: record.mode,
      format: record.format,
      keyPath,
      value: record.value,
      hash: record.hash,
      createdParents: record.createdParents.length,
      ...(!record.targetExisted ? { createdFile: true } : {}),
      ...(Object.keys(secretFields).length > 0 ? { secretFields } : {}),
      legacySurfaceId: record.surface,
      legacyMarker: record.marker,
    });
  }

  for (const adoption of source.raw.adoptions) {
    const match = items.find(
      (item) =>
        item.surface === 'dir-merge' &&
        item.ownerEnv === adoption.env &&
        (item as { target?: unknown }).target === adoption.storePath,
    );
    if (match) {
      Object.assign(match, {
        adopted: true,
        origin: adoption.origin,
        originalPath: adoption.originalPath,
      });
    }
  }
  return items;
}

/** Translate a parsed v1 manifest into schema 2 without touching the filesystem. */
export function importLegacyState(
  source: LegacyState,
  _paths: Paths,
  migrationId: string,
): StateManifest {
  const manifest = emptyManifest();
  const migration = createMigrationState(migrationId, source.format as LegacyStateFormat);
  manifest.migration = {
    ...migration,
    phase: 'importing',
    backupRef: 'migration-wal:pending',
  };
  if (source.format === 'cm-v1') {
    manifest.items = structuredClone(source.raw.items);
    if (source.raw.globalStack) manifest.globalStack = [...source.raw.globalStack];
    return manifest;
  }

  manifest.items = translateJj(source);
  const globalStack: string[] = [];
  for (const activation of source.raw.globalActivations) {
    for (const environment of activation.environments) {
      if (!globalStack.includes(environment)) globalStack.push(environment);
    }
  }
  manifest.globalStack = globalStack;
  manifest.legacy = {
    sourceFormat: source.format,
    approvedProjects: [...source.raw.approvedProjects],
    inventories: structuredClone(source.raw.inventories),
    shadowing: structuredClone(source.raw.shadowing),
  };
  return manifest;
}
