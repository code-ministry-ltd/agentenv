import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import {
  ensureStoreRepo,
  gitContext,
  normaliseRemoteUrl,
  redactRemoteUrl,
  resolveGitIdentity,
  scanTextForSecrets,
  storeIsRepo,
} from '../src/git.js';
import { resolvePaths } from '../src/paths.js';
import { ensureStore } from '../src/store.js';
import { expectRealHomeUntouched, makeTempHome, realHomeSnapshot, type TempHome } from './helpers.js';

const homes: TempHome[] = [];
function home(): TempHome {
  const h = makeTempHome();
  homes.push(h);
  return h;
}
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
});

function gitIn(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

describe('sync: store-as-repo init (D9)', () => {
  it('agentenv init makes the store a git repo with a baseline commit', async () => {
    const before = realHomeSnapshot();
    const th = home();
    const paths = resolvePaths(th.env);

    const res = await run(['init'], { env: th.env });
    expect(res.code).toBe(0);
    expect(existsSync(join(paths.store, '.git'))).toBe(true);
    expect(await storeIsRepo(paths)).toBe(true);
    // A baseline commit exists (so a later `remote` connect has history to push).
    const log = gitIn(paths.store, 'log', '--oneline');
    expect(log).toContain('agentenv: initialise store');
    // The store .gitignore keeps OS cruft out but there is no secrets/state inside.
    expect(existsSync(join(paths.store, '.gitignore'))).toBe(true);
    expect(res.stdout).toContain('git initialised');

    expectRealHomeUntouched(before);
  });

  it('is idempotent — a second init neither re-inits nor adds a commit', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    await run(['init'], { env: th.env });
    const firstHead = gitIn(paths.store, 'rev-parse', 'HEAD');

    const second = await ensureStoreRepo(paths, th.env);
    expect(second.initialised).toBe(false);
    expect(gitIn(paths.store, 'rev-parse', 'HEAD')).toBe(firstHead);
    expect(await run(['init'], { env: th.env })).toMatchObject({ code: 0 });
    expect(gitIn(paths.store, 'rev-parse', 'HEAD')).toBe(firstHead);
  });

  it('resolveGitIdentity falls back to a stable agentenv identity', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    await ensureStore(paths);
    // Point git config at /dev/null so there is no global identity to read.
    const env = { ...th.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
    await ensureStoreRepo(paths, env);
    const identity = await resolveGitIdentity(gitContext(paths, env));
    expect(identity.name).not.toBe('');
    expect(identity.email).toContain('@');
    // The baseline commit still succeeded despite no configured identity.
    expect(gitIn(paths.store, 'log', '--oneline')).toContain('agentenv: initialise store');
  });
});

describe('sync: URL handling never leaks credentials', () => {
  it('normaliseRemoteUrl trims trailing slash and .git for comparison', () => {
    expect(normaliseRemoteUrl('https://github.com/x/y.git')).toBe('https://github.com/x/y');
    expect(normaliseRemoteUrl('https://github.com/x/y/')).toBe('https://github.com/x/y');
    expect(normaliseRemoteUrl('  git@github.com:x/y.git ')).toBe('git@github.com:x/y');
  });

  it('redactRemoteUrl masks an embedded password', () => {
    expect(redactRemoteUrl('https://user:supersecret@github.com/x/y.git')).toBe(
      'https://user:***@github.com/x/y.git',
    );
    // scp-style and file:// carry no password and pass through unchanged.
    expect(redactRemoteUrl('git@github.com:x/y.git')).toBe('git@github.com:x/y.git');
    expect(redactRemoteUrl('file:///tmp/remote')).toBe('file:///tmp/remote');
  });
});

describe('sync: secret scan (D6/D9)', () => {
  it('flags known token shapes', () => {
    expect(scanTextForSecrets('AWS_KEY=AKIAIOSFODNN7EXAMPLE').length).toBe(1);
    expect(scanTextForSecrets('token: ghp_' + 'a'.repeat(36)).length).toBe(1);
    expect(scanTextForSecrets('-----BEGIN OPENSSH PRIVATE KEY-----').length).toBe(1);
  });

  it('flags a secret-named field with a real-looking literal value', () => {
    expect(scanTextForSecrets('api_key: "9a8b7c6d5e4f3a2b1c0d9e8f"').length).toBe(1);
  });

  it('does NOT flag ${VAR} placeholders, fixtures, or provenance hashes', () => {
    expect(scanTextForSecrets('api_key: "${GITHUB_API_KEY}"')).toEqual([]);
    expect(scanTextForSecrets('bearer_env: GITHUB_TOKEN')).toEqual([]);
    expect(scanTextForSecrets('token: your-token-here')).toEqual([]);
    // env.yaml provenance: 40-hex commit + 64-hex sha256 are NOT secrets.
    expect(scanTextForSecrets('commit: ' + 'a1b2c3d4'.repeat(5))).toEqual([]);
    expect(scanTextForSecrets('hash: ' + 'deadbeef'.repeat(8))).toEqual([]);
  });
});
