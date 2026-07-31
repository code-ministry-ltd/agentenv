import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { expectRealHomeUntouched, makeTempHome, realHomeSnapshot, type TempHome } from './helpers.js';

describe('add instructions', () => {
  let tmp: TempHome;
  beforeEach(async () => {
    tmp = makeTempHome();
    await run(['create', 'writing'], { env: tmp.env });
  });
  afterEach(() => {
    tmp.cleanup();
  });

  const instr = (file: string): string =>
    join(tmp.home, 'store', 'environments', 'writing', 'instructions', file);

  it('creates base.md by default', async () => {
    const real = realHomeSnapshot();
    const result = await run(['add', 'instructions', 'writing'], { env: tmp.env });
    expect(result.code).toBe(0);
    expect(existsSync(instr('base.md'))).toBe(true);
    expect(readFileSync(instr('base.md'), 'utf8')).toContain('writing');
    expectRealHomeUntouched(real);
  });

  it('creates a per-harness file with --harness', async () => {
    const result = await run(['add', 'instructions', 'writing', '--harness', 'codex'], { env: tmp.env });
    expect(result.code).toBe(0);
    expect(existsSync(instr('codex.md'))).toBe(true);
    expect(existsSync(instr('base.md'))).toBe(false);
  });

  it('refuses to clobber an existing file without --force, overwrites with it', async () => {
    await run(['add', 'instructions', 'writing'], { env: tmp.env });
    const before = readFileSync(instr('base.md'), 'utf8');

    const again = await run(['add', 'instructions', 'writing'], { env: tmp.env });
    expect(again.code).not.toBe(0);
    expect(again.stderr).toContain('--force');
    expect(readFileSync(instr('base.md'), 'utf8')).toBe(before);

    const forced = await run(['add', 'instructions', 'writing', '--force'], { env: tmp.env });
    expect(forced.code).toBe(0);
  });

  it('--print-path prints the target path without writing (the testable "open")', async () => {
    const result = await run(['add', 'instructions', 'writing', '--print-path'], { env: tmp.env });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(instr('base.md'));
    expect(existsSync(instr('base.md'))).toBe(false);

    const harnessPath = await run(['add', 'instructions', 'writing', '--harness', 'codex', '--print-path'], { env: tmp.env });
    expect(harnessPath.stdout.trim()).toBe(instr('codex.md'));
  });

  it('rejects an invalid harness token and errors on a missing env', async () => {
    const badHarness = await run(['add', 'instructions', 'writing', '--harness', 'Bad Harness'], { env: tmp.env });
    expect(badHarness.code).not.toBe(0);

    const ghost = await run(['add', 'instructions', 'ghost'], { env: tmp.env });
    expect(ghost.code).not.toBe(0);
    expect(ghost.stderr).toContain('ghost');
  });

  it('errors when given a stray <name> positional', async () => {
    const result = await run(['add', 'instructions', 'writing', 'base'], { env: tmp.env });
    expect(result.code).not.toBe(0);
    expect(existsSync(instr('base.md'))).toBe(false);
  });
});
