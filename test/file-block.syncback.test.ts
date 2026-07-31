import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { materialise, syncBack, type FileBlockSource } from '../src/file-block.js';
import { resolvePaths } from '../src/paths.js';
import { findOwners, readState } from '../src/state.js';
import { expectRealHomeUntouched, makeTempHome, realHomeSnapshot } from './helpers.js';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('file-block surface — syncBack (drift)', () => {
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

  const targetPath = (name = 'AGENTS.md') => join(temp.home, name);
  const read = (p: string) => readFileSync(p, 'utf8');

  /** Edit inside a sub-block by replacing a known body fragment in the target. */
  function editInFile(target: string, from: string, to: string) {
    writeFileSync(target, read(target).replace(from, to));
  }

  async function subBlockHash(target: string, env: string, source: string) {
    const manifest = await readState(paths());
    const rec = findOwners(manifest, target).find(
      (i) => i.surface === 'file-block' && i.ownerEnv === env,
    );
    return (rec as { subBlocks: { source: string; hash?: string }[] }).subBlocks.find(
      (s) => s.source === source,
    )?.hash;
  }

  it('writes an edit inside the base.md sub-block back to base.md only', async () => {
    const target = targetPath();
    const base = store('work', 'base.md', 'BASE\n');
    const codex = store('work', 'codex.md', 'CODEX\n');
    await materialise(paths(), { target, env: 'work', mode: 'inline', sources: [base, codex] });

    // Edit the inlined base body in the instruction file.
    editInFile(target, 'BASE\n', 'BASE EDITED\n');

    const result = await syncBack(paths(), { target, env: 'work' });

    expect(result.drifted).toEqual(['base.md']);
    expect(read(base.storePath)).toBe('BASE EDITED\n'); // drift landed here
    expect(read(codex.storePath)).toBe('CODEX\n'); // the shared/other file untouched
  });

  it('writes an edit inside the codex.md sub-block back to codex.md, never base.md', async () => {
    const target = targetPath();
    const base = store('work', 'base.md', 'BASE\n');
    const codex = store('work', 'codex.md', 'CODEX\n');
    await materialise(paths(), { target, env: 'work', mode: 'inline', sources: [base, codex] });

    editInFile(target, 'CODEX\n', 'CODEX EDITED\n');

    const result = await syncBack(paths(), { target, env: 'work' });

    expect(result.drifted).toEqual(['codex.md']);
    expect(read(codex.storePath)).toBe('CODEX EDITED\n');
    expect(read(base.storePath)).toBe('BASE\n'); // base.md is NEVER the drift target here
  });

  it('updates the recorded hash so a second syncBack is a no-op', async () => {
    const target = targetPath();
    const base = store('writing', 'base.md', 'BASE\n');
    await materialise(paths(), { target, env: 'writing', mode: 'inline', sources: [base] });

    editInFile(target, 'BASE\n', 'BASE EDITED\n');
    await syncBack(paths(), { target, env: 'writing' });

    expect(await subBlockHash(target, 'writing', 'base.md')).toBe(sha256('BASE EDITED\n'));

    const second = await syncBack(paths(), { target, env: 'writing' });
    expect(second).toEqual({ drifted: [], refreshed: [] });
  });

  it('refreshes the block from a store file changed elsewhere, without writing back', async () => {
    const target = targetPath();
    const base = store('writing', 'base.md', 'BASE\n');
    await materialise(paths(), { target, env: 'writing', mode: 'inline', sources: [base] });

    // Simulate the store file changing on another machine (no in-file edit).
    writeFileSync(base.storePath, 'BASE FROM OTHER MACHINE\n');

    const result = await syncBack(paths(), { target, env: 'writing' });

    expect(result.refreshed).toEqual(['base.md']);
    expect(result.drifted).toEqual([]);
    // The block now reflects the store; the store keeps its new content.
    expect(read(target)).toContain('BASE FROM OTHER MACHINE');
    expect(read(base.storePath)).toBe('BASE FROM OTHER MACHINE\n');
    expect(await subBlockHash(target, 'writing', 'base.md')).toBe(sha256('BASE FROM OTHER MACHINE\n'));
  });

  it('is a no-op when neither the block nor the store changed', async () => {
    const target = targetPath();
    const base = store('writing', 'base.md', 'BASE\n');
    await materialise(paths(), { target, env: 'writing', mode: 'inline', sources: [base] });

    const before = read(target);
    const result = await syncBack(paths(), { target, env: 'writing' });

    expect(result).toEqual({ drifted: [], refreshed: [] });
    expect(read(target)).toBe(before);
  });

  it('import mode: a store-file edit reflects with no write-back and no drift', async () => {
    const target = targetPath();
    const base = store('writing', 'base.md', 'IMPORTED\n');
    await materialise(paths(), { target, env: 'writing', mode: 'import', sources: [base] });
    const beforeTarget = read(target);

    // Editing the store file must simply be picked up via the @import line.
    writeFileSync(base.storePath, 'IMPORTED V2\n');

    const result = await syncBack(paths(), { target, env: 'writing' });

    expect(result).toEqual({ drifted: [], refreshed: [] });
    // No write-back: the store file keeps the user's edit verbatim.
    expect(read(base.storePath)).toBe('IMPORTED V2\n');
    // The block still holds the import line, unchanged.
    expect(read(target)).toBe(beforeTarget);
    expect(read(target)).toContain(`@${base.storePath}`);
  });
});
