import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Adapter, SurfaceDeclaration } from '../src/adapter.js';
import { cursorAdapter } from '../src/adapters/cursor.js';
import { run } from '../src/cli.js';
import { createCommandPlan } from '../src/command-plan.js';
import { createGlobalProjection } from '../src/global-projection.js';
import { createMigrationState } from '../src/migration-state.js';
import { resolvePaths } from '../src/paths.js';
import { createSyncCandidate } from '../src/sync-candidate.js';
import { readState, writeState } from '../src/state.js';
import { createViewGeneration } from '../src/view-generation.js';
import { FIXTURE_CONFIG_ENV, makeFixtureAdapter } from './fixtures/fixture-adapter.js';
import { makeTempHome, type TempHome } from './helpers.js';

const homes: TempHome[] = [];
function home(): TempHome {
  const h = makeTempHome();
  homes.push(h);
  return h;
}
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
});

async function seedEnv(env: NodeJS.ProcessEnv, name: string): Promise<void> {
  await run(['create', name], { env });
}

describe('engine: status', () => {
  it('shows the session binding for this shell/project', async () => {
    const th = home();
    await seedEnv(th.env, 'writing');
    const env = { ...th.env, AGENTENV_SESSION: 'S1' };
    await run(['use', 'writing'], { env, cwd: th.home });

    const res = await run(['status'], { env, cwd: th.home });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('writing');
    expect(res.stdout.toLowerCase()).toContain('session');
    expect(res.stdout).toContain(th.home);
  });

  it('shows the active global stack and per-surface support', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const realHome = join(th.home, 'real');
    mkdirSync(realHome, { recursive: true });
    mkdirSync(join(paths.envDir('writing'), 'skills', 'w-skill'), { recursive: true });
    writeFileSync(join(paths.envDir('writing'), 'skills', 'w-skill', 'SKILL.md'), '# w\n');
    const env: NodeJS.ProcessEnv = { ...th.env, [FIXTURE_CONFIG_ENV]: realHome };
    await run(['use', 'writing', '--global'], { env, adapters: [makeFixtureAdapter()] });

    const res = await run(['status'], { env, adapters: [makeFixtureAdapter()] });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('writing'); // active global stack
    expect(res.stdout).toContain('skills');
    expect(res.stdout).toContain('config-keys');
    expect(res.stdout.toLowerCase()).toContain('supported');
  });

  it('never pretends an unsupported surface works (D6)', async () => {
    const th = home();
    const base = makeFixtureAdapter();
    const unsupported: SurfaceDeclaration = {
      id: 'mcp-unsupported',
      storeKind: 'mcp',
      supported: false,
      unsupportedReason: 'no native MCP (mimics Pi)',
      mechanism: 'config-keys',
      rootRelativePath: 'nope.json',
      format: 'json',
      style: 'keyed',
      keyPath: ['mcpServers'],
    };
    const adapter: Adapter = { ...base, surfaces: [...base.surfaces, unsupported] };

    const res = await run(['status'], { env: th.env, adapters: [adapter] });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('mcp-unsupported');
    expect(res.stdout.toLowerCase()).toContain('unsupported');
    expect(res.stdout).toContain('no native MCP');
  });

  it('reports shadowing in a two-env stack (D7)', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const realHome = join(th.home, 'real');
    mkdirSync(realHome, { recursive: true });
    for (const name of ['base', 'top']) {
      mkdirSync(join(paths.envDir(name), 'skills', 'shared'), { recursive: true });
      writeFileSync(join(paths.envDir(name), 'skills', 'shared', 'SKILL.md'), `# ${name}\n`);
    }
    const env: NodeJS.ProcessEnv = { ...th.env, [FIXTURE_CONFIG_ENV]: realHome };
    await run(['use', 'base', 'top', '--global'], { env, adapters: [makeFixtureAdapter()] });

    const res = await run(['status'], { env, adapters: [makeFixtureAdapter()] });
    expect(res.code).toBe(0);
    expect(res.stdout.toLowerCase()).toContain('shadow');
    expect(res.stdout).toContain('shared');
  });

  it('surfaces an adapter-level session-unsupported harness (Cursor is global-only, D11/D15)', async () => {
    const th = home();
    const res = await run(['status'], { env: th.env, adapters: [cursorAdapter] });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('cursor');
    // The adapter-level line names it global-only and carries the reason.
    expect(res.stdout).toContain('session-unsupported (global only)');
    expect(res.stdout).toContain('CURSOR_CONFIG_DIR');
  });

  it('a session-supported adapter shows no session-unsupported line', async () => {
    const th = home();
    const res = await run(['status'], { env: th.env, adapters: [makeFixtureAdapter()] });
    expect(res.code).toBe(0);
    expect(res.stdout).not.toContain('session-unsupported');
  });

  it('surfaces every unresolved durable lifecycle family without printing stored reasons', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const state = await readState(paths);
    state.commands.push(createCommandPlan({
      transactionId: 'command-visible',
      kind: 'filesystem-bundle',
      operations: [],
    }));
    state.generations.push({
      ...createViewGeneration('generation-visible', ['writing']),
      phase: 'quarantined',
      failure: 'DO-NOT-PRINT-GENERATION-REASON',
    });
    state.globalProjections.push({
      ...createGlobalProjection('projection-visible', { kind: 'absent' }),
      phase: 'quarantined',
      failure: 'DO-NOT-PRINT-PROJECTION-REASON',
    });
    state.candidates.push({
      ...createSyncCandidate({
        id: 'candidate-visible',
        ref: 'refs/agentenv/candidates/visible',
        worktree: join(paths.live, 'candidates', 'visible'),
        fetchedAt: 1,
        touchedCanonicalPaths: [],
      }),
      phase: 'rejected',
      reason: 'DO-NOT-PRINT-CANDIDATE-REASON',
    });
    state.quarantine.push({
      schemaVersion: 2,
      id: 'rescue-visible',
      kind: 'third-identity',
      path: '/surface',
      retainedPath: join(paths.live, 'quarantine', 'visible'),
      reason: 'DO-NOT-PRINT-RESCUE-REASON',
      createdAt: 1,
      resolved: false,
    });
    state.migration = createMigrationState('migration-visible', 'cm-v1');
    await writeState(paths, state);

    const res = await run(['status'], { env: th.env, adapters: [] });

    for (const id of [
      'command-visible',
      'generation-visible',
      'projection-visible',
      'candidate-visible',
      'rescue-visible',
      'migration-visible',
    ]) {
      expect(res.stdout).toContain(id);
    }
    expect(res.stdout).not.toContain('DO-NOT-PRINT');
  });
});
