import { describe, expect, it } from 'vitest';
import { parseVersion } from '../src/schema-version.js';

describe('parseVersion', () => {
  it('parses a numeric minor >= 10 via string form (1.15 -> minor 15)', () => {
    // The old Math.round((raw-major)*10) produced minor 2 here — the bug.
    expect(parseVersion(1.15)).toEqual({ major: 1, minor: 15 });
  });

  it('numeric 1.10 collapses to 1.1 in IEEE-754 (-> minor 1)', () => {
    // 1.10 and 1.1 are the same JS number; nothing can recover the trailing 0.
    expect(parseVersion(1.1)).toEqual({ major: 1, minor: 1 });
    expect(parseVersion(1.10)).toEqual({ major: 1, minor: 1 });
  });

  it('a quoted "1.10" keeps its minor 10', () => {
    expect(parseVersion('1.10')).toEqual({ major: 1, minor: 10 });
  });

  it('parses the string form "1.0"', () => {
    expect(parseVersion('1.0')).toEqual({ major: 1, minor: 0 });
  });

  it('parses a bare integer 1 as 1.0', () => {
    expect(parseVersion(1)).toEqual({ major: 1, minor: 0 });
    expect(parseVersion('1')).toEqual({ major: 1, minor: 0 });
  });

  it('returns major < 1 as-is for the caller to reject', () => {
    expect(parseVersion(0.9)).toEqual({ major: 0, minor: 9 });
    expect(parseVersion('0')).toEqual({ major: 0, minor: 0 });
  });

  it('returns null for input that is neither a finite number nor an M/M.N string', () => {
    // A negative number stringifies to "-1", which the digit regex rejects — the
    // caller then reports "invalid version", same as before this refactor.
    expect(parseVersion(-1)).toBeNull();
    expect(parseVersion('abc')).toBeNull();
    expect(parseVersion('1.2.3')).toBeNull();
    expect(parseVersion(NaN)).toBeNull();
    expect(parseVersion(null)).toBeNull();
    expect(parseVersion(undefined)).toBeNull();
    expect(parseVersion({})).toBeNull();
  });
});
