import type { IncomingMessage } from 'node:http';
import {
  copyContent,
  type CopyContentResult,
} from '../application/content-transfer.js';
import type { ContentTransferRuntime } from '../application/content-transfer-runtime.js';
import {
  cloneEnvironment,
  createEnvironment,
  deleteEnvironment,
  inspectEnvironmentDeletion,
  type EnvironmentDeleteResult,
  type EnvironmentLifecycleResult,
} from '../application/environment-lifecycle.js';
import type {
  EnvironmentDeleteRuntime,
  EnvironmentLifecycleRuntime,
} from '../application/environment-lifecycle-runtime.js';
import {
  CATALOG_MAX_PAGE,
  CATALOG_MAX_PAGE_SIZE,
  CatalogEnvironmentNameError,
  CatalogEnvironmentNotFoundError,
  CatalogPaginationError,
  CatalogStaleRevisionError,
  getEnvironmentInventory,
  listEnvironmentSummaries,
  opaqueIdentityRevision,
} from '../application/catalog.js';
import type { Paths } from '../paths.js';
import { validateItemName, validateSkillName } from '../content-items.js';
import { validateEnvName } from '../store.js';
import {
  API_ERROR_STATUS,
  UI_ENVIRONMENT_DESCRIPTION_MAX_LENGTH,
  type ApiErrorCode,
  type ApiErrorDetails,
  type DeleteEnvironmentRequest,
  type CopyContentRequest,
  type CopyContentSuccess,
  type ContentItem,
  type EnvironmentInventory,
  type EnvironmentDeleteSuccess,
  type EnvironmentLifecycleRequest,
  type EnvironmentLifecycleSuccess,
  type EnvironmentName,
  type Revision,
} from './contract.js';
import { UI_CONTENT_KINDS } from './contract.js';
import { createUiContentTransferRuntime } from './content-transfer-runtime.js';
import {
  createUiEnvironmentDeleteRuntime,
  createUiEnvironmentLifecycleRuntime,
} from './environment-lifecycle-runtime.js';

export interface UiRouteResult {
  status: number;
  body: unknown;
}

export interface UiRouteDependencies {
  copyContent: typeof copyContent;
  cloneEnvironment: typeof cloneEnvironment;
  createEnvironment: typeof createEnvironment;
  deleteEnvironment: typeof deleteEnvironment;
  inspectEnvironmentDeletion: typeof inspectEnvironmentDeletion;
  createEnvironmentDeleteRuntime(paths: Paths): EnvironmentDeleteRuntime;
  createEnvironmentLifecycleRuntime(paths: Paths): EnvironmentLifecycleRuntime;
  createContentTransferRuntime(paths: Paths): ContentTransferRuntime;
  getEnvironmentInventory: typeof getEnvironmentInventory;
  listEnvironmentSummaries: typeof listEnvironmentSummaries;
}

export type UiRouteDependencyOverrides = Partial<UiRouteDependencies>;

const DEFAULT_ROUTE_DEPENDENCIES: UiRouteDependencies = {
  copyContent,
  cloneEnvironment,
  createEnvironment,
  deleteEnvironment,
  inspectEnvironmentDeletion,
  createEnvironmentDeleteRuntime: (paths) =>
    createUiEnvironmentDeleteRuntime({ paths, env: process.env }),
  createEnvironmentLifecycleRuntime: (paths) =>
    createUiEnvironmentLifecycleRuntime({ paths, env: process.env }),
  createContentTransferRuntime: (paths) =>
    createUiContentTransferRuntime({ paths, env: process.env }),
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

type DeleteRequestParseResult =
  | { ok: true; request: DeleteEnvironmentRequest }
  | { ok: false; result: UiRouteResult };

function deleteValidation(path: string, message: string): DeleteRequestParseResult {
  return {
    ok: false,
    result: errorResult('VALIDATION_FAILED', 'The deletion request is invalid.', {
      kind: 'validation',
      issues: [{ path, message }],
    }),
  };
}

function parseDeleteRequest(
  value: Record<string, unknown> | undefined,
): DeleteRequestParseResult {
  if (
    value === undefined ||
    !exactKeys(value, [
      'confirmation',
      'containerRevision',
      'name',
      'operation',
      'targetRevision',
    ]) ||
    value.operation !== 'delete' ||
    typeof value.name !== 'string' ||
    typeof value.confirmation !== 'string' ||
    typeof value.targetRevision !== 'string' ||
    typeof value.containerRevision !== 'string'
  ) {
    return {
      ok: false,
      result: errorResult('MALFORMED_REQUEST', 'The deletion request is malformed.'),
    };
  }
  if (validateEnvName(value.name) !== null) {
    return deleteValidation('name', 'Enter a valid exact environment name.');
  }
  if (value.confirmation !== value.name) {
    return deleteValidation(
      'confirmation',
      `Type ${value.name} exactly to confirm deletion.`,
    );
  }
  const isRevision = (revision: string): boolean => /^[A-Za-z0-9_-]{43}$/.test(revision);
  if (!isRevision(value.targetRevision) || !isRevision(value.containerRevision)) {
    return deleteValidation('revision', 'Refresh environments before deleting.');
  }
  return {
    ok: true,
    request: {
      operation: 'delete',
      name: value.name as EnvironmentName,
      confirmation: value.confirmation,
      targetRevision: value.targetRevision as Revision,
      containerRevision: value.containerRevision as Revision,
    },
  };
}

function deleteRouteResult(result: EnvironmentDeleteResult): UiRouteResult {
  switch (result.status) {
    case 'deleted':
    case 'git-pending': {
      const data: EnvironmentDeleteSuccess = {
        operation: 'delete',
        name: result.name as EnvironmentName,
        publication: result.publication,
      };
      return { status: 200, body: { data } };
    }
    case 'invalid':
      return errorResult('VALIDATION_FAILED', 'The deletion request is invalid.', {
        kind: 'validation',
        issues: [{ path: 'name', message: 'Enter a valid exact environment name.' }],
      });
    case 'not-found':
      return errorResult('NOT_FOUND', 'The environment was not found.');
    case 'active':
      return errorResult(
        'ACTIVE_ENVIRONMENT',
        'The environment is active and must be deactivated before deletion.',
        { kind: 'active-environment', ...result.activity },
      );
    case 'stale':
      return errorResult(
        'STALE_REVISION',
        'The environment changed after the deletion dialog opened.',
        { kind: 'conflict', resource: result.name },
      );
    case 'pending-recovery':
      return errorResult(
        'PENDING_RECOVERY',
        'Another environment operation requires recovery before deletion can continue.',
        pendingRecoveryDetails(result.transactionId, false),
      );
    case 'drift-blocked':
      return errorResult(
        'DRIFT_BLOCKED',
        result.secretBearing
          ? 'Secret-bearing store changes must be resolved before deletion.'
          : 'Uncommitted store changes must be resolved before deletion.',
        { kind: 'blocked-drift', secretBearing: result.secretBearing },
      );
    case 'failure':
      return errorResult('INTERNAL_ERROR', 'The environment could not be deleted.');
  }
}

type CopyRequestParseResult =
  | { ok: true; request: CopyContentRequest }
  | { ok: false; result: UiRouteResult };

const TRANSFER_REQUEST_KEYS = [
  'collision',
  'destinationEnvironment',
  'destinationEnvironmentContainerRevision',
  'destinationEnvironmentRevision',
  'destinationItemRevision',
  'kind',
  'name',
  'operation',
  'sourceEnvironment',
  'sourceEnvironmentContainerRevision',
  'sourceEnvironmentRevision',
  'sourceItemRevision',
] as const;

function isRevision(value: unknown): value is Revision {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function transferValidation(
  path: string,
  message: string,
): Extract<CopyRequestParseResult, { ok: false }> {
  return {
    ok: false,
    result: errorResult('VALIDATION_FAILED', 'The content transfer request is invalid.', {
      kind: 'validation',
      issues: [{ path, message }],
    }),
  };
}

function parseCopyRequest(value: Record<string, unknown> | undefined): CopyRequestParseResult {
  if (
    value === undefined ||
    !exactKeys(value, TRANSFER_REQUEST_KEYS) ||
    value.operation !== 'copy' ||
    typeof value.kind !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.sourceEnvironment !== 'string' ||
    typeof value.destinationEnvironment !== 'string' ||
    (value.collision !== 'fail' && value.collision !== 'overwrite') ||
    !isRevision(value.sourceItemRevision) ||
    !isRevision(value.sourceEnvironmentRevision) ||
    !isRevision(value.sourceEnvironmentContainerRevision) ||
    !isRevision(value.destinationEnvironmentRevision) ||
    !isRevision(value.destinationEnvironmentContainerRevision) ||
    (value.destinationItemRevision !== null && !isRevision(value.destinationItemRevision))
  ) {
    return {
      ok: false,
      result: errorResult('MALFORMED_REQUEST', 'The content transfer request is malformed.'),
    };
  }
  if (!UI_CONTENT_KINDS.includes(value.kind as (typeof UI_CONTENT_KINDS)[number])) {
    return transferValidation('kind', 'Choose a supported content kind.');
  }
  if (validateEnvName(value.sourceEnvironment) !== null) {
    return transferValidation('sourceEnvironment', 'Enter a valid exact environment name.');
  }
  if (validateEnvName(value.destinationEnvironment) !== null) {
    return transferValidation('destinationEnvironment', 'Enter a valid exact environment name.');
  }
  if (value.sourceEnvironment === value.destinationEnvironment) {
    return transferValidation('destinationEnvironment', 'Choose a different destination environment.');
  }
  const nameError = value.kind === 'skill'
    ? validateSkillName(value.name)
    : validateItemName(value.kind, value.name);
  if (nameError !== null) {
    return transferValidation('name', 'Enter a valid exact content name.');
  }
  if (value.collision === 'overwrite' && value.destinationItemRevision === null) {
    return transferValidation(
      'destinationItemRevision',
      'Refresh the destination collision before overwriting.',
    );
  }
  return { ok: true, request: value as unknown as CopyContentRequest };
}

function transferItem(
  inventory: EnvironmentInventory,
  kind: CopyContentRequest['kind'],
  name: string,
): ContentItem | undefined {
  return inventory.items.find((item) => item.kind === kind && item.name === name);
}

function collisionResult(
  request: CopyContentRequest,
  destination: EnvironmentInventory,
  item: ContentItem,
): UiRouteResult {
  return errorResult('COLLISION', 'The destination already contains this content.', {
    kind: 'transfer-collision',
    environment: destination.name,
    contentKind: request.kind,
    name: request.name,
    destinationItemRevision: item.revision,
    destinationEnvironmentRevision: destination.revision,
    destinationEnvironmentContainerRevision: destination.containerRevision,
  });
}

function staleTransferResult(resource: string): UiRouteResult {
  return errorResult(
    'STALE_REVISION',
    'Content changed after the copy dialog opened.',
    { kind: 'conflict', resource },
  );
}

async function readTransferInventory(
  paths: Paths,
  name: string,
  dependencies: UiRouteDependencies,
): Promise<{ ok: true; inventory: EnvironmentInventory } | { ok: false; result: UiRouteResult }> {
  try {
    return {
      ok: true,
      inventory: await dependencies.getEnvironmentInventory({ paths, name }),
    };
  } catch (error) {
    if (error instanceof CatalogEnvironmentNotFoundError) {
      return { ok: false, result: errorResult('NOT_FOUND', 'An environment was not found.') };
    }
    if (error instanceof CatalogStaleRevisionError) {
      return { ok: false, result: staleTransferResult(name) };
    }
    return {
      ok: false,
      result: errorResult('INTERNAL_ERROR', 'The content transfer could not be inspected.'),
    };
  }
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

async function successfulCopyResult(
  request: CopyContentRequest,
  result: Extract<CopyContentResult, { status: 'copied' | 'git-pending' }>,
  paths: Paths,
  dependencies: UiRouteDependencies,
): Promise<UiRouteResult> {
  const [source, destination] = await Promise.all([
    readTransferInventory(paths, request.sourceEnvironment, dependencies),
    readTransferInventory(paths, request.destinationEnvironment, dependencies),
  ]);
  const data: CopyContentSuccess = {
    operation: 'copy',
    source: {
      environment: request.sourceEnvironment,
      kind: request.kind,
      name: request.name,
    },
    destination: {
      environment: request.destinationEnvironment,
      kind: request.kind,
      name: request.name,
    },
    publication: result.publication,
    refreshRequired: !source.ok || !destination.ok,
    ...(source.ok ? { sourceEnvironment: source.inventory } : {}),
    ...(destination.ok ? { destinationEnvironment: destination.inventory } : {}),
  };
  return { status: 200, body: { data } };
}

async function copyRouteResult(
  request: CopyContentRequest,
  result: CopyContentResult,
  paths: Paths,
  dependencies: UiRouteDependencies,
): Promise<UiRouteResult> {
  switch (result.status) {
    case 'copied':
    case 'git-pending':
      return await successfulCopyResult(request, result, paths, dependencies);
    case 'invalid':
      return transferValidation(result.field, 'The content location is invalid.').result;
    case 'not-found':
      return errorResult('NOT_FOUND', 'The requested content was not found.');
    case 'collision': {
      const inspected = await readTransferInventory(
        paths,
        request.destinationEnvironment,
        dependencies,
      );
      if (!inspected.ok) return inspected.result;
      const item = transferItem(inspected.inventory, request.kind, request.name);
      return item === undefined
        ? staleTransferResult(request.destinationEnvironment)
        : collisionResult(request, inspected.inventory, item);
    }
    case 'stale':
      return staleTransferResult(result.field);
    case 'pending-recovery':
      return errorResult(
        'PENDING_RECOVERY',
        'Another operation requires recovery before copying can continue.',
        pendingRecoveryDetails(result.transactionId, false),
      );
    case 'failure':
      return errorResult('INTERNAL_ERROR', 'The content could not be copied.');
  }
}

async function handleCopyRoute(
  requestBody: Record<string, unknown> | undefined,
  paths: Paths,
  dependencies: UiRouteDependencies,
): Promise<UiRouteResult> {
  const parsed = parseCopyRequest(requestBody);
  if (!parsed.ok) return parsed.result;
  const request = parsed.request;
  const [source, destination] = await Promise.all([
    readTransferInventory(paths, request.sourceEnvironment, dependencies),
    readTransferInventory(paths, request.destinationEnvironment, dependencies),
  ]);
  if (!source.ok) return source.result;
  if (!destination.ok) return destination.result;
  const sourceItem = transferItem(source.inventory, request.kind, request.name);
  if (sourceItem === undefined) {
    return errorResult('NOT_FOUND', 'The source content was not found.');
  }
  if (
    sourceItem.revision !== request.sourceItemRevision ||
    source.inventory.revision !== request.sourceEnvironmentRevision ||
    source.inventory.containerRevision !== request.sourceEnvironmentContainerRevision
  ) {
    return staleTransferResult(request.sourceEnvironment);
  }
  if (
    destination.inventory.revision !== request.destinationEnvironmentRevision ||
    destination.inventory.containerRevision !== request.destinationEnvironmentContainerRevision
  ) {
    return staleTransferResult(request.destinationEnvironment);
  }
  const destinationItem = transferItem(destination.inventory, request.kind, request.name);
  if (request.collision === 'fail' && destinationItem !== undefined) {
    if (
      request.destinationItemRevision !== null &&
      request.destinationItemRevision !== destinationItem.revision
    ) {
      return staleTransferResult(request.destinationEnvironment);
    }
    return collisionResult(request, destination.inventory, destinationItem);
  }
  if (
    request.collision === 'overwrite' &&
    (destinationItem === undefined || destinationItem.revision !== request.destinationItemRevision)
  ) {
    return staleTransferResult(request.destinationEnvironment);
  }
  if (request.collision === 'fail' && request.destinationItemRevision !== null) {
    return staleTransferResult(request.destinationEnvironment);
  }
  let result: CopyContentResult;
  try {
    result = await dependencies.copyContent({
      paths,
      source: {
        kind: request.kind,
        environment: request.sourceEnvironment,
        name: request.name,
      },
      destination: {
        kind: request.kind,
        environment: request.destinationEnvironment,
        name: request.name,
      },
      collision: request.collision,
      observedRevisions: {
        sourceItem: request.sourceItemRevision,
        sourceEnvironment: request.sourceEnvironmentRevision,
        sourceEnvironmentContainer: request.sourceEnvironmentContainerRevision,
        destinationEnvironment: request.destinationEnvironmentRevision,
        destinationEnvironmentContainer: request.destinationEnvironmentContainerRevision,
        destinationItem: request.destinationItemRevision,
      },
      runtime: dependencies.createContentTransferRuntime(paths),
    });
  } catch {
    return errorResult('INTERNAL_ERROR', 'The content could not be copied.');
  }
  return await copyRouteResult(request, result, paths, dependencies);
}

export async function handleUiRoute(
  request: IncomingMessage,
  url: URL,
  paths: Paths,
  dependencyOverrides: UiRouteDependencyOverrides = {},
  requestBody?: Record<string, unknown>,
): Promise<UiRouteResult | undefined> {
  const dependencies = { ...DEFAULT_ROUTE_DEPENDENCIES, ...dependencyOverrides };
  if (url.pathname === '/api/content/transfer') {
    if (request.method !== 'POST') {
      return errorResult('METHOD_NOT_ALLOWED', 'The request method is not supported.');
    }
    if ([...url.searchParams.keys()].length > 0) {
      return errorResult('MALFORMED_REQUEST', 'The request query is malformed.');
    }
    return await handleCopyRoute(requestBody, paths, dependencies);
  }
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
    if (requestBody?.operation === 'delete') {
      const parsed = parseDeleteRequest(requestBody);
      if (!parsed.ok) return parsed.result;
      const inspected = await dependencies.inspectEnvironmentDeletion({
        paths,
        name: parsed.request.name,
      });
      if (inspected.status !== 'ready') return deleteRouteResult(inspected);
      const targetMatches = opaqueIdentityRevision(inspected.targetIdentity) ===
        parsed.request.targetRevision;
      const containerMatches = opaqueIdentityRevision(inspected.containerIdentity) ===
        parsed.request.containerRevision;
      if (!targetMatches || !containerMatches) {
        return deleteRouteResult({
          status: 'stale',
          field: targetMatches ? 'container' : 'target',
          name: parsed.request.name,
          message: 'captured deletion identity changed',
        });
      }
      const result = await dependencies.deleteEnvironment({
        paths,
        name: parsed.request.name,
        runtime: dependencies.createEnvironmentDeleteRuntime(paths),
        expectedTargetIdentity: inspected.targetIdentity,
        expectedContainerIdentity: inspected.containerIdentity,
      });
      return deleteRouteResult(result);
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
