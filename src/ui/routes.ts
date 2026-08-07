import type { IncomingMessage } from 'node:http';
import {
  CATALOG_MAX_PAGE,
  CATALOG_MAX_PAGE_SIZE,
  CatalogEnvironmentNameError,
  CatalogEnvironmentNotFoundError,
  CatalogPaginationError,
  CatalogStaleRevisionError,
  getEnvironmentInventory,
  listEnvironmentSummaries,
} from '../application/catalog.js';
import type { Paths } from '../paths.js';
import { API_ERROR_STATUS, type ApiErrorCode } from './contract.js';

export interface UiRouteResult {
  status: number;
  body: unknown;
}

export interface UiRouteDependencies {
  getEnvironmentInventory: typeof getEnvironmentInventory;
  listEnvironmentSummaries: typeof listEnvironmentSummaries;
}

export type UiRouteDependencyOverrides = Partial<UiRouteDependencies>;

const DEFAULT_ROUTE_DEPENDENCIES: UiRouteDependencies = {
  getEnvironmentInventory,
  listEnvironmentSummaries,
};

function errorResult(code: ApiErrorCode, message: string): UiRouteResult {
  return { status: API_ERROR_STATUS[code], body: { error: { code, message } } };
}

function boundedInteger(
  search: URLSearchParams,
  field: string,
  fallback: number,
  maximum: number,
): number {
  const values = search.getAll(field);
  if (values.length === 0) return fallback;
  if (values.length !== 1 || !/^\d+$/.test(values[0]!)) {
    throw new CatalogPaginationError(`${field} must be supplied once as an integer`);
  }
  const value = Number(values[0]);
  if (value < 1 || value > maximum) {
    throw new CatalogPaginationError(`${field} must be from 1 to ${maximum}`);
  }
  return value;
}

export async function handleUiRoute(
  request: IncomingMessage,
  url: URL,
  paths: Paths,
  dependencyOverrides: UiRouteDependencyOverrides = {},
): Promise<UiRouteResult | undefined> {
  const dependencies = { ...DEFAULT_ROUTE_DEPENDENCIES, ...dependencyOverrides };
  const inventoryMatch = /^\/api\/environments\/([^/]+)$/.exec(url.pathname);
  if (inventoryMatch !== null) {
    if (request.method !== 'GET') {
      return errorResult('METHOD_NOT_ALLOWED', 'The request method is not supported.');
    }
    if ([...url.searchParams.keys()].length > 0) {
      return errorResult('MALFORMED_REQUEST', 'The request query is malformed.');
    }
    let name: string;
    try {
      name = decodeURIComponent(inventoryMatch[1]!);
    } catch {
      return errorResult('MALFORMED_REQUEST', 'The environment name is malformed.');
    }
    try {
      return {
        status: 200,
        body: { data: await dependencies.getEnvironmentInventory({ paths, name }) },
      };
    } catch (error) {
      if (error instanceof CatalogEnvironmentNameError) {
        return errorResult('MALFORMED_REQUEST', 'The environment name is malformed.');
      }
      if (error instanceof CatalogEnvironmentNotFoundError) {
        return errorResult('NOT_FOUND', 'The environment was not found.');
      }
      if (error instanceof CatalogStaleRevisionError) {
        return errorResult(
          'STALE_REVISION',
          'The environment changed while its content was loading.',
        );
      }
      throw error;
    }
  }
  if (url.pathname !== '/api/environments') return undefined;
  if (request.method !== 'GET') {
    return errorResult('METHOD_NOT_ALLOWED', 'The request method is not supported.');
  }
  if ([...url.searchParams.keys()].some((key) => key !== 'page' && key !== 'pageSize')) {
    return errorResult('MALFORMED_REQUEST', 'The request query is malformed.');
  }
  try {
    const page = boundedInteger(url.searchParams, 'page', 1, CATALOG_MAX_PAGE);
    const pageSize = boundedInteger(
      url.searchParams,
      'pageSize',
      CATALOG_MAX_PAGE_SIZE,
      CATALOG_MAX_PAGE_SIZE,
    );
    return {
      status: 200,
      body: { data: await dependencies.listEnvironmentSummaries({ paths, page, pageSize }) },
    };
  } catch (error) {
    if (error instanceof CatalogPaginationError) {
      return errorResult('MALFORMED_REQUEST', 'The request query is malformed.');
    }
    throw error;
  }
}
