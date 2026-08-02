import { describe, expect, it } from 'vitest';
import {
  beginProjectionReconciliation,
  collectProjection,
  completeProjectionReconciliation,
  createGlobalProjection,
  failProjectionReconciliation,
  observeProjection,
  projectionNeedsReconciliation,
  publishProjection,
  retireProjection,
} from '../src/global-projection.js';
import type { PathIdentity } from '../src/path-identity.js';

const baseline: PathIdentity = { kind: 'file', digest: 'sha256:base', mode: 0o600 };
const lateWrite: PathIdentity = { kind: 'file', digest: 'sha256:late', mode: 0o600 };

describe('retained global COW projection lifecycle', () => {
  it('retains and reconciles a late write after the live pointer is retired', () => {
    let projection = publishProjection(createGlobalProjection('projection-1', baseline));
    projection = retireProjection(projection);
    projection = observeProjection(projection, lateWrite);
    expect(projection.phase).toBe('retired');
    expect(projectionNeedsReconciliation(projection)).toBe(true);

    projection = beginProjectionReconciliation(projection);
    projection = completeProjectionReconciliation(projection, 'canonical-revision-2');
    projection = collectProjection(projection);
    expect(projection.phase).toBe('collected');
  });

  it('never collects an active or merely retired projection', () => {
    const active = publishProjection(createGlobalProjection('projection-1', baseline));
    expect(() => collectProjection(active)).toThrow(/reconciled/i);
    expect(() => collectProjection(retireProjection(active))).toThrow(/reconciled/i);
  });

  it('quarantines ambiguous reconciliation and keeps the retained bytes', () => {
    let projection = publishProjection(createGlobalProjection('projection-1', baseline));
    projection = observeProjection(retireProjection(projection), lateWrite);
    projection = beginProjectionReconciliation(projection);
    projection = failProjectionReconciliation(projection, 'canonical changed concurrently');
    expect(projection.phase).toBe('quarantined');
    expect(projection.observed).toEqual(lateWrite);
    expect(() => collectProjection(projection)).toThrow(/reconciled/i);
  });
});
