import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { makeTempHome, type TempHome } from './helpers.js';

describe('list', () => {
  let tmp: TempHome;
  beforeEach(() => {
    tmp = makeTempHome();
  });
  afterEach(() => {
    tmp.cleanup();
  });

  it('prints a friendly line and exits 0 for an empty store', async () => {
    const result = await run(['list'], { env: tmp.env });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/no environments/i);
  });

  it('lists environment names in stable sorted order', async () => {
    await run(['create', 'writing'], { env: tmp.env });
    await run(['create', 'blogging'], { env: tmp.env });
    await run(['create', 'admin'], { env: tmp.env });

    const result = await run(['list'], { env: tmp.env });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('admin\nblogging\nwriting\n');
  });

  it('fails with a file-named, line-numbered error on a mangled env.yaml', async () => {
    await run(['create', 'writing'], { env: tmp.env });
    const file = join(tmp.home, 'store', 'environments', 'writing', 'env.yaml');
    writeFileSync(file, 'version: "1.0"\ndescription: d\ncapture: [unclosed\n', 'utf8');

    const result = await run(['list'], { env: tmp.env });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/env\.yaml:\d+/);
  });
});
