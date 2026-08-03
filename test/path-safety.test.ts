import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { makeTempHome, type TempHome } from './helpers.js';

/**
 * Regression for a Critical found in review: every name-taking command must
 * reject an invalid env name BEFORE building a path, because path.join collapses
 * `..` and would otherwise let `rm`/`show`/`edit` escape the store — `rm ..`
 * wiped the whole store, `rm ../../x` deleted arbitrary sibling directories.
 * The original suite only exercised traversal against `create`, so the hole in
 * rm/show/edit shipped green. These cover all four.
 */
describe('store path-safety: env-name validation blocks traversal', () => {
  let tmp: TempHome;
  beforeEach(async () => {
    tmp = makeTempHome();
    await run(['create', 'work'], { env: tmp.env });
    await run(['create', 'play'], { env: tmp.env });
  });
  afterEach(() => {
    tmp.cleanup();
  });

  const storeDir = (): string => join(tmp.home, 'store');
  const envDir = (name: string): string => join(storeDir(), 'environments', name);

  // Traversal attempts plus a few plain-invalid names; none may be accepted.
  const badNames = ['..', '.', '../x', '../../etc', 'a/b', '/abs', 'Up', 'has space', '.hidden'];

  for (const bad of badNames) {
    it(`rm rejects '${bad}' (deletes nothing, store intact)`, async () => {
      const result = await run(['rm', bad], { env: tmp.env });
      expect(result.code).not.toBe(0);
      // store and both real environments must survive unscathed.
      expect(existsSync(storeDir())).toBe(true);
      expect(existsSync(envDir('work'))).toBe(true);
      expect(existsSync(envDir('play'))).toBe(true);
    });

    it(`show rejects '${bad}' (no out-of-store read)`, async () => {
      const result = await run(['show', bad], { env: tmp.env });
      expect(result.code).not.toBe(0);
    });

    it(`edit rejects '${bad}' (no out-of-store open)`, async () => {
      const result = await run(['edit', bad, '--print-path'], { env: tmp.env });
      expect(result.code).not.toBe(0);
    });
  }

  it('rm cannot delete a directory outside the store via traversal', async () => {
    // A sentinel that a naive `rm ../../sentinel` would have destroyed.
    const sentinel = join(tmp.home, 'sentinel');
    mkdirSync(sentinel, { recursive: true });
    writeFileSync(join(sentinel, 'keep.txt'), 'do not delete');

    const result = await run(['rm', '../../sentinel'], { env: tmp.env });
    expect(result.code).not.toBe(0);
    expect(existsSync(join(sentinel, 'keep.txt'))).toBe(true);
  });
});
