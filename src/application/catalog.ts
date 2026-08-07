import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import {
  lstat,
  open,
  readdir,
  readFile,
  type FileHandle,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseFrontmatter } from '../content-items.js';
import type { SkillSourceRecord } from '../env-config.js';
import { effectiveGlobalEnvs } from '../engine.js';
import {
  capturePathIdentity,
  identitiesEqual,
  type PathIdentity,
} from '../path-identity.js';
import type { Paths } from '../paths.js';
import { readSessionRegistry } from '../session/registry.js';
import { readState } from '../state.js';
import {
  listEnvironments,
  readEnvConfig,
  validateEnvName,
} from '../store.js';
import type {
  ContentItem,
  ContentCounts,
  EnvironmentCatalogPage,
  EnvironmentInventory,
  EnvironmentName,
  EnvironmentSummary,
  Revision,
  SkillSource,
} from '../ui/contract.js';

export type { EnvironmentCatalogPage, EnvironmentInventory } from '../ui/contract.js';

export const CATALOG_MAX_PAGE = 10_000;
export const CATALOG_MAX_PAGE_SIZE = 100;

export interface ListEnvironmentSummariesInput {
  paths: Paths;
  page: number;
  pageSize: number;
}

export interface GetEnvironmentInventoryInput {
  paths: Paths;
  name: string;
}

export interface EnvironmentInventoryDependencies {
  capturePathIdentity(path: string): Promise<PathIdentity>;
  mcpFileSystem?: CanonicalMcpFileSystem;
}

export interface CanonicalMcpFileSystem {
  open(path: string, flags: number): Promise<FileHandle>;
  lstat(path: string, options: { bigint: true }): Promise<BigIntStats>;
}

const DEFAULT_INVENTORY_DEPENDENCIES: EnvironmentInventoryDependencies = {
  capturePathIdentity,
};

const DEFAULT_MCP_FILE_SYSTEM: CanonicalMcpFileSystem = { open, lstat };

export class CatalogPaginationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogPaginationError';
  }
}

export class CatalogEnvironmentNameError extends Error {
  constructor() {
    super('The environment name is invalid.');
    this.name = 'CatalogEnvironmentNameError';
  }
}

export class CatalogEnvironmentNotFoundError extends Error {
  constructor() {
    super('The environment was not found.');
    this.name = 'CatalogEnvironmentNotFoundError';
  }
}

export class CatalogStaleRevisionError extends Error {
  constructor() {
    super('The environment changed while its inventory was being assembled.');
    this.name = 'CatalogStaleRevisionError';
  }
}

export class CatalogMcpSourceError extends Error {
  constructor() {
    super('The MCP server catalogue is not a readable regular file.');
    this.name = 'CatalogMcpSourceError';
  }
}

function validatePagination(page: number, pageSize: number): void {
  if (!Number.isInteger(page) || page < 1 || page > CATALOG_MAX_PAGE) {
    throw new CatalogPaginationError(`page must be an integer from 1 to ${CATALOG_MAX_PAGE}`);
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > CATALOG_MAX_PAGE_SIZE) {
    throw new CatalogPaginationError(
      `pageSize must be an integer from 1 to ${CATALOG_MAX_PAGE_SIZE}`,
    );
  }
}

async function countEntries(
  directory: string,
  include: (entry: { isDirectory(): boolean; isFile(): boolean; name: string }) => boolean,
): Promise<number> {
  try {
    return (await readdir(directory, { withFileTypes: true })).filter(include).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

async function countMcpServers(environment: string): Promise<number> {
  return Object.keys((await readMcpServers(environment)).servers).length;
}

interface McpServerCatalogue {
  servers: Record<string, unknown>;
  identity: PathIdentity;
}

async function readCanonicalMcpFile(
  path: string,
  fileSystem?: CanonicalMcpFileSystem,
): Promise<{
  bytes: Buffer;
  identity: Extract<PathIdentity, { kind: 'file' }>;
} | undefined> {
  const fs = fileSystem ?? DEFAULT_MCP_FILE_SYSTEM;
  let handle;
  try {
    handle = await fs.open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        await fs.lstat(path, { bigint: true });
      } catch (observed) {
        if ((observed as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw new CatalogMcpSourceError();
      }
      throw new CatalogStaleRevisionError();
    }
    throw new CatalogMcpSourceError();
  }

  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new CatalogMcpSourceError();
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!descriptorStatsEqual(before, after)) throw new CatalogStaleRevisionError();
    const identity = {
      kind: 'file',
      digest: createHash('sha256').update(bytes).digest('hex'),
      mode: Number(after.mode & 0o7777n),
    } as const;
    let current: BigIntStats;
    try {
      current = await fs.lstat(path, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new CatalogStaleRevisionError();
      }
      throw new CatalogMcpSourceError();
    }
    if (!currentPathMatchesDescriptor(current, after)) {
      throw new CatalogStaleRevisionError();
    }
    return { bytes, identity };
  } catch (error) {
    if (
      error instanceof CatalogMcpSourceError ||
      error instanceof CatalogStaleRevisionError
    ) {
      throw error;
    }
    throw new CatalogMcpSourceError();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function descriptorStatsEqual(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.isFile() &&
    after.isFile() &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

function currentPathMatchesDescriptor(current: BigIntStats, descriptor: BigIntStats): boolean {
  return (
    current.isFile() &&
    current.dev === descriptor.dev &&
    current.ino === descriptor.ino &&
    current.mode === descriptor.mode &&
    current.size === descriptor.size &&
    current.mtimeNs === descriptor.mtimeNs &&
    current.ctimeNs === descriptor.ctimeNs
  );
}

async function readMcpServers(
  environment: string,
  fileSystem?: CanonicalMcpFileSystem,
): Promise<McpServerCatalogue> {
  const source = await readCanonicalMcpFile(
    join(environment, 'mcp', 'servers.yaml'),
    fileSystem,
  );
  if (source === undefined) return { servers: {}, identity: { kind: 'absent' } };
  const parsed: unknown = parseYaml(source.bytes.toString('utf8'));
  if (parsed === null || parsed === undefined) return { servers: {}, identity: source.identity };
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The MCP server catalogue is malformed.');
  }
  return { servers: parsed as Record<string, unknown>, identity: source.identity };
}

async function contentCounts(environment: string): Promise<ContentCounts> {
  const markdown = (entry: { isFile(): boolean; name: string }): boolean =>
    entry.isFile() && entry.name.endsWith('.md');
  const [skill, instruction, mcp, agent, command] = await Promise.all([
    countEntries(join(environment, 'skills'), (entry) => entry.isDirectory()),
    countEntries(join(environment, 'instructions'), markdown),
    countMcpServers(environment),
    countEntries(join(environment, 'agents'), markdown),
    countEntries(join(environment, 'commands'), markdown),
  ]);
  return { skill, instruction, mcp, agent, command };
}

async function opaqueRevision(environment: string): Promise<Revision> {
  const identity = await capturePathIdentity(environment);
  return opaqueValue(identity);
}

function opaqueValue(value: unknown): Revision {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('base64url') as Revision;
}

function isRepositoryShorthand(repository: string): boolean {
  const segments = repository.split('/');
  return segments.length === 2 && segments.every((segment) =>
    segment !== '.' &&
    segment !== '..' &&
    /^[A-Za-z0-9._-]+$/.test(segment)
  );
}

function safeRepository(raw: string): string {
  const repository = raw.trim();
  if (repository === '' || isAbsolute(repository) || /^file:/i.test(repository)) {
    return 'Local repository';
  }
  if (isRepositoryShorthand(repository)) return repository;
  try {
    const url = new URL(repository);
    if (!['http:', 'https:', 'ssh:'].includes(url.protocol)) return 'Remote repository';
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return 'Remote repository';
  }
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function safeRepositoryPath(raw: string): string {
  const path = raw.trim();
  if (path === '') return '.';
  const segments = path.split('/');
  if (
    isAbsolute(path) ||
    path.includes('\\') ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
    hasControlCharacters(path)
  ) {
    return 'Unavailable';
  }
  return path;
}

function safeRef(raw: string): string | undefined {
  const ref = raw.trim();
  if (
    ref === '' ||
    ref.length > 200 ||
    isAbsolute(ref) ||
    ref.includes('\\') ||
    ref.includes('://') ||
    ref.includes('@{') ||
    /\s/.test(ref) ||
    hasControlCharacters(ref)
  ) {
    return undefined;
  }
  return ref;
}

function safeSkillSource(source: SkillSourceRecord): SkillSource {
  const safe: SkillSource = {
    repository: safeRepository(source.repo),
    path: safeRepositoryPath(source.path),
    shortCommit: /^[0-9a-f]{7,64}$/i.test(source.commit)
      ? source.commit.slice(0, 7)
      : 'Unknown',
  };
  const ref = safeRef(source.ref);
  if (ref !== undefined) safe.ref = ref;
  return safe;
}

export async function listEnvironmentSummaries(
  input: ListEnvironmentSummariesInput,
): Promise<EnvironmentCatalogPage> {
  validatePagination(input.page, input.pageSize);
  const [names, manifest, sessions] = await Promise.all([
    listEnvironments(input.paths),
    readState(input.paths),
    readSessionRegistry(input.paths),
  ]);
  const active = new Set([
    ...effectiveGlobalEnvs(manifest),
    ...sessions.bindings.flatMap((binding) => binding.envs),
  ]);
  const totalItems = names.length;
  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / input.pageSize);
  const start = (input.page - 1) * input.pageSize;
  const selected = names.slice(start, start + input.pageSize);
  const items = await Promise.all(selected.map(async (name): Promise<EnvironmentSummary> => {
    const environment = input.paths.envDir(name);
    const [config, counts, revision] = await Promise.all([
      readEnvConfig(input.paths, name),
      contentCounts(environment),
      opaqueRevision(environment),
    ]);
    return {
      name: name as EnvironmentName,
      description: config.description,
      active: active.has(name),
      counts,
      revision,
    };
  }));
  return {
    items,
    page: { page: input.page, pageSize: input.pageSize, totalItems, totalPages },
  };
}

async function namedEntries(
  directory: string,
  include: (entry: { isDirectory(): boolean; isFile(): boolean; name: string }) => boolean,
): Promise<readonly { name: string; path: string }[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter(include)
      .map((entry) => ({ name: entry.name, path: join(directory, entry.name) }))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function skillDescription(skillDirectory: string): Promise<string | undefined> {
  try {
    const frontmatter = parseFrontmatter(await readFile(join(skillDirectory, 'SKILL.md'), 'utf8'));
    return typeof frontmatter?.description === 'string' && frontmatter.description.trim() !== ''
      ? frontmatter.description.trim()
      : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function readSkills(
  environment: string,
  sources: Readonly<Record<string, SkillSourceRecord>>,
  captureIdentity: EnvironmentInventoryDependencies['capturePathIdentity'],
): Promise<readonly ContentItem[]> {
  const entries = await namedEntries(
    join(environment, 'skills'),
    (entry) => entry.isDirectory(),
  );
  return await Promise.all(entries.map(async (entry): Promise<ContentItem> => {
    const description = await skillDescription(entry.path);
    return {
      kind: 'skill',
      name: entry.name as ContentItem['name'],
      revision: opaqueValue(await captureIdentity(entry.path)),
      ...(description === undefined ? {} : { description }),
      ...(sources[entry.name] === undefined ? {} : { source: safeSkillSource(sources[entry.name]!) }),
    };
  }));
}

async function readMarkdownItems(
  environment: string,
  directory: 'instructions' | 'agents' | 'commands',
  captureIdentity: EnvironmentInventoryDependencies['capturePathIdentity'],
): Promise<readonly ContentItem[]> {
  const entries = await namedEntries(
    join(environment, directory),
    (entry) => entry.isFile() && entry.name.endsWith('.md'),
  );
  return await Promise.all(entries.map(async (entry): Promise<ContentItem> => {
    const name = entry.name.slice(0, -3) as ContentItem['name'];
    const revision = opaqueValue(await captureIdentity(entry.path));
    if (directory === 'instructions') {
      return name === 'base'
        ? { kind: 'instruction', name, revision, scope: 'base' }
        : { kind: 'instruction', name, revision, scope: 'harness', harness: name };
    }
    return directory === 'agents'
      ? { kind: 'agent', name, revision }
      : { kind: 'command', name, revision };
  }));
}

async function readMcpItems(
  environment: string,
  fileSystem?: CanonicalMcpFileSystem,
): Promise<readonly ContentItem[]> {
  const { servers, identity: canonicalIdentity } = await readMcpServers(environment, fileSystem);
  return Object.entries(servers)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, definition]): ContentItem => {
      const record = typeof definition === 'object' && definition !== null && !Array.isArray(definition)
        ? definition as Record<string, unknown>
        : {};
      const declared = record.transport ?? record.type;
      const transport = declared === 'stdio' || declared === 'http' || declared === 'sse'
        ? declared
        : 'unknown';
      return {
        kind: 'mcp',
        name: name as ContentItem['name'],
        revision: opaqueValue({ canonicalIdentity, name }),
        transport,
      };
    });
}

function countsFor(items: readonly ContentItem[]): ContentCounts {
  const counts: ContentCounts = { skill: 0, instruction: 0, mcp: 0, agent: 0, command: 0 };
  for (const item of items) counts[item.kind] += 1;
  return counts;
}

export async function getEnvironmentInventory(
  input: GetEnvironmentInventoryInput,
  dependencies: EnvironmentInventoryDependencies = DEFAULT_INVENTORY_DEPENDENCIES,
): Promise<EnvironmentInventory> {
  if (validateEnvName(input.name) !== null) throw new CatalogEnvironmentNameError();
  const environment = input.paths.envDir(input.name);
  const before = await dependencies.capturePathIdentity(environment);
  if (before.kind !== 'directory') {
    throw new CatalogEnvironmentNotFoundError();
  }
  try {
    const [config, manifest, sessions] = await Promise.all([
      readEnvConfig(input.paths, input.name),
      readState(input.paths),
      readSessionRegistry(input.paths),
    ]);
    const items = (await Promise.all([
      readSkills(environment, config.sources ?? {}, dependencies.capturePathIdentity),
      readMarkdownItems(environment, 'instructions', dependencies.capturePathIdentity),
      readMcpItems(environment, dependencies.mcpFileSystem),
      readMarkdownItems(environment, 'agents', dependencies.capturePathIdentity),
      readMarkdownItems(environment, 'commands', dependencies.capturePathIdentity),
    ])).flat();
    const active = new Set([
      ...effectiveGlobalEnvs(manifest),
      ...sessions.bindings.flatMap((binding) => binding.envs),
    ]);
    const inventory: EnvironmentInventory = {
      name: input.name as EnvironmentName,
      description: config.description,
      active: active.has(input.name),
      counts: countsFor(items),
      revision: opaqueValue(before),
      items,
    };
    const after = await dependencies.capturePathIdentity(environment);
    if (!identitiesEqual(before, after)) throw new CatalogStaleRevisionError();
    return inventory;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CatalogEnvironmentNotFoundError();
    }
    throw error;
  }
}
