import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { effectiveGlobalEnvs } from '../engine.js';
import { capturePathIdentity } from '../path-identity.js';
import type { Paths } from '../paths.js';
import { readSessionRegistry } from '../session/registry.js';
import { readState } from '../state.js';
import { listEnvironments, readEnvConfig } from '../store.js';
import type {
  ContentCounts,
  EnvironmentCatalogPage,
  EnvironmentName,
  EnvironmentSummary,
  Revision,
} from '../ui/contract.js';

export type { EnvironmentCatalogPage } from '../ui/contract.js';

export const CATALOG_MAX_PAGE = 10_000;
export const CATALOG_MAX_PAGE_SIZE = 100;

export interface ListEnvironmentSummariesInput {
  paths: Paths;
  page: number;
  pageSize: number;
}

export class CatalogPaginationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogPaginationError';
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
  let text: string;
  try {
    text = await readFile(join(environment, 'mcp', 'servers.yaml'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  const parsed: unknown = parseYaml(text);
  if (parsed === null || parsed === undefined) return 0;
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The MCP server catalogue is malformed.');
  }
  return Object.keys(parsed).length;
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
  return createHash('sha256')
    .update(JSON.stringify(identity))
    .digest('base64url') as Revision;
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
