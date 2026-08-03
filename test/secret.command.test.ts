import { describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';

describe('settled secret-management surface', () => {
  it('does not expose a command that accepts secret values through argv', async () => {
    const value = 'ghp_supersecretvalue123';
    const result = await run(['secret', 'set', 'GH_TOKEN', value]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unknown command 'secret'");
    expect(result.stderr).not.toContain(value);
  });

  it('does not advertise secret management in help', async () => {
    const result = await run(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toMatch(/^\s+secret\b/m);
  });
});
