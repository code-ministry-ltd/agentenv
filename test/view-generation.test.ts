import { describe, expect, it } from 'vitest';
import {
  attachGenerationLease,
  beginGenerationSweep,
  closeGeneration,
  collectGeneration,
  completeGenerationSweep,
  createViewGeneration,
  failGenerationSweep,
  publishGeneration,
  releaseGenerationLease,
  reserveGeneration,
} from '../src/view-generation.js';

describe('immutable view generation lifecycle', () => {
  it('reserves before spawn, leases the process group, sweeps after exit, then collects', () => {
    let generation = publishGeneration(createViewGeneration('gen-1', ['base', 'writing']));
    generation = reserveGeneration(generation, 'spawn-1');
    generation = attachGenerationLease(generation, 'spawn-1', {
      processGroupId: 42,
      pid: 43,
      processStart: 'start-43',
    });
    expect(generation.reservations).toEqual([]);
    expect(generation.leases).toHaveLength(1);

    generation = closeGeneration(generation);
    expect(() => beginGenerationSweep(generation)).toThrow(/lease/i);
    generation = releaseGenerationLease(generation, 'spawn-1');
    generation = beginGenerationSweep(generation);
    generation = completeGenerationSweep(generation);
    generation = collectGeneration(generation);
    expect(generation.phase).toBe('collected');
  });

  it('does not sweep while a pre-spawn reservation can still become a lease', () => {
    let generation = publishGeneration(createViewGeneration('gen-1', ['writing']));
    generation = reserveGeneration(generation, 'spawn-1');
    generation = closeGeneration(generation);
    expect(() => beginGenerationSweep(generation)).toThrow(/reservation/i);
  });

  it('quarantines failed sweeps and never collects them', () => {
    let generation = publishGeneration(createViewGeneration('gen-1', ['writing']));
    generation = closeGeneration(generation);
    generation = beginGenerationSweep(generation);
    generation = failGenerationSweep(generation, 'ambiguous owner');
    expect(generation.phase).toBe('quarantined');
    expect(generation.failure).toBe('ambiguous owner');
    expect(() => collectGeneration(generation)).toThrow(/swept/i);
  });

  it('refuses new reservations after closing starts', () => {
    const generation = closeGeneration(
      publishGeneration(createViewGeneration('gen-1', ['writing'])),
    );
    expect(() => reserveGeneration(generation, 'late')).toThrow(/published/i);
  });
});
