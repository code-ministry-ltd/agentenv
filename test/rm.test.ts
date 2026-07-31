import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { makeTempHome, type TempHome } from './helpers.js';

describe('rm', () => {
  let tmp: TempHome;
  beforeEach(() => {
    tmp = makeTempHome();
  });
  afterEach(() => {
    tmp.cleanup();
  });

  function envDir(name: string): string {
    return join(tmp.home, 'store', 'environments', name);
  }

  it('removes the environment with --yes (no prompt)', async () => {
    await run(['create', 'writing'], { env: tmp.env });
    expect(existsSync(envDir('writing'))).toBe(true);

    const result = await run(['rm', 'writing', '--yes'], { env: tmp.env });
    expect(result.code).toBe(0);
    expect(existsSync(envDir('writing'))).toBe(false);
  });

  it('removes when an injected confirm returns true', async () => {
    await run(['create', 'writing'], { env: tmp.env });
    const result = await run(['rm', 'writing'], {
      env: tmp.env,
      confirm: async () => true,
    });
    expect(result.code).toBe(0);
    expect(existsSync(envDir('writing'))).toBe(false);
  });

  it('does NOT remove when confirmation is declined', async () => {
    await run(['create', 'writing'], { env: tmp.env });
    const result = await run(['rm', 'writing'], {
      env: tmp.env,
      confirm: async () => false,
    });
    expect(result.code).toBe(0);
    expect(existsSync(envDir('writing'))).toBe(true);
    expect(result.stdout).toMatch(/not removed|aborted/i);
  });

  it('does NOT remove in a non-interactive path without --yes', async () => {
    await run(['create', 'writing'], { env: tmp.env });
    // No injected confirm and no TTY (vitest) -> safe default is to decline.
    const result = await run(['rm', 'writing'], { env: tmp.env });
    expect(existsSync(envDir('writing'))).toBe(true);
    expect(result.code).toBe(0);
  });

  it('errors on an unknown environment', async () => {
    const result = await run(['rm', 'ghost', '--yes'], { env: tmp.env });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('ghost');
  });

  it('requires a name', async () => {
    const result = await run(['rm', '--yes'], { env: tmp.env });
    expect(result.code).not.toBe(0);
  });
});
