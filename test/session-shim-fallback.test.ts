import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { shimScript } from '../src/session/shims.js';
import { makeTempHome, type TempHome } from './helpers.js';

const homes: TempHome[] = [];
function home(): TempHome {
  const h = makeTempHome();
  homes.push(h);
  return h;
}
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
});

const BIN = 'fixture-harness';
const MARKER = 'H1_REAL_HARNESS_RAN';

/**
 * H1 regression: the agentenv-absent fallback must NEVER exec-loop through the
 * shim. A trailing-slash (or symlinked) shims dir on PATH used to miss the
 * byte-exact strip → the shim re-exec'd itself forever and the real binary never
 * ran, bricking the tool.
 */
describe('session shim fallback (agentenv absent)', () => {
  it('a TRAILING-SLASH shims dir on PATH still runs the real binary (no exec loop)', () => {
    const th = home();
    const shimsDir = join(th.home, 'shims');
    const realDir = join(th.home, 'realbin');
    mkdirSync(shimsDir, { recursive: true });
    mkdirSync(realDir, { recursive: true });

    // The generated shim, named after the harness, first on PATH.
    const shimPath = join(shimsDir, BIN);
    writeFileSync(shimPath, shimScript(BIN, shimsDir), 'utf8');
    chmodSync(shimPath, 0o755);

    // The REAL binary, same name, in a different PATH dir.
    const realPath = join(realDir, BIN);
    writeFileSync(realPath, `#!/bin/sh\nprintf '%s\\n' '${MARKER}'\n`, 'utf8');
    chmodSync(realPath, 0o755);

    // PATH: shims dir FIRST with a TRAILING SLASH, then the real binary's dir.
    // No `agentenv` anywhere on this PATH → the fallback branch runs.
    const env: NodeJS.ProcessEnv = { PATH: `${shimsDir}/${delimiter}${realDir}` };

    const res = spawnSync(shimPath, ['--print-config-root'], {
      env,
      encoding: 'utf8',
      timeout: 4000,
    });

    // If the shim exec-loops, spawnSync kills it on timeout (signal set, no output).
    expect(res.signal).toBeNull();
    expect(res.stdout).toContain(MARKER);
    expect(res.status).toBe(0);
  });
});
