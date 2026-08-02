import { describe, expect, it } from 'vitest';
import {
  abandonCandidate,
  approveCandidate,
  beginCandidatePromotion,
  beginCandidateValidation,
  completeCandidatePromotion,
  createSyncCandidate,
  deferCandidate,
  rejectCandidate,
  retryCandidate,
} from '../src/sync-candidate.js';

function fetched() {
  return createSyncCandidate({
    id: 'candidate-1',
    ref: 'refs/agentenv/candidates/candidate-1',
    worktree: '/agentenv/candidates/candidate-1',
    fetchedAt: 100,
    touchedCanonicalPaths: ['environments/writing/skills/tone/SKILL.md'],
  });
}

describe('isolated remote candidate lifecycle', () => {
  it('promotes only an approved, validated candidate', () => {
    let candidate = beginCandidateValidation(fetched());
    candidate = approveCandidate(candidate);
    candidate = beginCandidatePromotion(candidate);
    candidate = completeCandidatePromotion(candidate, 'store-revision-2');
    expect(candidate.phase).toBe('promoted');
    expect(candidate.promotedRevision).toBe('store-revision-2');
  });

  it('durably rejects a candidate with its isolated ref, worktree, and reason intact', () => {
    let candidate = beginCandidateValidation(fetched());
    candidate = rejectCandidate(candidate, 'secret scan failed');
    expect(candidate).toMatchObject({
      phase: 'rejected',
      ref: 'refs/agentenv/candidates/candidate-1',
      worktree: '/agentenv/candidates/candidate-1',
      reason: 'secret scan failed',
    });
    expect(() => beginCandidatePromotion(candidate)).toThrow(/approved/i);
    expect(abandonCandidate(candidate).phase).toBe('abandoned');
  });

  it('defers writer-conflicting paths and can be retried after leases close', () => {
    let candidate = beginCandidateValidation(fetched());
    candidate = deferCandidate(candidate, ['generation:gen-7']);
    expect(candidate.phase).toBe('deferred');
    expect(candidate.blockers).toEqual(['generation:gen-7']);
    candidate = retryCandidate(candidate);
    expect(candidate.phase).toBe('validating');
    expect(candidate.blockers).toEqual([]);
  });

  it('cannot abandon a candidate while promotion is applying', () => {
    const candidate = beginCandidatePromotion(approveCandidate(beginCandidateValidation(fetched())));
    expect(() => abandonCandidate(candidate)).toThrow(/rejected|deferred/i);
  });
});
