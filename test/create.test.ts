import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { parseEnvConfig } from '../src/env-config.js';
import { expectRealHomeUntouched, makeTempHome, realHomeSnapshot, type TempHome } from './helpers.js';

describe('create', () => {
  let tmp: TempHome;
  beforeEach(() => {
    tmp = makeTempHome();
  });
  afterEach(() => {
    tmp.cleanup();
  });

  function envYaml(name: string): string {
    return join(tmp.home, 'store', 'environments', name, 'env.yaml');
  }

  it('scaffolds a valid env.yaml and the store README', async () => {
    const real = realHomeSnapshot();
    const result = await run(['create', 'writing'], { env: tmp.env });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('writing');

    const file = envYaml('writing');
    expect(existsSync(file)).toBe(true);
    const cfg = parseEnvConfig(readFileSync(file, 'utf8'), file);
    expect(cfg.version).toBe('1.0');

    const readme = join(tmp.home, 'store', 'README.md');
    expect(existsSync(readme)).toBe(true);
    expect(readFileSync(readme, 'utf8')).toContain('agentenv');

    expectRealHomeUntouched(real);
  });

  it('does not populate the on-demand subdirectories', async () => {
    await run(['create', 'writing'], { env: tmp.env });
    const dir = join(tmp.home, 'store', 'environments', 'writing');
    expect(existsSync(join(dir, 'skills'))).toBe(false);
    expect(existsSync(join(dir, 'mcp'))).toBe(false);
  });

  it('refuses to overwrite an existing environment', async () => {
    await run(['create', 'writing'], { env: tmp.env });
    const result = await run(['create', 'writing'], { env: tmp.env });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('already exists');
  });

  it('rejects an invalid name', async () => {
    const upper = await run(['create', 'Writing'], { env: tmp.env });
    expect(upper.code).not.toBe(0);
    expect(upper.stderr).toMatch(/invalid environment name/);

    const spaced = await run(['create', 'has space'], { env: tmp.env });
    expect(spaced.code).not.toBe(0);

    const traversal = await run(['create', '..'], { env: tmp.env });
    expect(traversal.code).not.toBe(0);
  });

  it('requires a name', async () => {
    const result = await run(['create'], { env: tmp.env });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toBeTruthy();
  });

  it('copies an existing environment with --from', async () => {
    await run(['create', 'writing'], { env: tmp.env });
    const result = await run(['create', 'blogging', '--from', 'writing'], { env: tmp.env });
    expect(result.code).toBe(0);
    expect(existsSync(envYaml('blogging'))).toBe(true);
    expect(existsSync(envYaml('writing'))).toBe(true);
  });

  it('errors when --from names a missing environment', async () => {
    const result = await run(['create', 'blogging', '--from', 'ghost'], { env: tmp.env });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('ghost');
    expect(existsSync(envYaml('blogging'))).toBe(false);
  });
});
