import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { resolvePaths } from '../src/paths.js';
import { makeTempHome, type TempHome } from './helpers.js';

/**
 * `agentenv secret set|list|rm` (Task 2.4): manage machine-local `${VAR}` values.
 * The value never leaves secrets.env; `list` MASKS every value; no command echoes
 * a value back.
 */

const homes: TempHome[] = [];
function home(): TempHome {
  const h = makeTempHome();
  homes.push(h);
  return h;
}
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
});

describe('secrets command: set / list / rm', () => {
  it('set writes secrets.env without echoing the value', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const res = await run(['secret', 'set', 'GH_TOKEN', 'ghp_supersecretvalue123'], { env: th.env });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Set secret GH_TOKEN');
    expect(res.stdout).not.toContain('ghp_supersecretvalue123'); // value never echoed
    // The value is persisted machine-local, outside the store.
    expect(readFileSync(paths.secrets, 'utf8')).toContain('GH_TOKEN=ghp_supersecretvalue123');
  });

  it('list masks values and never prints them', async () => {
    const th = home();
    await run(['secret', 'set', 'GH_TOKEN', 'ghp_supersecretvalue123'], { env: th.env });
    await run(['secret', 'set', 'LINEAR_TOKEN', 'lin_anothersecret456'], { env: th.env });
    const res = await run(['secret', 'list'], { env: th.env });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('GH_TOKEN');
    expect(res.stdout).toContain('LINEAR_TOKEN');
    expect(res.stdout).not.toContain('ghp_supersecretvalue123');
    expect(res.stdout).not.toContain('lin_anothersecret456');
    expect(res.stdout).toMatch(/•/); // masked
  });

  it('set updates an existing key, reported as Updated', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    await run(['secret', 'set', 'K', 'v1'], { env: th.env });
    const res = await run(['secret', 'set', 'K', 'v2'], { env: th.env });
    expect(res.stdout).toContain('Updated secret K');
    expect(readFileSync(paths.secrets, 'utf8')).toContain('K=v2');
    expect(readFileSync(paths.secrets, 'utf8')).not.toContain('v1');
  });

  it('rejects an invalid key', async () => {
    const th = home();
    const res = await run(['secret', 'set', '1BAD', 'x'], { env: th.env });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('invalid key');
  });

  it('list on an empty store is a friendly no-op', async () => {
    const th = home();
    const res = await run(['secret', 'list'], { env: th.env });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('No secrets set');
  });

  it('rm removes a key; removing a missing key is a no-op', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    await run(['secret', 'set', 'K', 'v'], { env: th.env });
    const removed = await run(['secret', 'rm', 'K'], { env: th.env });
    expect(removed.stdout).toContain('Removed secret K');
    expect(readFileSync(paths.secrets, 'utf8')).not.toContain('K=');
    const again = await run(['secret', 'rm', 'K'], { env: th.env });
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('No secret K');
  });

  it('an unknown action errors with usage', async () => {
    const th = home();
    const res = await run(['secret', 'frobnicate'], { env: th.env });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("unknown action 'frobnicate'");
  });
});
