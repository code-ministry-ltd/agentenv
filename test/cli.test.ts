import { describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { getVersion } from '../src/version.js';

describe('run', () => {
  it('prints the version and exits 0 for --version', async () => {
    const result = await run(['--version']);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${getVersion()}\n`);
  });

  it('prints the version for the -v alias', async () => {
    const result = await run(['-v']);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${getVersion()}\n`);
  });

  it('prints usage and exits 0 for --help', async () => {
    const result = await run(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage');
    expect(result.stdout).toContain('agentenv');
  });

  it('prints usage when invoked with no arguments', async () => {
    const result = await run([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage');
  });

  it('errors on an unknown command with a non-zero exit and a hint', async () => {
    const result = await run(['frobnicate']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unknown command 'frobnicate'");
    expect(result.stderr).toContain('--help');
  });

  it('never writes to stdout on an unknown command', async () => {
    const result = await run(['frobnicate']);
    expect(result.stdout).toBe('');
  });
});
