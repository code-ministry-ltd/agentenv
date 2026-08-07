import {
  API_ERROR_STATUS,
  type ApiErrorDetails,
  type ApiErrorCode,
  type ApiErrorResponse,
  type ApiSuccessResponse,
  type EnvironmentCatalogPage,
  type EnvironmentInventory,
  type EnvironmentLifecycleRequest,
  type EnvironmentLifecycleSuccess,
  type EnvironmentSummary,
} from '../../src/ui/contract.js';

interface SessionData {
  csrfToken: string;
}

let csrfToken: string | undefined;

export class UiApiError extends Error {
  readonly code: ApiErrorCode;
  readonly details?: ApiErrorDetails;

  constructor(code: ApiErrorCode, message: string, details?: ApiErrorDetails) {
    super(message);
    this.name = 'UiApiError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function takeLaunchToken(): string | undefined {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const launchToken = fragment.get('launch') ?? undefined;
  if (location.hash !== '') {
    history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  }
  return launchToken;
}

async function responseBody<Data>(response: Response): Promise<Data> {
  const body = (await response.json().catch(() => undefined)) as
    | ApiSuccessResponse<Data>
    | ApiErrorResponse
    | undefined;

  if (!response.ok) {
    const code = body && 'error' in body && body.error.code in API_ERROR_STATUS
      ? body.error.code
      : 'INTERNAL_ERROR';
    const message = body && 'error' in body
      ? body.error.message
      : 'The local UI request could not be completed.';
    const details = body && 'error' in body ? body.error.details : undefined;
    throw new UiApiError(code, message, details);
  }
  if (body === undefined || !('data' in body)) {
    throw new UiApiError('INTERNAL_ERROR', 'The local UI returned an invalid response.');
  }
  return body.data;
}

export async function initializeSession(): Promise<void> {
  const launchToken = takeLaunchToken();
  const response = await fetch('/api/session', {
    method: launchToken === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: launchToken === undefined
      ? undefined
      : { 'content-type': 'application/json' },
    body: launchToken === undefined ? undefined : JSON.stringify({ launchToken }),
  });
  const session = await responseBody<SessionData>(response);
  csrfToken = session.csrfToken;
  const verification = await apiRequest<{ ready: boolean }>('/api/session/verify', {
    method: 'POST',
  });
  if (!verification.ready) {
    throw new UiApiError('INTERNAL_ERROR', 'The local UI session could not be verified.');
  }
}

export async function apiRequest<Data>(
  path: string,
  init: RequestInit = {},
): Promise<Data> {
  if (!path.startsWith('/api/')) {
    throw new UiApiError('MALFORMED_REQUEST', 'UI requests must use a local API path.');
  }
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  if (method !== 'GET' && method !== 'HEAD') {
    if (csrfToken === undefined) {
      throw new UiApiError('UNAUTHENTICATED', 'The local UI session is not ready.');
    }
    headers.set('x-agentenv-csrf', csrfToken);
  }
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  const response = await fetch(path, {
    ...init,
    method,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  return await responseBody<Data>(response);
}

export async function listEnvironmentSummaries(): Promise<readonly EnvironmentSummary[]> {
  const first = await apiRequest<EnvironmentCatalogPage>('/api/environments?page=1&pageSize=100');
  const items = [...first.items];
  for (let page = 2; page <= first.page.totalPages; page += 1) {
    const next = await apiRequest<EnvironmentCatalogPage>(
      `/api/environments?page=${page}&pageSize=100`,
    );
    items.push(...next.items);
  }
  return items;
}

export async function getEnvironmentInventory(
  name: string,
  signal?: AbortSignal,
): Promise<EnvironmentInventory> {
  return await apiRequest<EnvironmentInventory>(
    `/api/environments/${encodeURIComponent(name)}`,
    { signal },
  );
}

export async function publishEnvironment(
  request: EnvironmentLifecycleRequest,
  signal?: AbortSignal,
): Promise<EnvironmentLifecycleSuccess> {
  return await apiRequest<EnvironmentLifecycleSuccess>('/api/environments', {
    method: 'POST',
    body: JSON.stringify(request),
    signal,
  });
}
