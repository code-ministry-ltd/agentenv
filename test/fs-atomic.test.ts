import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileAtomic } from '../src/fs-atomic.js';

describe('writeFileAtomic', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentenv-atomic-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the bytes and leaves no temp debris behind', async () => {
    const file = join(dir, 'out.txt');
    await writeFileAtomic(file, 'hello');
    expect(readFileSync(file, 'utf8')).toBe('hello');
    expect(readdirSync(dir).filter((e) => e.includes('.tmp-'))).toHaveLength(0);
  });

  it('overwrites an existing file atomically', async () => {
    const file = join(dir, 'out.txt');
    await writeFileAtomic(file, 'first');
    await writeFileAtomic(file, 'second');
    expect(readFileSync(file, 'utf8')).toBe('second');
    expect(readdirSync(dir).filter((e) => e.includes('.tmp-'))).toHaveLength(0);
  });

  it('creates missing parent directories', async () => {
    const file = join(dir, 'a', 'b', 'out.txt');
    await writeFileAtomic(file, 'nested');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('nested');
  });
});
