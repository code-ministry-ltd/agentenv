import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeMarker,
  dematerialise,
  materialise,
  openMarker,
  syncBack,
  type FileBlockSource,
} from '../src/file-block.js';
import { resolvePaths } from '../src/paths.js';
import { expectRealHomeUntouched, makeTempHome, realHomeSnapshot } from './helpers.js';

/**
 * Adversarial-review regression suite: the marker parser must NOT trust arbitrary
 * marker-shaped text and bound its managed region as first-marker → last-marker.
 * Each test reproduces a data-loss / store-corruption blast radius and asserts the
 * fail-closed contract: agentenv reclaims ONLY the exact contiguous region the
 * manifest records it owns, and refuses (rather than eats content) otherwise.
 */
describe('file-block surface — corruption / fail-closed', () => {
  let temp: ReturnType<typeof makeTempHome>;
  let realBefore: ReturnType<typeof realHomeSnapshot>;

  beforeEach(() => {
    realBefore = realHomeSnapshot();
    temp = makeTempHome();
  });

  afterEach(() => {
    temp.cleanup();
    expectRealHomeUntouched(realBefore);
  });

  const paths = () => resolvePaths(temp.env);

  function store(env: string, source: string, body: string): FileBlockSource {
    const storePath = join(paths().envDir(env), 'instructions', source);
    mkdirSync(dirname(storePath), { recursive: true });
    writeFileSync(storePath, body);
    return { source, storePath };
  }

  const targetPath = (name = 'CLAUDE.md') => join(temp.home, name);
  const read = (p: string) => readFileSync(p, 'utf8');

  /** The exact open..close region text for a sub-block inside `content`. */
  function extractRegion(content: string, env: string, source: string): string {
    const open = content.indexOf(openMarker(env, source));
    const close = content.indexOf(closeMarker(env, source)) + closeMarker(env, source).length;
    return content.slice(open, close);
  }

  // 1. dematerialise deletes user content between DUPLICATED regions.
  it('dematerialise refuses to delete user content between DUPLICATED managed regions', async () => {
    const target = targetPath();
    const src = store('writing', 'base.md', 'ENV\n');
    await materialise(paths(), { target, env: 'writing', mode: 'inline', sources: [src] });

    // An agent copies agentenv's managed section verbatim (the markers only say
    // "do not edit BETWEEN markers" — copying them whole is not forbidden),
    // wrapping the user's own precious note between the two identical copies.
    const region = extractRegion(read(target), 'writing', 'base.md');
    writeFileSync(target, `HEADER\n${region}\nPRECIOUS MIDDLE\n${region}\n`);

    await expect(dematerialise(paths(), { target, env: 'writing' })).rejects.toThrow(/refus/i);
    expect(read(target)).toContain('PRECIOUS MIDDLE');
    expect(read(target)).toContain('HEADER');
  });

  // 2. materialise eats user content between pasted LOOKALIKE markers.
  it('materialise does not eat user content between pasted look-alike markers', async () => {
    const target = targetPath();
    const before =
      `# My notes\nHere is how an agentenv block looks:\n` +
      `${openMarker('writing', 'base.md')}\n` +
      `MY DOCUMENTED EXAMPLE AND NOTES\n` +
      `${closeMarker('writing', 'base.md')}\n` +
      `More of my own notes.\n`;
    writeFileSync(target, before);
    const src = store('writing', 'base.md', 'REAL ENV\n');

    // First materialise: no manifest record yet, so nothing may be stripped.
    await materialise(paths(), { target, env: 'writing', mode: 'inline', sources: [src] });

    const after = read(target);
    expect(after).toContain('MY DOCUMENTED EXAMPLE AND NOTES');
    expect(after).toContain('More of my own notes.');
    expect(after).toContain('# My notes');
    expect(after).toContain('REAL ENV'); // the managed region was still inserted
  });

  // 3. Whole-file deletion when a lookalike open marker collapses the span.
  it('dematerialise never deletes the whole created file when a look-alike open marker collapses the span', async () => {
    const target = targetPath('AGENTS.md'); // does not exist → agentenv creates it
    expect(existsSync(target)).toBe(false);
    const src = store('work', 'base.md', 'ENV\n');
    await materialise(paths(), { target, env: 'work', mode: 'inline', sources: [src] });

    // A look-alike OPEN marker (same label) pasted above the real region, with a
    // precious note. The naive first-open→last-close span collapses to the whole
    // file; with an 'absent' backup the buggy drop rm's the entire file.
    const materialised = read(target);
    const hostile = `${openMarker('work', 'base.md')}\nPRECIOUS TOP\n${materialised.replace(/^\n/, '')}`;
    writeFileSync(target, hostile);

    await expect(dematerialise(paths(), { target, env: 'work' })).rejects.toThrow(/refus/i);
    expect(existsSync(target)).toBe(true); // never rm'd
    expect(read(target)).toContain('PRECIOUS TOP');
  });

  // 4. Store corruption: syncBack writes lookalike-spanned text back to the store.
  it('syncBack refuses and never writes look-alike-spanned text back to the store', async () => {
    const target = targetPath('AGENTS.md');
    const base = store('work', 'base.md', 'BASE\n');
    await materialise(paths(), { target, env: 'work', mode: 'inline', sources: [base] });

    // Private notes above the real region behind a pasted look-alike open marker:
    // the naive span swallows them and treats them as drift to write back.
    const materialised = read(target);
    const hostile = `${openMarker('work', 'base.md')}\nMY PRIVATE NOTES\n${materialised.replace(/^\n/, '')}`;
    writeFileSync(target, hostile);

    await expect(syncBack(paths(), { target, env: 'work' })).rejects.toThrow(/refus/i);
    // The canonical (git-synced) store file must NOT be polluted with markers or notes.
    expect(read(base.storePath)).toBe('BASE\n');
  });
});
