import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  dematerialise,
  materialise,
  type FileBlockSource,
  type MaterialiseOptions,
} from '../src/file-block.js';
import { resolvePaths } from '../src/paths.js';
import { findOwners, readState } from '../src/state.js';
import { expectRealHomeUntouched, makeTempHome, guardRealHome } from './helpers.js';

describe('file-block surface — dematerialise', () => {
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

  function store(env: string, source: string, body: string): FileBlockSource {
    const p = paths();
    const storePath = join(p.envDir(env), 'instructions', source);
    mkdirSync(dirname(storePath), { recursive: true });
    writeFileSync(storePath, body);
    return { source, storePath };
  }

  const targetPath = (name = 'CLAUDE.md') => join(temp.home, name);

  async function fileBlockRecords(target: string) {
    const manifest = await readState(paths());
    return findOwners(manifest, target).filter((i) => i.surface === 'file-block');
  }

  /** materialise then dematerialise a given original file body; assert round-trip. */
  async function roundTrip(original: string | null, opts: Omit<MaterialiseOptions, 'target'>) {
    const target = targetPath();
    if (original !== null) writeFileSync(target, original);

    await materialise(paths(), { target, ...opts });
    await dematerialise(paths(), { target, env: opts.env });

    return target;
  }

  it('restores user content byte-identical after materialise then drop (trailing newline)', async () => {
    const original = '# Title\n\nUser paragraph.\n';
    const target = await roundTrip(original, {
      env: 'writing',
      mode: 'inline',
      sources: [store('writing', 'base.md', 'ENV\n')],
    });
    expect(readFileSync(target, 'utf8')).toBe(original);
  });

  it('restores user content byte-identical when the file had no trailing newline', async () => {
    const original = 'no trailing newline here';
    const target = await roundTrip(original, {
      env: 'writing',
      mode: 'inline',
      sources: [store('writing', 'base.md', 'ENV\n')],
    });
    expect(readFileSync(target, 'utf8')).toBe(original);
  });

  it('restores user content byte-identical when the file ended with a blank line', async () => {
    const original = 'text\n\n';
    const target = await roundTrip(original, {
      env: 'writing',
      mode: 'inline',
      sources: [store('writing', 'base.md', 'ENV\n')],
    });
    expect(readFileSync(target, 'utf8')).toBe(original);
  });

  it('uses CRLF-safe markers and restores CRLF user bytes exactly', async () => {
    const original = '# Title\r\n\r\nUser paragraph.\r\n';
    const target = await roundTrip(original, {
      env: 'writing',
      mode: 'inline',
      sources: [store('writing', 'base.md', 'ENV\r\n')],
    });
    expect(readFileSync(target, 'utf8')).toBe(original);
  });

  it('deletes a file agentenv created (absent original), leaving no debris', async () => {
    const target = targetPath();
    expect(existsSync(target)).toBe(false);

    await materialise(paths(), {
      target,
      env: 'work',
      mode: 'inline',
      sources: [store('work', 'base.md', 'ENV\n')],
    });
    expect(existsSync(target)).toBe(true);

    await dematerialise(paths(), { target, env: 'work' });
    expect(existsSync(target)).toBe(false); // undo of a CREATE = delete
  });

  it('restores a pre-existing empty file to empty, rather than deleting it', async () => {
    const target = targetPath();
    writeFileSync(target, ''); // empty but present

    await materialise(paths(), {
      target,
      env: 'work',
      mode: 'inline',
      sources: [store('work', 'base.md', 'ENV\n')],
    });
    await dematerialise(paths(), { target, env: 'work' });

    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('');
  });

  it('keeps a file we created if the user added their own content outside the region', async () => {
    const target = targetPath();
    await materialise(paths(), {
      target,
      env: 'work',
      mode: 'inline',
      sources: [store('work', 'base.md', 'ENV\n')],
    });
    // User prepends their own content above our region during the session.
    const withUser = `MY OWN NOTES\n${readFileSync(target, 'utf8')}`;
    writeFileSync(target, withUser);

    await dematerialise(paths(), { target, env: 'work' });

    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('MY OWN NOTES\n');
  });

  it('removes the whole multi-sub-block region, restoring user content', async () => {
    const original = 'USER\n';
    const target = await roundTrip(original, {
      env: 'work',
      mode: 'inline',
      sources: [store('work', 'base.md', 'BASE\n'), store('work', 'codex.md', 'CODEX\n')],
    });
    const out = readFileSync(target, 'utf8');
    expect(out).toBe(original);
    expect(out).not.toContain('agentenv:');
  });

  it('removes the manifest ownership record on drop', async () => {
    const target = targetPath();
    writeFileSync(target, 'USER\n');
    await materialise(paths(), {
      target,
      env: 'writing',
      mode: 'inline',
      sources: [store('writing', 'base.md', 'ENV\n')],
    });
    expect(await fileBlockRecords(target)).toHaveLength(1);

    await dematerialise(paths(), { target, env: 'writing' });
    expect(await fileBlockRecords(target)).toHaveLength(0);
  });

  it('is idempotent: dropping again is a safe no-op', async () => {
    const target = targetPath();
    writeFileSync(target, 'USER\n');
    await materialise(paths(), {
      target,
      env: 'writing',
      mode: 'inline',
      sources: [store('writing', 'base.md', 'ENV\n')],
    });
    await dematerialise(paths(), { target, env: 'writing' });
    // Second drop must not throw and must leave user content intact.
    await dematerialise(paths(), { target, env: 'writing' });
    expect(readFileSync(target, 'utf8')).toBe('USER\n');
  });

  it('drops only the named env, leaving another env untouched (import mode round-trip)', async () => {
    const original = '# Shared file\n';
    const target = await roundTrip(original, {
      env: 'writing',
      mode: 'import',
      sources: [store('writing', 'base.md', 'IMPORTED\n')],
    });
    expect(readFileSync(target, 'utf8')).toBe(original);
  });
});
