import { identitiesEqual, type PathIdentity } from './path-identity.js';

export type GlobalProjectionPhase =
  | 'building'
  | 'active'
  | 'retired'
  | 'reconciling'
  | 'reconciled'
  | 'quarantined'
  | 'collected';

export interface GlobalProjection {
  schemaVersion: 2;
  id: string;
  phase: GlobalProjectionPhase;
  baseline: PathIdentity;
  observed: PathIdentity;
  surfacePath?: string;
  retainedPath?: string;
  canonicalPath?: string;
  canonicalBaseline?: PathIdentity;
  ownerEnv?: string;
  createdAt?: number;
  retiredAt?: number;
  canonicalRevision?: string;
  failure?: string;
}

export function createGlobalProjection(
  id: string,
  baseline: PathIdentity,
  details?: Omit<
    GlobalProjection,
    'schemaVersion' | 'id' | 'phase' | 'baseline' | 'observed'
  >,
): GlobalProjection {
  return {
    schemaVersion: 2,
    id,
    phase: 'building',
    baseline,
    observed: baseline,
    ...details,
  };
}

function requirePhase(projection: GlobalProjection, expected: GlobalProjectionPhase): void {
  if (projection.phase !== expected) {
    throw new Error(`projection must be ${expected}; it is ${projection.phase}`);
  }
}

export function publishProjection(projection: GlobalProjection): GlobalProjection {
  requirePhase(projection, 'building');
  return { ...projection, phase: 'active' };
}

/** Retire only the live pointer; the backing projection remains retained. */
export function retireProjection(projection: GlobalProjection): GlobalProjection {
  requirePhase(projection, 'active');
  return { ...projection, phase: 'retired' };
}

/** Record the identity currently held by the retained inode, including late writes. */
export function observeProjection(
  projection: GlobalProjection,
  observed: PathIdentity,
): GlobalProjection {
  if (projection.phase !== 'active' && projection.phase !== 'retired') {
    throw new Error(`cannot observe projection while it is ${projection.phase}`);
  }
  return { ...projection, observed };
}

export function projectionNeedsReconciliation(projection: GlobalProjection): boolean {
  return !identitiesEqual(projection.baseline, projection.observed);
}

export function beginProjectionReconciliation(projection: GlobalProjection): GlobalProjection {
  requirePhase(projection, 'retired');
  return { ...projection, phase: 'reconciling' };
}

export function completeProjectionReconciliation(
  projection: GlobalProjection,
  canonicalRevision: string,
): GlobalProjection {
  requirePhase(projection, 'reconciling');
  return { ...projection, phase: 'reconciled', canonicalRevision };
}

export function failProjectionReconciliation(
  projection: GlobalProjection,
  failure: string,
): GlobalProjection {
  requirePhase(projection, 'reconciling');
  return { ...projection, phase: 'quarantined', failure };
}

export function collectProjection(projection: GlobalProjection): GlobalProjection {
  requirePhase(projection, 'reconciled');
  return { ...projection, phase: 'collected' };
}
