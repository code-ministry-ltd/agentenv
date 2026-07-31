import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface PackageJson {
  version: string;
}

/**
 * Resolve the CLI version from the package manifest.
 *
 * The manifest sits one directory above this module both in source
 * (`src/version.ts` -> `../package.json`) and in the build output
 * (`dist/version.js` -> `../package.json`), so the same relative lookup
 * works whether the code runs from source (tests) or from `dist` (the
 * published/global CLI).
 */
export function getVersion(): string {
  const url = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as PackageJson;
  return pkg.version;
}
