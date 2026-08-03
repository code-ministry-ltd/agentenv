import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { makeTempHome, type TempHome } from './helpers.js';

const homes: TempHome[] = [];
function home(): TempHome {
  const result = makeTempHome();
  homes.push(result);
  return result;
}
afterEach(() => {
  for (const entry of homes.splice(0)) entry.cleanup();
});

describe('settled command surface', () => {
  it('uses env-less --global drop instead of --all or --harness targeting', async () => {
    const th = home();
    await run(['init'], { env: th.env });
    expect((await run(['drop', '--global', '--all'], { env: th.env })).stderr).toContain(
      "unknown option '--all'",
    );
    expect((await run(['drop', '--global', '--harness', 'codex'], { env: th.env })).stderr).toContain(
      "unknown option '--harness'",
    );
    expect((await run(['use', 'work', '--harness', 'codex'], { env: th.env })).stderr).toContain(
      "unknown option '--harness'",
    );
  });

  it('does not expose destructive rm shortcuts', async () => {
    const th = home();
    await run(['init'], { env: th.env });
    await run(['create', 'work'], { env: th.env });
    for (const option of ['--yes', '--force', '--drop-first']) {
      const result = await run(['rm', 'work', option], { env: th.env });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`unknown option '${option}'`);
    }
  });

  it('does not expose argv-based secret management', async () => {
    const help = await run(['--help']);
    expect(help.stdout).not.toContain('secret set');
    const result = await run(['secret', 'set', 'TOKEN', 'would-leak-through-argv']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unknown command 'secret'");
  });

  it('rejects ignored extra positional arguments', async () => {
    const th = home();
    await run(['init'], { env: th.env });
    await run(['create', 'work'], { env: th.env });
    for (const argv of [
      ['create', 'another', 'ignored'],
      ['show', 'work', 'ignored'],
      ['edit', 'work', 'ignored'],
      ['rm', 'work', 'ignored'],
      ['status', 'ignored'],
      ['list', 'ignored'],
      ['shell-init', 'ignored'],
    ]) {
      const result = await run(argv, { env: th.env });
      expect(result.code, argv.join(' ')).toBe(1);
      expect(result.stderr, argv.join(' ')).toContain('unexpected argument');
    }
  });

  it('requires root --offline instead of command-local remote flags', async () => {
    const th = home();
    await run(['init'], { env: th.env });
    expect((await run(['remote', 'https://example.invalid/repo', '--offline'], { env: th.env })).stderr).toContain(
      "unknown option '--offline'",
    );
    expect((await run(['--offline', 'remote', 'https://example.invalid/repo'], { env: th.env })).stderr).toContain(
      'disabled by --offline',
    );
    expect(
      (await run(['--offline', 'init', '--remote', 'https://example.invalid/repo'], { env: home().env })).stderr,
    ).toContain('disabled by --offline');
    expect((await run(['--offline', 'sync', '--resolve'], { env: th.env })).stderr).toContain(
      'disabled by --offline',
    );

    await run(['create', 'work'], { env: th.env });
    expect((await run(['--offline', 'add', 'skill', 'work', 'owner/repo'], { env: th.env })).stderr).toContain(
      'disabled by --offline',
    );
    expect((await run(['--offline', 'add', 'skills', 'work', 'owner/repo'], { env: th.env })).stderr).toContain(
      'disabled by --offline',
    );
  });

  it('rejects extra positional arguments across single-target commands', async () => {
    const th = home();
    await run(['init'], { env: th.env });
    await run(['create', 'work'], { env: th.env });
    for (const argv of [
      ['init', 'ignored'],
      ['adopt', 'item', 'ignored', '--into', 'work'],
      ['disown', 'item', 'ignored'],
      ['capture', 'ignored'],
      ['add', 'skill', 'work', 'thing', 'ignored'],
      ['add', 'skills', 'work', '.', 'ignored'],
      ['add', 'mcp', 'work', 'server', 'ignored'],
      ['add', 'agent', 'work', 'reviewer', 'ignored'],
      ['add', 'command', 'work', 'review', 'ignored'],
    ]) {
      const result = await run(argv, { env: th.env });
      expect(result.code, argv.join(' ')).toBe(1);
      expect(result.stderr, argv.join(' ')).toContain('unexpected argument');
    }
  });
});
