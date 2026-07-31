import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getVersion } from '../src/version.js';

interface PackageJson {
  version: string;
}

function readPackageVersion(): string {
  const url = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as PackageJson;
  return pkg.version;
}

describe('getVersion', () => {
  it('returns the version declared in package.json', () => {
    expect(getVersion()).toBe(readPackageVersion());
  });

  it('returns a valid semver string', () => {
    expect(getVersion()).toMatch(/^\d+\.\d+\.\d+(?:[-+].*)?$/);
  });
});
