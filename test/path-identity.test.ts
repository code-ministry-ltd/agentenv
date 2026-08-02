import { describe, expect, it } from 'vitest';
import {
  decidePreCommitRecovery,
  identitiesEqual,
  type PathIdentity,
} from '../src/path-identity.js';

const absent: PathIdentity = { kind: 'absent' };
const original: PathIdentity = { kind: 'file', digest: 'sha256:original', mode: 0o644 };
const applied: PathIdentity = { kind: 'file', digest: 'sha256:agentenv', mode: 0o644 };
const replacement: PathIdentity = { kind: 'file', digest: 'sha256:user-replacement', mode: 0o600 };

describe('path identity and pre-commit recovery', () => {
  it('skips an operation still at its exact pre-state', () => {
    expect(decidePreCommitRecovery({ pre: absent, post: applied, observed: absent })).toEqual({
      action: 'skip-pre-state',
    });
  });

  it('undoes only an exact post-state produced by the operation', () => {
    expect(decidePreCommitRecovery({ pre: original, post: applied, observed: applied })).toEqual({
      action: 'undo-post-state',
    });
  });

  it('rescues and quarantines a third identity instead of overwriting it', () => {
    expect(
      decidePreCommitRecovery({ pre: original, post: applied, observed: replacement }),
    ).toEqual({ action: 'rescue-third-identity', observed: replacement });
  });

  it('treats type, digest, mode, and symlink target as identity', () => {
    expect(identitiesEqual(original, { ...original })).toBe(true);
    expect(identitiesEqual(original, { ...original, mode: 0o600 })).toBe(false);
    expect(
      identitiesEqual(
        { kind: 'symlink', target: '/store/a' },
        { kind: 'symlink', target: '/store/b' },
      ),
    ).toBe(false);
    expect(identitiesEqual(absent, { kind: 'absent' })).toBe(true);
  });
});
