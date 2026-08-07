import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunOptions } from '../command.js';
import { GitCandidateStore } from '../application/git-candidates.js';
import { resolvePaths, type Paths } from '../paths.js';
import { API_ERROR_STATUS, type ApiErrorCode } from './contract.js';
import {
  handleUiRoute,
  type UiRouteDependencyOverrides,
} from './routes.js';
import {
  createUiEnvironmentDeleteRuntime,
  createUiEnvironmentLifecycleRuntime,
} from './environment-lifecycle-runtime.js';
import { createUiContentTransferRuntime } from './content-transfer-runtime.js';
import { createUiSkillDocumentRuntime } from './skill-document-runtime.js';
import {
  applyBrowserSecurityHeaders,
  createUiSecurityState,
  UI_CSRF_HEADER,
  type UiSecurityState,
} from './security.js';

const DEFAULT_ASSETS_DIR = fileURLToPath(new URL('../ui-assets', import.meta.url));
const MAX_JSON_BODY_BYTES = 32 * 1024;

export interface StartUiServerOptions {
  port?: number;
  assetsDir?: string;
  installSignalHandlers?: boolean;
  paths?: Paths;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  runOptions?: Pick<RunOptions, 'adapters' | 'gitRun' | 'globals'>;
  routeDependencies?: UiRouteDependencyOverrides;
}

export interface UiServerHandle {
  origin: string;
  launchUrl: string;
  close(): Promise<void>;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(`${JSON.stringify(value)}\n`);
}

function sendError(
  response: ServerResponse,
  code: ApiErrorCode,
  message: string,
): void {
  sendJson(response, API_ERROR_STATUS[code], { error: { code, message } });
}

function assetContentType(pathname: string): string {
  switch (extname(pathname)) {
    case '.css':
      return 'text/css; charset=utf-8';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

async function serveAsset(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  assetsDir: string,
): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendError(response, 'METHOD_NOT_ALLOWED', 'The request method is not supported.');
    return;
  }

  let assetPath: string | undefined;
  if (pathname === '/') assetPath = join(assetsDir, 'index.html');
  else {
    const match = /^\/assets\/([A-Za-z0-9._-]+)$/.exec(pathname);
    if (match) assetPath = join(assetsDir, 'assets', match[1]!);
  }
  if (assetPath === undefined) {
    sendError(response, 'NOT_FOUND', 'The requested resource was not found.');
    return;
  }

  try {
    const body = await readFile(assetPath);
    response.statusCode = 200;
    response.setHeader('Content-Type', assetContentType(assetPath));
    response.setHeader('Cache-Control', pathname === '/' ? 'no-store' : 'public, max-age=31536000, immutable');
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      sendError(response, 'NOT_FOUND', 'The requested resource was not found.');
      return;
    }
    throw error;
  }
}

function hasExpectedHost(request: IncomingMessage, expectedHost: string): boolean {
  return request.headers.host === expectedHost;
}

function hasExpectedOrigin(request: IncomingMessage, origin: string): boolean {
  return request.headers.origin === origin;
}

type JsonBodyResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; code: 'MALFORMED_REQUEST' | 'PAYLOAD_TOO_LARGE'; message: string };

async function readJsonBody(request: IncomingMessage): Promise<JsonBodyResult> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/json') {
    return {
      ok: false,
      code: 'MALFORMED_REQUEST',
      message: 'The request must contain JSON.',
    };
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    size += chunk.byteLength;
    if (size > MAX_JSON_BODY_BYTES) {
      return {
        ok: false,
        code: 'PAYLOAD_TOO_LARGE',
        message: 'The request body is too large.',
      };
    }
    chunks.push(chunk);
  }

  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('expected an object');
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return {
      ok: false,
      code: 'MALFORMED_REQUEST',
      message: 'The request body is malformed.',
    };
  }
}

async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  origin: string,
  expectedHost: string,
  security: UiSecurityState,
  paths: Paths,
  routeDependencies: UiRouteDependencyOverrides,
): Promise<void> {
  if (!hasExpectedHost(request, expectedHost)) {
    sendError(response, 'FORBIDDEN', 'The request host is not allowed.');
    return;
  }

  if (
    pathname === '/api/session' &&
    request.method !== 'GET' &&
    request.method !== 'POST'
  ) {
    sendError(response, 'METHOD_NOT_ALLOWED', 'The request method is not supported.');
    return;
  }

  if (pathname === '/api/session' && request.method === 'POST') {
    if (!hasExpectedOrigin(request, origin)) {
      sendError(response, 'FORBIDDEN', 'The request origin is not allowed.');
      return;
    }
    const body = await readJsonBody(request);
    if (!body.ok) {
      sendError(response, body.code, body.message);
      return;
    }
    const launchToken =
      typeof body.value.launchToken === 'string' ? body.value.launchToken : undefined;
    if (!security.exchangeLaunchToken(launchToken)) {
      sendError(response, 'UNAUTHENTICATED', 'The launch credential is invalid or expired.');
      return;
    }
    response.setHeader('Set-Cookie', security.sessionCookie());
    sendJson(response, 200, { data: { csrfToken: security.csrfToken } });
    return;
  }

  if (!security.hasSession(request.headers.cookie)) {
    sendError(response, 'UNAUTHENTICATED', 'Authentication is required.');
    return;
  }
  if (pathname === '/api/session' && request.method === 'GET') {
    sendJson(response, 200, { data: { csrfToken: security.csrfToken } });
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const csrf = request.headers[UI_CSRF_HEADER];
    if (
      !hasExpectedOrigin(request, origin) ||
      typeof csrf !== 'string' ||
      !security.hasCsrf(csrf)
    ) {
      sendError(response, 'FORBIDDEN', 'The request origin or CSRF token is invalid.');
      return;
    }
  }
  if (pathname === '/api/session/verify' && request.method === 'POST') {
    sendJson(response, 200, { data: { ready: true } });
    return;
  }
  let requestBody: Record<string, unknown> | undefined;
  if (
    ((pathname === '/api/environments' || pathname === '/api/content/transfer') &&
      request.method === 'POST') ||
    (pathname === '/api/git/candidates' && request.method === 'POST') ||
    (pathname === '/api/git/import' && request.method === 'POST') ||
    (/^\/api\/environments\/[^/]+\/skills\/[^/]+\/document$/.test(pathname) &&
      request.method === 'PUT')
  ) {
    const body = await readJsonBody(request);
    if (!body.ok) {
      sendError(response, body.code, body.message);
      return;
    }
    requestBody = body.value;
  }
  const route = await handleUiRoute(
    request,
    new URL(request.url ?? '/', origin),
    paths,
    routeDependencies,
    requestBody,
  );
  if (route !== undefined) {
    sendJson(response, route.status, route.body);
    return;
  }
  sendError(response, 'NOT_FOUND', 'The requested API resource was not found.');
}

export async function startUiServer(
  options: StartUiServerOptions = {},
): Promise<UiServerHandle> {
  const requestedPort = options.port ?? 0;
  if (
    !Number.isInteger(requestedPort) ||
    requestedPort < 0 ||
    requestedPort > 65_535 ||
    (requestedPort > 0 && requestedPort < 1_024)
  ) {
    throw new RangeError('UI port must be 0 or an integer from 1024 to 65535');
  }

  const assetsDir = options.assetsDir ?? DEFAULT_ASSETS_DIR;
  const runtimeEnv = options.env ?? process.env;
  const paths = options.paths ?? resolvePaths(runtimeEnv);
  const gitCandidates = options.routeDependencies?.gitCandidates ?? new GitCandidateStore({
    cwd: options.cwd ?? process.cwd(),
    env: runtimeEnv,
    offline: options.runOptions?.globals?.offline ?? false,
    ...(options.runOptions?.gitRun === undefined
      ? {}
      : { gitRun: options.runOptions.gitRun }),
  });
  const routeDependencies: UiRouteDependencyOverrides = {
    createContentTransferRuntime: (runtimePaths) =>
      createUiContentTransferRuntime({
        paths: runtimePaths,
        env: runtimeEnv,
        ...(options.runOptions === undefined ? {} : { runOptions: options.runOptions }),
      }),
    createEnvironmentDeleteRuntime: (runtimePaths) =>
      createUiEnvironmentDeleteRuntime({
        paths: runtimePaths,
        env: runtimeEnv,
        ...(options.runOptions === undefined ? {} : { runOptions: options.runOptions }),
      }),
    createEnvironmentLifecycleRuntime: (runtimePaths) =>
      createUiEnvironmentLifecycleRuntime({
        paths: runtimePaths,
        env: runtimeEnv,
        ...(options.runOptions === undefined ? {} : { runOptions: options.runOptions }),
      }),
    createSkillDocumentRuntime: (runtimePaths) =>
      createUiSkillDocumentRuntime({
        paths: runtimePaths,
        env: runtimeEnv,
        ...(options.runOptions === undefined ? {} : { runOptions: options.runOptions }),
      }),
    gitCandidates,
    ...options.routeDependencies,
  };
  const security = createUiSecurityState();
  let origin = '';
  let expectedHost = '';
  const httpServer = createServer((request, response) => {
    applyBrowserSecurityHeaders(response);
    void (async () => {
      let pathname: string;
      try {
        pathname = new URL(request.url ?? '/', origin).pathname;
      } catch {
        sendError(response, 'MALFORMED_REQUEST', 'The request URL is malformed.');
        return;
      }

      if (pathname === '/api' || pathname.startsWith('/api/')) {
        await handleApi(
          request,
          response,
          pathname,
          origin,
          expectedHost,
          security,
          paths,
          routeDependencies,
        );
      } else {
        await serveAsset(request, response, pathname, assetsDir);
      }
    })().catch(() => {
      if (!response.headersSent) {
        sendError(response, 'INTERNAL_ERROR', 'The request could not be completed.');
      } else if (!response.writableEnded) {
        response.end();
      }
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      httpServer.once('error', onError);
      httpServer.listen(requestedPort, '127.0.0.1', () => {
        httpServer.off('error', onError);
        resolve();
      });
    });
  } catch (error) {
    await gitCandidates.shutdown();
    throw error;
  }

  const address = httpServer.address();
  if (address === null || typeof address === 'string') {
    httpServer.close();
    await gitCandidates.shutdown();
    throw new Error('UI server did not expose a TCP address');
  }
  expectedHost = `127.0.0.1:${address.port}`;
  origin = `http://${expectedHost}`;

  let closePromise: Promise<void> | undefined;
  let removeSignalHandlers = (): void => undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      removeSignalHandlers();
      try {
        if (httpServer.listening) {
          await new Promise<void>((resolve, reject) => {
            httpServer.close((error) => (error ? reject(error) : resolve()));
          });
        }
      } finally {
        await gitCandidates.shutdown();
      }
    })();
    return closePromise;
  };

  if (options.installSignalHandlers !== false) {
    const onSigint = (): void => {
      void close().then(
        () => {
          process.exitCode = 130;
        },
        () => {
          process.exitCode = 1;
        },
      );
    };
    const onSigterm = (): void => {
      void close().then(
        () => {
          process.exitCode = 143;
        },
        () => {
          process.exitCode = 1;
        },
      );
    };
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    removeSignalHandlers = () => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    };
  }

  return {
    origin,
    launchUrl: `${origin}/#launch=${security.launchToken}`,
    close,
  };
}
