import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { materialise, type FileBlockItem, type FileBlockSource } from '../src/file-block.js';
import { resolvePaths } from '../src/paths.js';
import { findOwners, readState, type ManifestItem } from '../src/state.js';
import { expectRealHomeUntouched, makeTempHome, guardRealHome } from './helpers.js';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('file-block surface — materialise', () => {
  let temp: ReturnType<typeof makeTempHome>;
  let realBefore: ReturnType<typeof guardRealHome>;

  beforeEach(() => {
    realBefore = guardRealHome();
    temp = makeTempHome();
  });

  afterEach(() => {
    temp.cleanup();
    expectRealHomeUntouched(realBefore);
  });

  const paths = () => resolvePaths(temp.env);

  /** Create a store instruction file and return a source descriptor for it. */
  function store(env: string, source: string, body: string): FileBlockSource {
    const p = paths();
    const storePath = join(p.envDir(env), 'instructions', source);
    mkdirSync(dirname(storePath), { recursive: true });
    writeFileSync(storePath, body);
    return { source, storePath };
  }

  /** Absolute path to a target user instruction file inside the temp home. */
  const targetPath = (name = 'CLAUDE.md') => join(temp.home, name);

  /** All file-block manifest records owning `target`. */
  async function records(target: string): Promise<FileBlockItem[]> {
    const manifest = await readState(paths());
    return findOwners(manifest, target).filter(
      (i: ManifestItem) => i.surface === 'file-block',
    ) as FileBlockItem[];
  }

  it('adds a managed region to a file with user content, byte-identical outside', async () => {
    const target = targetPath();
    const user = '# My CLAUDE.md\n\nSome personal notes.\n';
    writeFileSync(target, user);
    const src = store('writing', 'base.md', 'ENV INSTRUCTIONS\n');

    await materialise(paths(), { target, env: 'writing', mode: 'inline', sources: [src] });

    const after = readFileSync(target, 'utf8');
    // The user content is preserved verbatim as a prefix, untouched.
    expect(after.startsWith(user)).toBe(true);
    // The managed region carries the exact D2 markers with a per-source label.
    expect(after).toContain(
      '<!-- >>> agentenv:writing/base.md >>> managed — do not edit between markers -->',
    );
    expect(after).toContain('<!-- <<< agentenv:writing/base.md <<< -->');
  });

  it('creates the target file when it does not exist', async () => {
    const target = targetPath('AGENTS.md');
    expect(existsSync(target)).toBe(false);
    const src = store('work', 'base.md', 'BODY\n');

    await materialise(paths(), { target, env: 'work', mode: 'inline', sources: [src] });

    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toContain('BODY');
  });

  it('import mode holds an @import line pointing at the store, not the content', async () => {
    const target = targetPath();
    const src = store('writing', 'base.md', 'THE REAL CONTENT LIVES IN THE STORE\n');

    await materialise(paths(), { target, env: 'writing', mode: 'import', sources: [src] });

    const after = readFileSync(target, 'utf8');
    expect(after).toContain(`@${src.storePath}`);
    expect(after).not.toContain('THE REAL CONTENT LIVES IN THE STORE');

    // No drift hash is recorded for an import sub-block (content is not inlined).
    const [rec] = await records(target);
    expect(rec?.mode).toBe('import');
    expect(rec?.subBlocks[0]?.hash).toBeUndefined();
  });

  it('inline mode inlines the store content and records its hash for drift', async () => {
    const target = targetPath();
    const body = 'INLINE BODY\nsecond line\n';
    const src = store('writing', 'base.md', body);

    await materialise(paths(), { target, env: 'writing', mode: 'inline', sources: [src] });

    const after = readFileSync(target, 'utf8');
    expect(after).toContain('INLINE BODY');
    expect(after).toContain('second line');

    const [rec] = await records(target);
    expect(rec?.mode).toBe('inline');
    expect(rec?.subBlocks[0]?.hash).toBe(sha256(body));
  });

  it('renders one sub-block per contributed store file, each with its own markers', async () => {
    const target = targetPath();
    const base = store('work', 'base.md', 'BASE CONTENT\n');
    const harness = store('work', 'codex.md', 'CODEX CONTENT\n');

    await materialise(paths(), {
      target,
      env: 'work',
      mode: 'inline',
      sources: [base, harness],
    });

    const after = readFileSync(target, 'utf8');
    expect(after).toContain('<!-- >>> agentenv:work/base.md >>> managed');
    expect(after).toContain('<!-- <<< agentenv:work/base.md <<< -->');
    expect(after).toContain('<!-- >>> agentenv:work/codex.md >>> managed');
    expect(after).toContain('<!-- <<< agentenv:work/codex.md <<< -->');
    expect(after).toContain('BASE CONTENT');
    expect(after).toContain('CODEX CONTENT');

    const [rec] = await records(target);
    expect(rec?.subBlocks.map((s) => s.source)).toEqual(['base.md', 'codex.md']);
  });

  it('records ownership: surface, owner env, key=env, path and sub-blocks', async () => {
    const target = targetPath();
    const src = store('writing', 'base.md', 'B\n');

    const item = await materialise(paths(), {
      target,
      env: 'writing',
      mode: 'inline',
      sources: [src],
    });

    expect(item).toMatchObject({
      surface: 'file-block',
      action: 'file-block',
      path: target,
      key: 'writing',
      ownerEnv: 'writing',
      mode: 'inline',
    });
    const [rec] = await records(target);
    expect(rec?.ownerEnv).toBe('writing');
    expect(rec?.subBlocks[0]?.storePath).toBe(src.storePath);
  });

  it('is idempotent: re-materialising is byte-identical, no duplicate block or record', async () => {
    const target = targetPath();
    writeFileSync(target, 'USER TOP\n');
    const src = store('writing', 'base.md', 'BODY\n');

    await materialise(paths(), { target, env: 'writing', mode: 'inline', sources: [src] });
    const first = readFileSync(target, 'utf8');
    await materialise(paths(), { target, env: 'writing', mode: 'inline', sources: [src] });
    const second = readFileSync(target, 'utf8');

    expect(second).toBe(first);
    // Exactly one open marker for the sub-block — no accumulation.
    const opens = second.split('>>> agentenv:writing/base.md >>>').length - 1;
    expect(opens).toBe(1);
    // And exactly one manifest record.
    expect(await records(target)).toHaveLength(1);
  });
});
