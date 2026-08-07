import type { IncomingMessage } from 'node:http';
import {
  cloneEnvironment,
  createEnvironment,
  type EnvironmentLifecycleResult,
} from '../application/environment-lifecycle.js';
import type { EnvironmentLifecycleRuntime } from '../application/environment-lifecycle-runtime.js';
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
import { validateEnvName } from '../store.js';
import {
  API_ERROR_STATUS,
  UI_ENVIRONMENT_DESCRIPTION_MAX_LENGTH,
  type ApiErrorCode,
  type ApiErrorDetails,
  type EnvironmentLifecycleRequest,
  type EnvironmentLifecycleSuccess,
  type EnvironmentName,
} from './contract.js';
import { createUiEnvironmentLifecycleRuntime } from './environment-lifecycle-runtime.js';

export interface UiRouteResult {
  status: number;
  body: unknown;
}

export interface UiRouteDependencies {
  cloneEnvironment: typeof cloneEnvironment;
  createEnvironment: typeof createEnvironment;
  createEnvironmentLifecycleRuntime(paths: Paths): EnvironmentLifecycleRuntime;
  getEnvironmentInventory: typeof getEnvironmentInventory;
  listEnvironmentSummaries: typeof listEnvironmentSummaries;
}

export type UiRouteDependencyOverrides = Partial<UiRouteDependencies>;

const DEFAULT_ROUTE_DEPENDENCIES: UiRouteDependencies = {
  cloneEnvironment,
  createEnvironment,
  createEnvironmentLifecycleRuntime: (paths) =>
    createUiEnvironmentLifecycleRuntime({ paths, env: process.env }),
  getEnvironmentInventory,
  listEnvironmentSummaries,
};

function errorResult(
  code: ApiErrorCode,
  message: string,
  details?: ApiErrorDetails,
): UiRouteResult {
  return {
    status: API_ERROR_STATUS[code],
    body: { error: { code, message, ...(details === undefined ? {} : { details }) } },
  };
}

type LifecycleRequestParseResult =
  | { ok: true; request: EnvironmentLifecycleRequest }
  | { ok: false; result: UiRouteResult };

function malformedLifecycleRequest(): LifecycleRequestParseResult {
  return {
    ok: false,
    result: errorResult('MALFORMED_REQUEST', 'The environment request is malformed.'),
  };
}

function lifecycleValidation(field: 'name' | 'source' | 'description'): LifecycleRequestParseResult {
  const message = field === 'description'
    ? `Description must be at most ${UI_ENVIRONMENT_DESCRIPTION_MAX_LENGTH} characters.`
    : `Enter a valid exact environment ${field}.`;
  return {
    ok: false,
    result: errorResult('VALIDATION_FAILED', 'The environment request is invalid.', {
      kind: 'validation',
      issues: [{ path: field, message }],
    }),
  };
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  return actual.length === allowed.length &&
    actual.every((key, index) => key === expected[index]);
}

function pendingRecoveryDetails(
  transactionId: string,
  environmentPublished: boolean,
): ApiErrorDetails {
  return {
    kind: 'pending-recovery',
    ...(/^[A-Za-z0-9_-]{1,200}$/.test(transactionId) ? { commandId: transactionId } : {}),
    ...(environmentPublished ? { publication: 'environment-published' as const } : {}),
  };
}

function parseLifecycleRequest(
  value: Record<string, unknown> | undefined,
): LifecycleRequestParseResult {
  if (value === undefined || (value.operation !== 'create' && value.operation !== 'clone')) {
    return malformedLifecycleRequest();
  }
  if (value.operation === 'create') {
    const allowed = value.description === undefined
      ? ['name', 'operation']
      : ['description', 'name', 'operation'];
    if (
      !exactKeys(value, allowed) ||
      typeof value.name !== 'string' ||
      (value.description !== undefined && typeof value.description !== 'string')
    ) {
      return malformedLifecycleRequest();
    }
    if (validateEnvName(value.name) !== null) return lifecycleValidation('name');
    if (
      typeof value.description === 'string' &&
      value.description.length > UI_ENVIRONMENT_DESCRIPTION_MAX_LENGTH
    ) {
      return lifecycleValidation('description');
    }
    return {
      ok: true,
      request: {
        operation: 'create',
        name: value.name as EnvironmentName,
        ...(value.description === undefined ? {} : { description: value.description }),
      },
    };
  }
  if (
    !exactKeys(value, ['name', 'operation', 'source']) ||
    typeof value.name !== 'string' ||
    typeof value.source !== 'string'
  ) {
    return malformedLifecycleRequest();
  }
  if (validateEnvName(value.name) !== null) return lifecycleValidation('name');
  if (validateEnvName(value.source) !== null) return lifecycleValidation('source');
  return {
    ok: true,
    request: {
      operation: 'clone',
      name: value.name as EnvironmentName,
      source: value.source as EnvironmentName,
    },
  };
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

async function lifecycleRouteResult(
  result: EnvironmentLifecycleResult,
  paths: Paths,
  dependencies: UiRouteDependencies,
): Promise<UiRouteResult> {
  switch (result.status) {
    case 'created': {
      let environment;
      try {
        environment = await dependencies.getEnvironmentInventory({
          paths,
          name: result.name,
        });
      } catch {
        // Publication is already authoritative. A projection failure must not be
        // reported as a failed mutation: retrying could collide with the newly
        // published environment. The browser reconciles through the catalogue.
      }
      const data: EnvironmentLifecycleSuccess = {
        operation: result.operation,
        name: result.name as EnvironmentName,
        ...(result.source === undefined
          ? {}
          : { source: result.source as EnvironmentName }),
        publication: 'complete',
        ...(environment === undefined ? {} : { environment }),
      };
      return { status: 200, body: { data } };
    }
    case 'invalid':
      return errorResult('VALIDATION_FAILED', 'The environment request is invalid.', {
        kind: 'validation',
        issues: [{ path: result.field, message: `Enter a valid exact environment ${result.field}.` }],
      });
    case 'exists':
      return errorResult(
        'COLLISION',
        'An environment with that name already exists.',
        { kind: 'conflict', resource: result.name },
      );
    case 'source-not-found':
      return errorResult('NOT_FOUND', 'The source environment was not found.');
    case 'stale':
      return errorResult(
        'STALE_REVISION',
        'An environment changed while the request was being published.',
        { kind: 'conflict', resource: result.name },
      );
    case 'pending-recovery':
    case 'git-pending':
      return errorResult(
        'PENDING_RECOVERY',
        result.status === 'git-pending'
          ? 'The environment was published, but required Git bookkeeping is pending.'
          : 'Another environment operation requires recovery before this request can continue.',
        pendingRecoveryDetails(result.transactionId, result.status === 'git-pending'),
      );
    case 'failure':
      return errorResult(
        'INTERNAL_ERROR',
        'The environment request could not be completed.',
      );
  }
}

export async function handleUiRoute(
  request: IncomingMessage,
  url: URL,
  paths: Paths,
  dependencyOverrides: UiRouteDependencyOverrides = {},
  requestBody?: Record<string, unknown>,
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
  if (request.method === 'POST') {
    if ([...url.searchParams.keys()].length > 0) {
      return errorResult('MALFORMED_REQUEST', 'The request query is malformed.');
    }
    const parsed = parseLifecycleRequest(requestBody);
    if (!parsed.ok) return parsed.result;
    const runtime = dependencies.createEnvironmentLifecycleRuntime(paths);
    const result = parsed.request.operation === 'create'
      ? await dependencies.createEnvironment({
          paths,
          name: parsed.request.name,
          ...(parsed.request.description === undefined
            ? {}
            : { description: parsed.request.description }),
          runtime,
        })
      : await dependencies.cloneEnvironment({
          paths,
          name: parsed.request.name,
          source: parsed.request.source,
          runtime,
        });
    return await lifecycleRouteResult(result, paths, dependencies);
  }
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
