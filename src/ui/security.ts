import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { ServerResponse } from 'node:http';

export const UI_SESSION_COOKIE = 'agentenv_session';
export const UI_CSRF_HEADER = 'x-agentenv-csrf';

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function tokensEqual(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(';') ?? []) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}

export interface UiSecurityState {
  readonly launchToken: string;
  readonly csrfToken: string;
  exchangeLaunchToken(candidate: string | undefined): boolean;
  hasSession(cookieHeader: string | undefined): boolean;
  hasCsrf(candidate: string | undefined): boolean;
  sessionCookie(): string;
}

export function createUiSecurityState(): UiSecurityState {
  const launchToken = randomToken();
  const sessionToken = randomToken();
  const csrfToken = randomToken();
  let launchConsumed = false;

  return {
    launchToken,
    csrfToken,
    exchangeLaunchToken(candidate) {
      if (launchConsumed || !tokensEqual(candidate, launchToken)) return false;
      launchConsumed = true;
      return true;
    },
    hasSession(cookieHeader) {
      return tokensEqual(readCookie(cookieHeader, UI_SESSION_COOKIE), sessionToken);
    },
    hasCsrf(candidate) {
      return tokensEqual(candidate, csrfToken);
    },
    sessionCookie() {
      return `${UI_SESSION_COOKIE}=${sessionToken}; Path=/; HttpOnly; SameSite=Strict`;
    },
  };
}

export function applyBrowserSecurityHeaders(response: ServerResponse): void {
  response.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
}
