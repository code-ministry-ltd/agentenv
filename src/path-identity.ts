/** A no-follow identity captured at a destructive filesystem boundary. */
export type PathIdentity =
  | { kind: 'absent' }
  | { kind: 'file'; digest: string; mode: number }
  | { kind: 'directory'; digest: string; mode: number }
  | { kind: 'symlink'; target: string };

export type PreCommitRecoveryDecision =
  | { action: 'skip-pre-state' }
  | { action: 'undo-post-state' }
  | { action: 'rescue-third-identity'; observed: PathIdentity };

/** Compare complete typed identities; matching bytes with a different type or mode is different. */
export function identitiesEqual(left: PathIdentity, right: PathIdentity): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case 'absent':
      return true;
    case 'symlink':
      return right.kind === 'symlink' && left.target === right.target;
    case 'file':
      return right.kind === 'file' && left.digest === right.digest && left.mode === right.mode;
    case 'directory':
      return (
        right.kind === 'directory' && left.digest === right.digest && left.mode === right.mode
      );
  }
}

/**
 * Decide recovery before the command commit point without clobbering an identity
 * the interrupted operation did not create.
 */
export function decidePreCommitRecovery(input: {
  pre: PathIdentity;
  post: PathIdentity;
  observed: PathIdentity;
}): PreCommitRecoveryDecision {
  if (identitiesEqual(input.observed, input.pre)) return { action: 'skip-pre-state' };
  if (identitiesEqual(input.observed, input.post)) return { action: 'undo-post-state' };
  return { action: 'rescue-third-identity', observed: input.observed };
}
