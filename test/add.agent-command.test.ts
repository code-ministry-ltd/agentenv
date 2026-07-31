import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { expectRealHomeUntouched, makeTempHome, realHomeSnapshot, type TempHome } from './helpers.js';

describe('add agent / add command', () => {
  let tmp: TempHome;
  beforeEach(async () => {
    tmp = makeTempHome();
    await run(['create', 'writing'], { env: tmp.env });
  });
  afterEach(() => {
    tmp.cleanup();
  });

  const storeFile = (sub: string, file: string): string =>
    join(tmp.home, 'store', 'environments', 'writing', sub, file);

  it('scaffolds an agent markdown with a frontmatter name', async () => {
    const real = realHomeSnapshot();
    const result = await run(['add', 'agent', 'writing', 'reviewer'], { env: tmp.env });
    expect(result.code).toBe(0);
    const file = storeFile('agents', 'reviewer.md');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('name: reviewer');
    expectRealHomeUntouched(real);
  });

  it('scaffolds a command markdown', async () => {
    const result = await run(['add', 'command', 'writing', 'summarize'], { env: tmp.env });
    expect(result.code).toBe(0);
    expect(existsSync(storeFile('commands', 'summarize.md'))).toBe(true);
  });

  it('show reflects both', async () => {
    await run(['add', 'agent', 'writing', 'reviewer'], { env: tmp.env });
    await run(['add', 'command', 'writing', 'summarize'], { env: tmp.env });
    const shown = await run(['show', 'writing'], { env: tmp.env });
    expect(shown.stdout).toMatch(/agents:\s*1/);
    expect(shown.stdout).toMatch(/commands:\s*1/);
  });

  it('rejects invalid names for both kinds', async () => {
    const agent = await run(['add', 'agent', 'writing', 'Bad Name'], { env: tmp.env });
    expect(agent.code).not.toBe(0);
    expect(existsSync(storeFile('agents', 'Bad Name.md'))).toBe(false);

    const command = await run(['add', 'command', 'writing', '../escape'], { env: tmp.env });
    expect(command.code).not.toBe(0);
  });

  it('respects the collision policy (refuse, then --force)', async () => {
    await run(['add', 'agent', 'writing', 'reviewer'], { env: tmp.env });
    const file = storeFile('agents', 'reviewer.md');
    const before = readFileSync(file, 'utf8');

    const again = await run(['add', 'agent', 'writing', 'reviewer'], { env: tmp.env });
    expect(again.code).not.toBe(0);
    expect(again.stderr).toContain('--force');
    expect(readFileSync(file, 'utf8')).toBe(before);

    const forced = await run(['add', 'agent', 'writing', 'reviewer', '--force'], { env: tmp.env });
    expect(forced.code).toBe(0);
  });

  it('--print-path prints the target without writing', async () => {
    const result = await run(['add', 'command', 'writing', 'summarize', '--print-path'], { env: tmp.env });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(storeFile('commands', 'summarize.md'));
    expect(existsSync(storeFile('commands', 'summarize.md'))).toBe(false);
  });

  it('errors when the environment does not exist', async () => {
    const result = await run(['add', 'agent', 'ghost', 'reviewer'], { env: tmp.env });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('ghost');
  });
});
