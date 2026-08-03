import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readApprovals } from '../src/session/approvals.js';
import { readSessionRegistry } from '../src/session/registry.js';
import { capturePathIdentity } from '../src/path-identity.js';
import { resolvePaths } from '../src/paths.js';
import { readState } from '../src/state.js';
import {
  closedGateShimScript,
  migrateV1,
  migrationWorkspace,
  type MigrationBoundary,
} from '../src/migration.js';
import { makeFixtureAdapter } from './fixtures/fixture-adapter.js';
import { makeTempHome, type TempHome } from './helpers.js';

const homes: TempHome[] = [];
const externalRoots: string[] = [];
function home(): TempHome {
  const result = makeTempHome();
  homes.push(result);
  return result;
}
afterEach(() => {
  for (const entry of homes.splice(0)) entry.cleanup();
  for (const entry of externalRoots.splice(0)) rmSync(entry, { recursive: true, force: true });
});

function write(path: string, contents: string, mode?: number): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents, mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
  if (mode !== undefined) chmodSync(path, mode);
}

function cmFixture(th: TempHome): { external: string; paths: ReturnType<typeof resolvePaths> } {
  const paths = resolvePaths(th.env);
  const externalRoot = join(th.home, '..', `${th.home.split('/').at(-1)}-external`);
  externalRoots.push(externalRoot);
  const external = join(externalRoot, 'review');
  write(paths.envYaml('work'), 'version: 1.0\nname: work\n');
  write(join(paths.envDir('work'), 'skills', 'review', 'SKILL.md'), '# review\n');
  mkdirSync(join(external, '..'), { recursive: true });
  write(paths.state, `${JSON.stringify({
    version: '1.0',
    items: [
      {
        surface: 'dir-merge',
        action: 'symlink',
        path: external,
        target: join(paths.envDir('work'), 'skills', 'review'),
        ownerEnv: 'work',
        backupRef: { kind: 'absent' },
      },
    ],
    globalStack: ['work'],
  }, null, 2)}\n`);
  write(join(paths.base, 'sessions.json'), '{"version":"1.0","bindings":[]}\n');
  write(join(paths.live, 'S1', 'fixture', 'config.txt'), 'legacy CM view bytes\n');
  write(join(paths.live, 'S1', 'fixture.meta.json'), '{"fingerprint":"old","generation":1}\n');
  write(join(paths.shims, 'fixture-harness'), '#!/bin/sh\nprintf old-shim\n', 0o755);
  write(external, 'owned external bytes\n');
  return { external, paths };
}

function jjFixture(th: TempHome): { external: string; paths: ReturnType<typeof resolvePaths> } {
  const paths = resolvePaths(th.env);
  const externalRoot = join(th.home, '..', `${th.home.split('/').at(-1)}-jj-external`);
  externalRoots.push(externalRoot);
  const external = join(externalRoot, 'review');
  const storeSkill = join(paths.envDir('work'), 'skills', 'review');
  write(paths.envYaml('work'), 'version: 1.0\nname: work\n');
  write(join(storeSkill, 'SKILL.md'), '# review\n');
  write(external, 'owned JJ external bytes\n');
  write(paths.state, `${JSON.stringify({
    version: '1.0',
    journal: [],
    ownership: [
      {
        env: 'work',
        hash: 'legacy-hash',
        kind: 'copy',
        path: external,
        source: storeSkill,
        surface: 'fixture.skills',
      },
    ],
    blocks: [],
    configKeys: [],
    globalActivations: [{ adapterId: 'fixture', environments: ['work'] }],
    adoptions: [],
    approvedProjects: ['/tmp/approved-project'],
    inventories: [],
    shadowing: [],
  }, null, 2)}\n`);
  write(join(paths.base, 'sessions.json'), `${JSON.stringify({
    version: '1.0',
    bindings: [
      {
        sessionId: 'S1',
        projectRoot: '/tmp/project',
        environments: ['work'],
        updatedAt: '2026-08-01T12:00:00.000Z',
      },
    ],
  })}\n`);
  const view = join(paths.live, 'S1', 'fixture', 'fingerprint-1');
  write(join(view, 'skills', 'review', 'SKILL.md'), '# review\n');
  write(join(view, '.agentenv-view.json'), `${JSON.stringify({
    adapter: 'fixture',
    environments: ['work'],
    fingerprint: 'fingerprint-1',
    inventories: { skills: ['review'] },
    version: '1.0',
  })}\n`);
  write(join(paths.shims, 'fixture-harness'), '#!/bin/sh\nprintf jj-old-shim\n', 0o755);
  return { external, paths };
}

const quiet = {
  adapters: [makeFixtureAdapter()],
  listHarnessProcesses: async () => [],
  now: () => 1_754_112_000_000,
};

describe('gated v1 migration', () => {
  it('migrates CM v1 while retaining every unattributed live tree', async () => {
    const th = home();
    const { external, paths } = cmFixture(th);
    const externalBefore = await capturePathIdentity(external);

    const result = await migrateV1({ paths, ...quiet });

    expect(result).toMatchObject({ sourceFormat: 'cm-v1', status: 'opened' });
    const state = await readState(paths);
    expect(state.version).toBe('2.0');
    expect(state.items).toHaveLength(1);
    expect(state.migration).toMatchObject({ phase: 'opened', gate: 'open', commitPoint: true });
    expect(state.generations).toEqual([
      expect.objectContaining({
        adapterId: 'fixture',
        session: 'S1',
        phase: 'quarantined',
        viewRoot: join(paths.live, 'S1', 'fixture'),
      }),
    ]);
    expect(readFileSync(join(paths.live, 'S1', 'fixture', 'config.txt'), 'utf8')).toBe('legacy CM view bytes\n');
    expect(await capturePathIdentity(external)).toEqual(externalBefore);
    expect(readFileSync(join(paths.shims, 'fixture-harness'), 'utf8')).toContain('agentenv __shim');
  });

  it('migrates JJ v1 inventories, sessions, approvals, and ownership', async () => {
    const th = home();
    const { paths } = jjFixture(th);

    const result = await migrateV1({ paths, ...quiet });

    expect(result.sourceFormat).toBe('jj-v1');
    const state = await readState(paths);
    expect(state.items).toEqual([
      expect.objectContaining({
        surface: 'dir-merge',
        action: 'copy',
        ownerEnv: 'work',
      }),
    ]);
    expect(state.generations).toEqual([
      expect.objectContaining({
        adapterId: 'fixture',
        envs: ['work'],
        fingerprint: 'fingerprint-1',
        phase: 'quarantined',
        inventory: [
          expect.objectContaining({ surfaceId: 'legacy:fixture:skills', baseline: ['review'] }),
        ],
      }),
    ]);
    expect((await readSessionRegistry(paths)).bindings).toEqual([
      expect.objectContaining({ session: 'S1', projectRoot: '/tmp/project', envs: ['work'] }),
    ]);
    expect((await readApprovals(paths)).approvals['/tmp/approved-project']).toEqual({
      approvedAt: 1_754_112_000_000,
    });
  });

  it('rolls back when an installed adapter cannot prove the migrated view', async () => {
    const th = home();
    const { external, paths } = cmFixture(th);
    const rootBefore = await capturePathIdentity(paths.base);
    const externalBefore = await capturePathIdentity(external);
    const adapter = makeFixtureAdapter({
      forceSelfCheck: { ok: false, detail: 'fixture rejected the migration view' },
    });
    adapter.detect = async () => true;

    await expect(
      migrateV1({
        paths,
        adapters: [adapter],
        env: th.env,
        listHarnessProcesses: async () => [],
        now: quiet.now,
      }),
    ).rejects.toThrow(/fixture.*rejected the migration view/i);

    expect(await capturePathIdentity(paths.base)).toEqual(rootBefore);
    expect(await capturePathIdentity(external)).toEqual(externalBefore);
  });

  it.each<MigrationBoundary>([
    'gate-installed',
    'quiescent',
    'root-backed-up',
    'external-backed-up',
    'import-staged',
    'old-root-moved',
    'pointer-switched',
    'probes-passed',
    'before-open',
  ])('rolls back byte-identically when %s fails before opening', async (boundary) => {
    const th = home();
    const { external, paths } = cmFixture(th);
    const rootBefore = await capturePathIdentity(paths.base);
    const externalBefore = await capturePathIdentity(external);

    await expect(
      migrateV1({
        paths,
        ...quiet,
        afterBoundary: (observed) => {
          if (observed === boundary) throw new Error(`fault at ${boundary}`);
        },
      }),
    ).rejects.toThrow(`fault at ${boundary}`);

    expect(await capturePathIdentity(paths.base)).toEqual(rootBefore);
    expect(await capturePathIdentity(external)).toEqual(externalBefore);
    const wal = JSON.parse(readFileSync(join(migrationWorkspace(paths), 'wal.json'), 'utf8')) as {
      migration: { phase: string; gate: string; commitPoint: boolean };
    };
    expect(wal.migration).toMatchObject({ phase: 'rolled-back', gate: 'closed', commitPoint: false });
  });

  it('refuses non-quiescent migration and restores the original shim', async () => {
    const th = home();
    const { paths } = cmFixture(th);
    const before = readFileSync(join(paths.shims, 'fixture-harness'), 'utf8');

    await expect(
      migrateV1({
        paths,
        ...quiet,
        listHarnessProcesses: async () => [{ pid: 444, command: 'codex --resume' }],
      }),
    ).rejects.toThrow(/end every legacy harness process.*444/i);
    expect(readFileSync(join(paths.shims, 'fixture-harness'), 'utf8')).toBe(before);
  });

  it('emits a standalone closed gate that never calls either CLI version', () => {
    const script = closedGateShimScript('codex', '/tmp/agentenv/shims');
    expect(script).not.toContain('agentenv __shim');
    expect(script).not.toContain('agentenv _shim');
    expect(script).toContain('migration in progress');
    expect(script).toContain('exec "$real" "$@"');
  });
});
