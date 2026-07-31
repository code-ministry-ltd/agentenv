import { describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { getVersion } from '../src/version.js';

describe('run', () => {
  it('prints the version and exits 0 for --version', () => {
    const result = run(['--version']);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${getVersion()}\n`);
  });

  it('prints the version for the -v alias', () => {
    const result = run(['-v']);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${getVersion()}\n`);
  });

  it('prints usage and exits 0 for --help', () => {
    const result = run(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage');
    expect(result.stdout).toContain('agentenv');
  });

  it('prints usage when invoked with no arguments', () => {
    const result = run([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage');
  });
});
