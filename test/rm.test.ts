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

  it('removes the environment after confirmation', async () => {
    await run(['create', 'writing'], { env: tmp.env });
    expect(existsSync(envDir('writing'))).toBe(true);
    let prompt = '';

    const result = await run(['rm', 'writing'], {
      env: tmp.env,
      confirm: async (message) => {
        prompt = message;
        return true;
      },
    });
    expect(prompt).toBe("Remove environment 'writing'? This cannot be undone. [y/N] ");
    expect(result).toEqual({ stdout: "Removed environment 'writing'.\n", code: 0 });
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
    expect(result).toEqual({ stdout: "Aborted; 'writing' was not removed.\n", code: 0 });
  });

  it('does NOT remove in a non-interactive path', async () => {
    await run(['create', 'writing'], { env: tmp.env });
    // No injected confirm and no TTY (vitest) -> safe default is to decline.
    const result = await run(['rm', 'writing'], { env: tmp.env });
    expect(existsSync(envDir('writing'))).toBe(true);
    expect(result.code).toBe(0);
  });

  it('errors on an unknown environment', async () => {
    const result = await run(['rm', 'ghost'], { env: tmp.env });
    expect(result).toEqual({
      stdout: '',
      stderr: "rm: environment 'ghost' does not exist\n",
      code: 1,
    });
  });

  it('requires a name', async () => {
    const result = await run(['rm'], { env: tmp.env });
    expect(result).toEqual({
      stdout: '',
      stderr: 'rm: missing environment name\nUsage: agentenv rm <name>\n',
      code: 1,
    });
  });

  it('preserves exact validation and argument errors before touching the store', async () => {
    expect(await run(['rm', '../escape'], { env: tmp.env })).toEqual({
      stdout: '',
      stderr: "rm: invalid environment name '../escape' (lowercase letters, digits, '-' and '_'; must start and end with a letter or digit; 1–64 chars)\n",
      code: 1,
    });
    expect(await run(['rm', 'writing', 'extra'], { env: tmp.env })).toEqual({
      stdout: '',
      stderr: "rm: unexpected argument 'extra'\nUsage: agentenv rm <name>\n",
      code: 1,
    });
    expect(await run(['rm', '--unknown'], { env: tmp.env })).toEqual({
      stdout: '',
      stderr: "rm: unknown option '--unknown'\n",
      code: 1,
    });
    expect(existsSync(join(tmp.home, 'store'))).toBe(false);
  });
});
