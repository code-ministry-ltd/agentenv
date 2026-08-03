import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { resolvePaths } from '../src/paths.js';
import { readState } from '../src/state.js';
import { installFixtureHarness, makeFixtureAdapter } from './fixtures/fixture-adapter.js';
import { makeTempHome, type TempHome } from './helpers.js';

const homes: TempHome[] = [];
function home(): TempHome {
  const result = makeTempHome();
  homes.push(result);
  return result;
}
afterEach(() => {
  for (const entry of homes.splice(0)) entry.cleanup();
});

function write(path: string, contents: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

function cmState(th: TempHome): ReturnType<typeof resolvePaths> {
  const paths = resolvePaths(th.env);
  write(paths.envYaml('work'), 'version: 1.0\nname: work\n');
  write(paths.state, '{"version":"1.0","items":[],"globalStack":[]}\n');
  write(join(paths.shims, 'fixture-harness'), '#!/bin/sh\nexit 0\n');
  return paths;
}

function closedWal(paths: ReturnType<typeof resolvePaths>): void {
  write(
    `${paths.base}.migration/wal.json`,
    `${JSON.stringify({
      version: '1.0',
      migration: {
        schemaVersion: 2,
        id: 'migration-pending',
        sourceFormat: 'cm-v1',
        phase: 'importing',
        gate: 'closed',
        commitPoint: false,
        backupRef: `${paths.base}.migration`,
        failure: null,
      },
      gateEntries: [],
      externalEntries: [],
      rootBackup: null,
      cutover: 'not-started',
      createdAt: 1,
      sourceStateDigest: 'digest',
      sourceRootIdentity: { kind: 'directory', digest: 'digest', mode: 448 },
    }, null, 2)}\n`,
  );
}

describe('migration CLI and launch gate', () => {
  it('exposes the explicit migrate command and opens a clean CM fixture', async () => {
    const th = home();
    const paths = cmState(th);
    const result = await run(['migrate'], {
      env: th.env,
      adapters: [makeFixtureAdapter()],
      migration: { listHarnessProcesses: async () => [], now: () => 123 },
    });

    expect(result).toMatchObject({ code: 0 });
    expect(result.stdout).toContain('Migrated cm-v1');
    expect((await readState(paths)).migration).toMatchObject({ phase: 'opened', gate: 'open' });
  });

  it('blocks ordinary commands on a legacy root before the closed gate is installed', async () => {
    const th = home();
    cmState(th);

    const result = await run(['create', 'new-env'], { env: th.env });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("run 'agentenv migrate'");
  });

  it('blocks mutations while the migration WAL is closed', async () => {
    const th = home();
    const paths = cmState(th);
    closedWal(paths);

    const result = await run(['create', 'new-env'], { env: th.env });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('migration gate is closed');
  });

  it('makes a directly-invoked current shim fail open while the external gate is closed', async () => {
    const th = home();
    const paths = cmState(th);
    closedWal(paths);
    const bin = join(th.home, 'bin');
    installFixtureHarness(bin);
    const calls: Array<{ env: NodeJS.ProcessEnv }> = [];

    const result = await run(['__shim', 'fixture-harness', '--'], {
      env: { ...th.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` },
      adapters: [makeFixtureAdapter()],
      execHarness: async (spec) => {
        calls.push({ env: spec.env });
        return 0;
      },
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('migration gate is closed');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.env.FIXTURE_CONFIG_DIR).toBeUndefined();
  });

  it('rolls back an interrupted pre-commit WAL explicitly', async () => {
    const th = home();
    const paths = cmState(th);
    closedWal(paths);

    const result = await run(['migrate', '--rollback'], { env: th.env });

    expect(result).toMatchObject({ code: 0 });
    expect(result.stdout).toContain('rolled back');
    const wal = readFileSync(`${paths.base}.migration/wal.json`, 'utf8');
    expect(wal).toContain('rolled-back');
  });
});
