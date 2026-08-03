import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { createCommandPlan } from '../src/command-plan.js';
import { createGlobalProjection, publishProjection } from '../src/global-projection.js';
import { createMigrationState } from '../src/migration-state.js';
import { resolvePaths } from '../src/paths.js';
import { createSyncCandidate } from '../src/sync-candidate.js';
import { readState, writeState } from '../src/state.js';
import { createViewGeneration, publishGeneration } from '../src/view-generation.js';
import { makeTempHome, type TempHome } from './helpers.js';

const homes: TempHome[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) home.cleanup();
});

describe('doctor: durable lifecycle diagnostics', () => {
  it('reports every unresolved lifecycle family without printing stored reasons', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const state = await readState(paths);

    state.commands.push(
      createCommandPlan({
        transactionId: 'command-1',
        kind: 'activation',
        operations: [{ id: 'surface-1', kind: 'write', path: '/surface' }],
      }),
    );
    state.generations.push(createViewGeneration('building-1', ['work']));
    state.generations.push({
      ...publishGeneration(createViewGeneration('leased-1', ['work'])),
      leases: [
        {
          reservationId: 'lease-1',
          pid: 2_147_483_647,
          processGroupId: 2_147_483_647,
          processStart: 'secret-looking-process-reason',
        },
      ],
    });
    state.globalProjections.push({
      ...publishProjection(
        createGlobalProjection('projection-1', { kind: 'absent' }, {
          retainedPath: join(paths.live, 'projection-1'),
        }),
      ),
      phase: 'retired',
      failure: 'DO-NOT-PRINT-PROJECTION-DETAIL',
    });
    state.candidates.push({
      ...createSyncCandidate({
        id: 'candidate-1',
        ref: 'refs/agentenv/candidates/1',
        worktree: join(paths.live, 'candidate-1'),
        fetchedAt: 1,
        touchedCanonicalPaths: ['environments/work/env.yaml'],
      }),
      phase: 'rejected',
      reason: 'DO-NOT-PRINT-CANDIDATE-DETAIL',
    });
    state.quarantine.push({
      schemaVersion: 2,
      id: 'rescue-1',
      kind: 'third-identity',
      path: '/surface',
      retainedPath: join(paths.live, 'rescue-1'),
      reason: 'DO-NOT-PRINT-QUARANTINE-DETAIL',
      createdAt: 1,
      resolved: false,
    });
    state.migration = createMigrationState('migration-1', 'cm-v1');
    await writeState(paths, state);

    const result = await run(['doctor'], { env: home.env });
    expect(result.code).toBe(1);
    for (const kind of [
      'command-pending',
      'generation-pending',
      'lease-stale',
      'projection-pending',
      'candidate-pending',
      'quarantine-pending',
      'migration-pending',
    ]) {
      expect(result.stdout).toContain(`[${kind}]`);
    }
    expect(result.stdout).not.toContain('DO-NOT-PRINT');
    expect(result.stdout).not.toContain('secret-looking-process-reason');
  });

  it('does not diagnose settled lifecycle records or an active projection', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const state = await readState(paths);
    state.generations.push({
      ...publishGeneration(createViewGeneration('swept-1', ['work'])),
      phase: 'swept',
    });
    state.globalProjections.push(
      publishProjection(createGlobalProjection('active-1', { kind: 'absent' })),
    );
    state.candidates.push({
      ...createSyncCandidate({
        id: 'promoted-1',
        ref: 'refs/agentenv/candidates/2',
        worktree: join(paths.live, 'candidate-2'),
        fetchedAt: 1,
        touchedCanonicalPaths: [],
      }),
      phase: 'promoted',
      promotedRevision: 'abc123',
    });
    state.quarantine.push({
      schemaVersion: 2,
      id: 'resolved-1',
      kind: 'doctor-file-block-rescue',
      path: '/surface',
      retainedPath: join(paths.live, 'resolved-1'),
      reason: 'resolved',
      createdAt: 1,
      resolved: true,
    });
    await writeState(paths, state);

    const result = await run(['doctor'], { env: home.env });
    expect(result).toMatchObject({ code: 0, stdout: 'doctor: no problems found.\n' });
  });
});
