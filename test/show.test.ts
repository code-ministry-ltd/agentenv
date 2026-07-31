import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { makeTempHome, type TempHome } from './helpers.js';

describe('show', () => {
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
  function writeYaml(name: string, text: string): void {
    writeFileSync(join(envDir(name), 'env.yaml'), text, 'utf8');
  }

  it('prints the manifest fields', async () => {
    await run(['create', 'writing'], { env: tmp.env });
    writeYaml(
      'writing',
      ['version: "1.0"', 'description: my writing env', 'notes: keep it terse', 'capture:', '  ignore:', '    - "**/*.log"'].join(
        '\n',
      ),
    );

    const result = await run(['show', 'writing'], { env: tmp.env });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('writing');
    expect(result.stdout).toContain('1.0');
    expect(result.stdout).toContain('my writing env');
    expect(result.stdout).toContain('keep it terse');
    expect(result.stdout).toContain('**/*.log');
  });

  it('reports an item inventory of content subdirectories that exist', async () => {
    await run(['create', 'writing'], { env: tmp.env });
    mkdirSync(join(envDir('writing'), 'skills', 'sharpen'), { recursive: true });

    const result = await run(['show', 'writing'], { env: tmp.env });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/skills/);
  });

  it('errors on an unknown environment', async () => {
    const result = await run(['show', 'ghost'], { env: tmp.env });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('ghost');
  });

  it('loads an env with a newer MINOR version', async () => {
    await run(['create', 'writing'], { env: tmp.env });
    writeYaml('writing', 'version: "1.9"\ndescription: d\n');

    const result = await run(['show', 'writing'], { env: tmp.env });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('1.9');
  });

  it('refuses an env with a newer MAJOR version with the upgrade message', async () => {
    await run(['create', 'writing'], { env: tmp.env });
    writeYaml('writing', 'version: "2.0"\ndescription: d\n');

    const result = await run(['show', 'writing'], { env: tmp.env });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('store newer than CLI — upgrade agentenv');
  });

  it('fails with a file-named, line-numbered error on a mangled env.yaml', async () => {
    await run(['create', 'writing'], { env: tmp.env });
    writeYaml('writing', 'version: "1.0"\ndescription: d\ncapture: [unclosed\n');

    const result = await run(['show', 'writing'], { env: tmp.env });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/env\.yaml:\d+/);
  });

  it('requires a name', async () => {
    const result = await run(['show'], { env: tmp.env });
    expect(result.code).not.toBe(0);
  });
});
