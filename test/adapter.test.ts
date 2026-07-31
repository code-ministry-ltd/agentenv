import { describe, expect, it } from 'vitest';
import {
  resolveAdapter,
  storeToken,
  surfaceRootRelativePath,
  validateAdapter,
  type Adapter,
} from '../src/adapter.js';
import { adapters as realAdapters } from '../src/adapters/index.js';
import { makeFixtureAdapter } from './fixtures/fixture-adapter.js';

describe('session adapter contract', () => {
  it('the fixture adapter satisfies validateAdapter', () => {
    expect(validateAdapter(makeFixtureAdapter())).toBeNull();
  });

  it("overrideEnv sets the declared configRootEnv to the view root", () => {
    const a = makeFixtureAdapter();
    expect(a.overrideEnv('/x/y')[a.configRootEnv]).toBe('/x/y');
  });

  it('classifyEntry defaults unknown entries to bucket-1 (state), the safe unknown', () => {
    const a = makeFixtureAdapter();
    expect(a.classifyEntry('a-file-a-future-harness-update-introduced')).toBe('state');
    expect(a.classifyEntry('skills')).toBe('managed');
    expect(a.classifyEntry('creds.json')).toBe('state');
  });

  it('storeToken defaults to the adapter id when unset', () => {
    expect(storeToken({ id: 'x', storeToken: undefined } as Adapter)).toBe('x');
    expect(storeToken({ id: 'x', storeToken: 'y' } as Adapter)).toBe('y');
  });

  it('resolveAdapter matches by binaryName and by alias', () => {
    const a = makeFixtureAdapter();
    const list = [a];
    expect(resolveAdapter(list, a.binaryName)).toBe(a);
    expect(resolveAdapter(list, 'nope')).toBeUndefined();
  });

  it('every surface exposes a config-root-relative path', () => {
    for (const s of makeFixtureAdapter().surfaces) {
      expect(typeof surfaceRootRelativePath(s)).toBe('string');
    }
  });

  it('validateAdapter rejects an override that ignores the declared root', () => {
    const broken = makeFixtureAdapter();
    const bad: Adapter = { ...broken, overrideEnv: () => ({ WRONG: 'value' }) };
    expect(validateAdapter(bad)).toContain('overrideEnv');
  });

  it('validateAdapter rejects an unsafe surface rootRelativePath', () => {
    const base = makeFixtureAdapter();
    const bad: Adapter = {
      ...base,
      surfaces: [{ ...base.surfaces[0]!, rootRelativePath: '../escape' } as never],
    };
    expect(validateAdapter(bad)).toContain('unsafe rootRelativePath');
  });

  it('the real adapter registry is empty in Phase 1 (real adapters are 1.8 / 4.x)', () => {
    expect(realAdapters).toEqual([]);
  });
});
