export type SyncCandidatePhase =
  | 'fetched'
  | 'validating'
  | 'approved'
  | 'deferred'
  | 'rejected'
  | 'promoting'
  | 'promoted'
  | 'abandoned';

export interface CreateSyncCandidateInput {
  id: string;
  ref: string;
  worktree: string;
  fetchedAt: number;
  touchedCanonicalPaths: string[];
}

export interface SyncCandidate extends CreateSyncCandidateInput {
  schemaVersion: 2;
  phase: SyncCandidatePhase;
  blockers: string[];
  reason: string | null;
  promotedRevision: string | null;
  /** Canonical HEAD the isolated integration was prepared from. */
  expectedCanonicalRevision: string | null;
  /** Fully integrated revision named by the durable private ref. */
  candidateRevision: string | null;
}

export function createSyncCandidate(input: CreateSyncCandidateInput): SyncCandidate {
  return {
    ...input,
    touchedCanonicalPaths: [...input.touchedCanonicalPaths],
    schemaVersion: 2,
    phase: 'fetched',
    blockers: [],
    reason: null,
    promotedRevision: null,
    expectedCanonicalRevision: null,
    candidateRevision: null,
  };
}

function requirePhase(candidate: SyncCandidate, expected: SyncCandidatePhase): void {
  if (candidate.phase !== expected) {
    throw new Error(`candidate must be ${expected}; it is ${candidate.phase}`);
  }
}

export function beginCandidateValidation(candidate: SyncCandidate): SyncCandidate {
  requirePhase(candidate, 'fetched');
  return { ...candidate, phase: 'validating' };
}

export function approveCandidate(candidate: SyncCandidate): SyncCandidate {
  requirePhase(candidate, 'validating');
  return { ...candidate, phase: 'approved', blockers: [], reason: null };
}

export function rejectCandidate(candidate: SyncCandidate, reason: string): SyncCandidate {
  requirePhase(candidate, 'validating');
  return { ...candidate, phase: 'rejected', blockers: [], reason };
}

export function deferCandidate(candidate: SyncCandidate, blockers: readonly string[]): SyncCandidate {
  requirePhase(candidate, 'validating');
  if (blockers.length === 0) throw new Error('a deferred candidate requires at least one blocker');
  return { ...candidate, phase: 'deferred', blockers: [...blockers], reason: null };
}

export function retryCandidate(candidate: SyncCandidate): SyncCandidate {
  if (!['fetched', 'validating', 'approved', 'deferred', 'rejected'].includes(candidate.phase)) {
    throw new Error(`candidate cannot be retried while it is ${candidate.phase}`);
  }
  return { ...candidate, phase: 'validating', blockers: [], reason: null };
}

export function beginCandidatePromotion(candidate: SyncCandidate): SyncCandidate {
  requirePhase(candidate, 'approved');
  return { ...candidate, phase: 'promoting' };
}

export function completeCandidatePromotion(
  candidate: SyncCandidate,
  promotedRevision: string,
): SyncCandidate {
  requirePhase(candidate, 'promoting');
  return { ...candidate, phase: 'promoted', promotedRevision };
}

export function abandonCandidate(candidate: SyncCandidate): SyncCandidate {
  if (!['fetched', 'validating', 'approved', 'deferred', 'rejected'].includes(candidate.phase)) {
    throw new Error(`candidate cannot be abandoned while it is ${candidate.phase}`);
  }
  return { ...candidate, phase: 'abandoned' };
}
