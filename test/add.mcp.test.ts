import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { expectRealHomeUntouched, makeTempHome, realHomeSnapshot, type TempHome } from './helpers.js';

describe('add mcp', () => {
  let tmp: TempHome;
  beforeEach(async () => {
    tmp = makeTempHome();
    await run(['create', 'writing'], { env: tmp.env });
  });
  afterEach(() => {
    tmp.cleanup();
  });

  const serversYaml = (): string => join(tmp.home, 'store', 'environments', 'writing', 'mcp', 'servers.yaml');
  const readServers = (): Record<string, unknown> => parseYaml(readFileSync(serversYaml(), 'utf8'));

  it('scaffolds a canonical stdio server with a ${VAR} placeholder', async () => {
    const real = realHomeSnapshot();
    const result = await run(['add', 'mcp', 'writing', 'github'], { env: tmp.env });
    expect(result.code).toBe(0);

    const servers = readServers();
    const github = servers.github as Record<string, unknown>;
    expect(github.transport).toBe('stdio');
    expect(github.command).toBeDefined();
    // The env block carries a ${VAR} placeholder, never a literal secret.
    expect(JSON.stringify(github.env)).toContain('${');

    expectRealHomeUntouched(real);
  });

  it('supports an http transport with auth.bearer_env', async () => {
    const result = await run(['add', 'mcp', 'writing', 'linear', '--transport', 'http'], { env: tmp.env });
    expect(result.code).toBe(0);
    const linear = readServers().linear as Record<string, unknown>;
    expect(linear.transport).toBe('http');
    expect(linear.url).toBeDefined();
    expect((linear.auth as Record<string, unknown>).bearer_env).toBeDefined();
  });

  it('appends a second server without clobbering the first', async () => {
    await run(['add', 'mcp', 'writing', 'github'], { env: tmp.env });
    await run(['add', 'mcp', 'writing', 'linear'], { env: tmp.env });
    const servers = readServers();
    expect(servers.github).toBeDefined();
    expect(servers.linear).toBeDefined();
  });

  it('refuses to clobber an existing server without --force, overwrites with it', async () => {
    await run(['add', 'mcp', 'writing', 'github'], { env: tmp.env });
    const before = readFileSync(serversYaml(), 'utf8');

    const again = await run(['add', 'mcp', 'writing', 'github'], { env: tmp.env });
    expect(again.code).not.toBe(0);
    expect(again.stderr).toContain('--force');
    expect(readFileSync(serversYaml(), 'utf8')).toBe(before);

    const forced = await run(['add', 'mcp', 'writing', 'github', '--force', '--transport', 'http'], { env: tmp.env });
    expect(forced.code).toBe(0);
    expect((readServers().github as Record<string, unknown>).transport).toBe('http');
  });

  it('rejects an invalid transport and an invalid name', async () => {
    const badTransport = await run(['add', 'mcp', 'writing', 'github', '--transport', 'carrier-pigeon'], { env: tmp.env });
    expect(badTransport.code).not.toBe(0);
    expect(existsSync(serversYaml())).toBe(false);

    const badName = await run(['add', 'mcp', 'writing', 'Bad Name'], { env: tmp.env });
    expect(badName.code).not.toBe(0);
  });

  it('errors when the environment does not exist', async () => {
    const result = await run(['add', 'mcp', 'ghost', 'github'], { env: tmp.env });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('ghost');
  });

  it('--print-path prints servers.yaml without writing', async () => {
    const result = await run(['add', 'mcp', 'writing', 'github', '--print-path'], { env: tmp.env });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(serversYaml());
    expect(existsSync(serversYaml())).toBe(false);
  });
});
