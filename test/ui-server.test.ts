import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  startUiServer,
  type UiServerHandle,
} from '../src/ui/server.js';

async function statusWithHost(url: string, host: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const outgoing = request(url, { headers: { host } }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    outgoing.once('error', reject);
    outgoing.end();
  });
}

describe('local UI server', () => {
  let assetsDir: string;
  let server: UiServerHandle | undefined;

  beforeEach(async () => {
    assetsDir = await mkdtemp(join(tmpdir(), 'agentenv-ui-assets-'));
    await writeFile(join(assetsDir, 'index.html'), '<h1>agentenv fixture</h1>');
  });

  afterEach(async () => {
    await server?.close();
    await rm(assetsDir, { recursive: true, force: true });
  });

  it('serves only local assets with restrictive browser headers', async () => {
    server = await startUiServer({ assetsDir, installSignalHandlers: false });
    const launchUrl = new URL(server.launchUrl);

    expect(launchUrl.hostname).toBe('127.0.0.1');
    expect(launchUrl.hash).toMatch(/^#launch=[A-Za-z0-9_-]{32,}$/);

    const response = await fetch(server.origin);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<h1>agentenv fixture</h1>');
    expect(response.headers.get('content-security-policy')).toContain(
      "default-src 'self'",
    );
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await readFile(join(assetsDir, 'index.html'), 'utf8')).toBe(
      '<h1>agentenv fixture</h1>',
    );
  });

  it('exchanges the launch credential once for a session and CSRF token', async () => {
    server = await startUiServer({ assetsDir, installSignalHandlers: false });
    const launchUrl = new URL(server.launchUrl);
    const launchToken = new URLSearchParams(launchUrl.hash.slice(1)).get('launch');
    expect(launchToken).not.toBeNull();

    const unauthenticated = await fetch(`${server.origin}/api/session`);
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' },
    });

    const exchange = await fetch(`${server.origin}/api/session`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: server.origin,
      },
      body: JSON.stringify({ launchToken }),
    });
    expect(exchange.status).toBe(200);
    expect(exchange.headers.get('cache-control')).toBe('no-store');
    const cookie = exchange.headers.get('set-cookie');
    expect(cookie).toMatch(/^agentenv_session=[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Strict$/);
    const payload = (await exchange.json()) as { data: { csrfToken: string } };
    expect(payload.data.csrfToken).toMatch(/^[A-Za-z0-9_-]{32,}$/);

    const replay = await fetch(`${server.origin}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.origin },
      body: JSON.stringify({ launchToken }),
    });
    expect(replay.status).toBe(401);

    const refreshed = await fetch(`${server.origin}/api/session`, {
      headers: { cookie: cookie! },
    });
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toEqual(payload);

    const missingCsrf = await fetch(`${server.origin}/api/not-yet-implemented`, {
      method: 'POST',
      headers: { cookie: cookie!, origin: server.origin },
    });
    expect(missingCsrf.status).toBe(403);

    const verified = await fetch(`${server.origin}/api/session/verify`, {
      method: 'POST',
      headers: {
        cookie: cookie!,
        origin: server.origin,
        'x-agentenv-csrf': payload.data.csrfToken,
      },
    });
    expect(verified.status).toBe(200);
    expect(await verified.json()).toEqual({ data: { ready: true } });

    const authenticated = await fetch(`${server.origin}/api/not-yet-implemented`, {
      method: 'POST',
      headers: {
        cookie: cookie!,
        origin: server.origin,
        'x-agentenv-csrf': payload.data.csrfToken,
      },
    });
    expect(authenticated.status).toBe(404);
  });

  it('rejects hostile request metadata, methods, and bodies consistently', async () => {
    server = await startUiServer({ assetsDir, installSignalHandlers: false });

    expect(await statusWithHost(`${server.origin}/api/session`, 'attacker.invalid')).toBe(403);

    const foreignOrigin = await fetch(`${server.origin}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://attacker.invalid' },
      body: JSON.stringify({ launchToken: 'not-a-token' }),
    });
    expect(foreignOrigin.status).toBe(403);

    const unsupported = await fetch(`${server.origin}/api/session`, {
      method: 'PUT',
    });
    expect(unsupported.status).toBe(405);

    const malformed = await fetch(`${server.origin}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.origin },
      body: '{',
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      error: { code: 'MALFORMED_REQUEST', message: 'The request body is malformed.' },
    });

    const oversized = await fetch(`${server.origin}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.origin },
      body: JSON.stringify({ launchToken: 'x'.repeat(33 * 1024) }),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large.' },
    });
  });

  it('contains asset paths and releases the listener on close', async () => {
    server = await startUiServer({ assetsDir, installSignalHandlers: false });

    const traversal = await fetch(`${server.origin}/assets/%2e%2e%2findex.html`);
    expect(traversal.status).toBe(404);

    const origin = server.origin;
    await server.close();
    await expect(fetch(origin)).rejects.toThrow();
  });

  it('refuses privileged and invalid explicit ports before listening', async () => {
    await expect(
      startUiServer({ port: 80, assetsDir, installSignalHandlers: false }),
    ).rejects.toThrow('UI port must be 0 or an integer from 1024 to 65535');
    await expect(
      startUiServer({ port: 70_000, assetsDir, installSignalHandlers: false }),
    ).rejects.toThrow('UI port must be 0 or an integer from 1024 to 65535');
  });

  it('releases the listener through its installed termination handler', async () => {
    const previousExitCode = process.exitCode;
    const previousHandlers = new Set(process.listeners('SIGTERM'));
    try {
      server = await startUiServer({ assetsDir });
      const handler = process
        .listeners('SIGTERM')
        .find((candidate) => !previousHandlers.has(candidate));
      expect(handler).toBeDefined();

      handler!('SIGTERM');
      await server.close();
      await Promise.resolve();

      await expect(fetch(server.origin)).rejects.toThrow();
      expect(process.exitCode).toBe(143);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
