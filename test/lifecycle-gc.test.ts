import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectLifecycleGarbage } from '../src/lifecycle-gc.js';
import { resolvePaths } from '../src/paths.js';
import { readState, writeState } from '../src/state.js';
import { createViewGeneration } from '../src/view-generation.js';
import { makeTempHome, type TempHome } from './helpers.js';

const homes: TempHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.cleanup();
});

function swept(id: string, paths: ReturnType<typeof resolvePaths>, sweptAt = 1) {
  const root = join(paths.live, 'generations', id);
  const viewRoot = join(root, 'fixture');
  mkdirSync(viewRoot, { recursive: true });
  writeFileSync(join(viewRoot, 'retained.txt'), id);
  return {
    ...createViewGeneration(id, ['work'], {
      adapterId: 'fixture',
      session: 'session',
      viewRoot,
      createdAt: 0,
    }),
    phase: 'swept' as const,
    sweptAt,
  };
}

describe('bounded lifecycle garbage collection', () => {
  it('collects only old swept unreferenced generations, up to the requested bound', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const state = await readState(paths);
    const first = swept('first', paths);
    const second = swept('second', paths);
    const quarantined = { ...swept('quarantined', paths), phase: 'quarantined' as const };
    const leased = {
      ...swept('leased', paths),
      leases: [{
        reservationId: 'lease',
        pid: 999_999,
        processGroupId: 999_999,
        processStart: 'retained',
      }],
    };
    state.generations.push(first, second, quarantined, leased);
    await writeState(paths, state);

    const result = await collectLifecycleGarbage(paths, { now: () => 10_000, minAgeMs: 0, limit: 1 });

    expect(result.collectedGenerationIds).toEqual(['first']);
    expect(existsSync(join(paths.live, 'generations', 'first'))).toBe(false);
    expect(existsSync(join(paths.live, 'generations', 'second'))).toBe(true);
    expect(existsSync(join(paths.live, 'generations', 'quarantined'))).toBe(true);
    expect(existsSync(join(paths.live, 'generations', 'leased'))).toBe(true);
    expect((await readState(paths)).generations.find((generation) => generation.id === 'first')).toMatchObject({
      phase: 'collected',
    });
  });

  it('revalidates lifecycle state immediately before removal and retains a newly quarantined generation', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const state = await readState(paths);
    state.generations.push(swept('raced', paths));
    await writeState(paths, state);

    const result = await collectLifecycleGarbage(paths, {
      now: () => 10_000,
      minAgeMs: 0,
      beforeRemove: async (id) => {
        const current = await readState(paths);
        const generation = current.generations.find((candidate) => candidate.id === id)!;
        generation.phase = 'quarantined';
        generation.failure = 'new uncertainty';
        await writeState(paths, current);
      },
    });

    expect(result.collectedGenerationIds).toEqual([]);
    expect(existsSync(join(paths.live, 'generations', 'raced', 'fixture', 'retained.txt'))).toBe(true);
    expect((await readState(paths)).generations.find((generation) => generation.id === 'raced')).toMatchObject({
      phase: 'quarantined',
    });
  });

  it('retains a swept generation while any owned surface still references its tree', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const state = await readState(paths);
    const generation = swept('referenced', paths);
    state.generations.push(generation);
    state.items.push({
      surface: 'unknown',
      action: 'retain',
      path: join(generation.viewRoot!, 'owned'),
      ownerEnv: 'work',
    });
    await writeState(paths, state);

    const result = await collectLifecycleGarbage(paths, { now: () => 10_000, minAgeMs: 0 });

    expect(result.collectedGenerationIds).toEqual([]);
    expect(existsSync(join(paths.live, 'generations', 'referenced'))).toBe(true);
  });
});
