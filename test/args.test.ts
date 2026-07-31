import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';

describe('parseArgs', () => {
  it('collects positionals in order', () => {
    const r = parseArgs(['a', 'b', 'c']);
    expect(r.positionals).toEqual(['a', 'b', 'c']);
  });

  it('parses boolean flags', () => {
    const r = parseArgs(['env', '--yes'], { booleans: ['yes'] });
    expect(r.positionals).toEqual(['env']);
    expect(r.booleans.has('yes')).toBe(true);
  });

  it('parses value options as a following token or inline with =', () => {
    const spaced = parseArgs(['x', '--from', 'writing'], { values: ['from'] });
    expect(spaced.values.get('from')).toBe('writing');
    const inline = parseArgs(['x', '--from=writing'], { values: ['from'] });
    expect(inline.values.get('from')).toBe('writing');
  });

  it('records unrecognised flags as unknown', () => {
    const r = parseArgs(['--bogus'], { booleans: ['yes'] });
    expect(r.unknown).toEqual(['--bogus']);
    expect(r.booleans.has('yes')).toBe(false);
  });

  it('treats -- as an end-of-options terminator', () => {
    const r = parseArgs(['--yes', '--', '--not-a-flag'], { booleans: ['yes'] });
    expect(r.booleans.has('yes')).toBe(true);
    expect(r.positionals).toEqual(['--not-a-flag']);
  });
});
