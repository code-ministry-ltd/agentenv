import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeMarker,
  dematerialise,
  materialise,
  syncBack,
  type FileBlockSource,
} from '../src/file-block.js';
import { resolvePaths } from '../src/paths.js';
import { expectRealHomeUntouched, makeTempHome, realHomeSnapshot } from './helpers.js';

/**
 * Regression guards for the two LOW adversarial-review findings, both covered by
 * the same manifest-anchored, fail-closed region logic:
 *
 * - Finding 2: the `<env>/<source>` label parse must not split on the FIRST `/`
 *   (an env containing a slash would orphan the region); attribution is anchored
 *   to the manifest env, not to a naive split.
 * - Finding 3: a mangled / relabelled sub-block marker must not silently drop an
 *   in-block edit — it is refused loudly, never swallowed.
 */
describe('file-block surface — label robustness (Findings 2 & 3)', () => {
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

  // Finding 2: an env label containing a slash must still round-trip cleanly.
  it('drops a region whose env label contains a slash (parse anchored to the manifest)', async () => {
    const target = targetPath();
    const original = '# Shared file\nUser paragraph.\n';
    writeFileSync(target, original);
    const src = store('team/writing', 'base.md', 'ENV\n');

    await materialise(paths(), { target, env: 'team/writing', mode: 'inline', sources: [src] });
    expect(read(target)).toContain('agentenv:team/writing/base.md');

    await dematerialise(paths(), { target, env: 'team/writing' });
    // The whole region must be removed — a first-slash split would orphan it.
    expect(read(target)).toBe(original);
  });

  // Finding 3: a relabelled sub-block marker must not silently discard an edit.
  it('syncBack refuses (never silently drops the edit) when a sub-block marker is mangled', async () => {
    const target = targetPath('AGENTS.md');
    const base = store('work', 'base.md', 'BASE\n');
    const codex = store('work', 'codex.md', 'CODEX\n');
    await materialise(paths(), { target, env: 'work', mode: 'inline', sources: [base, codex] });

    // The user edits inside the codex sub-block (drift that MUST survive)...
    writeFileSync(target, read(target).replace('CODEX\n', 'CODEX EDITED\n'));
    // ...then the codex CLOSE marker is relabelled (a mangle / typo) so the block
    // can no longer be cleanly paired against the manifest record.
    writeFileSync(
      target,
      read(target).replace(
        closeMarker('work', 'codex.md'),
        '<!-- <<< agentenv:work/codexTYPO.md <<< -->',
      ),
    );

    await expect(syncBack(paths(), { target, env: 'work' })).rejects.toThrow(/refus/i);
    // The edit is neither silently discarded nor mis-attributed to base.md.
    expect(read(codex.storePath)).toBe('CODEX\n');
    expect(read(base.storePath)).toBe('BASE\n');
    expect(read(target)).toContain('CODEX EDITED');
  });
});
