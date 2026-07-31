import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateAdapter } from '../src/adapter.js';
import {
  FAKE_HARNESS_SCRIPT,
  FIXTURE_CONFIG_ENV,
  installFixtureHarness,
  makeFixtureAdapter,
} from './fixtures/fixture-adapter.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'agentenv-fixture-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('session fixture harness', () => {
  it('prints its observed config root from FIXTURE_CONFIG_DIR', () => {
    const root = tmp();
    const res = spawnSync('node', [FAKE_HARNESS_SCRIPT, '--print-config-root'], {
      env: { ...process.env, [FIXTURE_CONFIG_ENV]: root },
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe(root);
  });

  it('lists the skills it observes under the config root', () => {
    const root = tmp();
    mkdirSync(join(root, 'skills', 'alpha'), { recursive: true });
    mkdirSync(join(root, 'skills', 'beta'), { recursive: true });
    const res = spawnSync('node', [FAKE_HARNESS_SCRIPT, '--list-skills'], {
      env: { ...process.env, [FIXTURE_CONFIG_ENV]: root },
      encoding: 'utf8',
    });
    expect(res.stdout.trim()).toBe('alpha,beta');
  });

  it('detect() is true once the fixture harness is on PATH', async () => {
    const bin = tmp();
    installFixtureHarness(bin);
    const a = makeFixtureAdapter();
    expect(await a.detect({ PATH: bin })).toBe(true);
    expect(await a.detect({ PATH: tmp() })).toBe(false);
  });

  it('compileConfigKeys turns servers.yaml into per-server keyed injections', async () => {
    const envDir = tmp();
    mkdirSync(join(envDir, 'mcp'), { recursive: true });
    writeFileSync(
      join(envDir, 'mcp', 'servers.yaml'),
      'linear:\n  transport: http\n  url: https://mcp.linear.app/mcp\n',
    );
    const a = makeFixtureAdapter();
    const mcp = a.surfaces.find((s) => s.id === 'mcp')!;
    const injections = await a.compileConfigKeys(mcp as never, envDir);
    expect(injections).toEqual([
      {
        style: 'keyed',
        keyPath: ['mcpServers', 'linear'],
        value: { transport: 'http', url: 'https://mcp.linear.app/mcp' },
      },
    ]);
  });

  it('a session-unsupported fixture variant validates and carries a reason', () => {
    const a = makeFixtureAdapter({ sessionSupported: false });
    expect(validateAdapter(a)).toBeNull();
    expect(a.sessionSupported).toBe(false);
    expect(a.sessionUnsupportedReason).toContain('--global');
  });
});
