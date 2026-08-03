import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { commitStore, scanTextForSecrets } from '../src/git.js';
import { resolvePaths } from '../src/paths.js';
import { makeTempHome, type TempHome } from './helpers.js';

/**
 * F2 (HIGH): a secret-scan false positive must not permanently wedge sync.
 *
 * Three properties the fix must hold, all exercised through the real
 * {@link commitStore} pre-commit gate:
 *   1. the pre-commit scan inspects the STAGED DIFF, not the whole tree, so a
 *      pre-existing flagged file cannot block an unrelated commit;
 *   2. documented examples (AWS's public `AKIAIOSFODNN7EXAMPLE`, an `EXAMPLE`
 *      marker) are exempt from the token-shape rule too, not just the value rule;
 *   3. an inline `agentenv:allow-secret` marker is a scoped, recoverable override.
 * A REAL, unmarked token is still blocked.
 */

/** AWS's canonical PUBLIC documentation key — a legitimate example, never a secret. */
const EXAMPLE_AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
/** A real-SHAPED AWS key with no example/fixture marker — must always be blocked. */
const REAL_AWS_KEY = 'AKIAZ7Q2W9E4R6T1Y8U3';

/** A temp home whose git commands never read the dev machine's global config. */
function gitHome(): TempHome {
  const th = makeTempHome({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' });
  homes.push(th);
  return th;
}
const homes: TempHome[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
});

function gitIn(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

describe('F2 unit: token-shape exemptions + allow-secret override', () => {
  it('exempts the documented AWS example key from the token-shape rule', () => {
    expect(scanTextForSecrets(`aws_key = ${EXAMPLE_AWS_KEY}`)).toEqual([]);
    // An EXAMPLE marker on the line exempts a token-shaped value too.
    expect(scanTextForSecrets(`ghp_${'a'.repeat(36)}  # EXAMPLE token from the docs`)).toEqual([]);
    // A PEM header presented as an example is not a real key.
    expect(scanTextForSecrets('-----BEGIN PRIVATE KEY----- (example)')).toEqual([]);
  });

  it('still flags a REAL, unmarked token', () => {
    expect(scanTextForSecrets(`aws_key = ${REAL_AWS_KEY}`).length).toBe(1);
    expect(scanTextForSecrets(`token: ghp_${'a'.repeat(36)}`).length).toBe(1);
    expect(scanTextForSecrets('-----BEGIN OPENSSH PRIVATE KEY-----').length).toBe(1);
  });

  it('honours an agentenv:allow-secret marker on the line or the line above', () => {
    expect(scanTextForSecrets(`aws_key = ${REAL_AWS_KEY}  # agentenv:allow-secret`)).toEqual([]);
    expect(scanTextForSecrets(`# agentenv:allow-secret\naws_key = ${REAL_AWS_KEY}`)).toEqual([]);
    // The marker is scoped: it does not exempt a DIFFERENT line further down.
    const twoTokens = `# agentenv:allow-secret\naws_key = ${REAL_AWS_KEY}\nother = ${REAL_AWS_KEY}`;
    expect(scanTextForSecrets(twoTokens).length).toBe(1);
  });
});

describe('F2 integration: the pre-commit gate scans the staged diff (D6/D9)', () => {
  it('refuses rm before deleting the only uncommitted secret-bearing copy', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    await run(['init'], { env: th.env });
    await run(['create', 'writing'], { env: th.env });
    const headBefore = gitIn(paths.store, 'rev-parse', 'HEAD');
    const leak = join(paths.envDir('writing'), 'only-copy.txt');
    writeFileSync(leak, `api_key: ${REAL_AWS_KEY}\n`);

    const result = await run(['rm', 'writing'], {
      env: th.env,
      confirm: async () => true,
    });

    expect(result.code).toBe(1);
    expect(`${result.stdout}${result.stderr ?? ''}`).toMatch(/refus|blocked|secret/i);
    expect(readFileSync(leak, 'utf8')).toContain(REAL_AWS_KEY);
    expect(gitIn(paths.store, 'rev-parse', 'HEAD')).toBe(headBefore);
  });

  it('a staged documented-example token commits fine', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    await run(['init'], { env: th.env });
    await run(['create', 'writing'], { env: th.env });

    writeFileSync(
      join(paths.envDir('writing'), 'docs.md'),
      `Configure your key like \`aws_key = ${EXAMPLE_AWS_KEY}\`  <!-- EXAMPLE only -->\n`,
    );
    const result = await commitStore(paths, th.env, 'agentenv: add docs');
    expect(result.status).toBe('committed');
  });

  it('a staged REAL token is still blocked, and nothing is committed', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    await run(['init'], { env: th.env });
    await run(['create', 'writing'], { env: th.env });
    const headBefore = gitIn(paths.store, 'rev-parse', 'HEAD');

    writeFileSync(join(paths.envDir('writing'), 'leak.txt'), `api_key: ${REAL_AWS_KEY}\n`);
    const result = await commitStore(paths, th.env, 'agentenv: should be blocked');
    expect(result.status).toBe('blocked');
    expect(result.findings?.length).toBeGreaterThan(0);
    expect(gitIn(paths.store, 'rev-parse', 'HEAD')).toBe(headBefore); // leak stayed out of history
  });

  it('an agentenv:allow-secret marker recovers a legitimately token-shaped file', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    await run(['init'], { env: th.env });
    await run(['create', 'security'], { env: th.env });

    // A security skill that documents a real-SHAPED token, opted in with the marker.
    writeFileSync(
      join(paths.envDir('security'), 'SKILL.md'),
      `# detect-aws-keys\n\nExample of a leaked key:\n\n    api_key: ${REAL_AWS_KEY}  # agentenv:allow-secret\n`,
    );
    const result = await commitStore(paths, th.env, 'agentenv: add security skill');
    expect(result.status).toBe('committed');
  });

  it('a pre-existing flagged file no longer blocks committing a DIFFERENT clean file', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    await run(['init'], { env: th.env });
    await run(['create', 'writing'], { env: th.env });

    // A file carrying a real token slipped into history (e.g. an older tool version,
    // or a raw `--no-verify` commit). It must NOT wedge every future commit.
    writeFileSync(join(paths.envDir('writing'), 'old-leak.txt'), `api_key: ${REAL_AWS_KEY}\n`);
    gitIn(paths.store, 'add', '-A');
    gitIn(paths.store, '-c', 'user.name=x', '-c', 'user.email=x@y', 'commit', '-m', 'raw leak', '--no-verify');

    // Now commit a completely unrelated, clean file: the whole-tree scan would have
    // blocked this; the staged-diff scan must let it through.
    writeFileSync(join(paths.envDir('writing'), 'clean.txt'), 'nothing secret here\n');
    const result = await commitStore(paths, th.env, 'agentenv: add clean file');
    expect(result.status).toBe('committed');
  });
});
