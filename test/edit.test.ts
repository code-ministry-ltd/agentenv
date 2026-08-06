import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { makeTempHome, type TempHome } from './helpers.js';

describe('edit', () => {
  let tmp: TempHome;
  beforeEach(() => {
    tmp = makeTempHome();
  });
  afterEach(() => {
    tmp.cleanup();
  });

  function envYaml(name: string): string {
    return join(tmp.home, 'store', 'environments', name, 'env.yaml');
  }

  it('prints the manifest path with --print-path and launches no editor', async () => {
    await run(['create', 'writing'], { env: tmp.env });
    let launched = false;
    const result = await run(['edit', 'writing', '--print-path'], {
      env: { ...tmp.env, EDITOR: 'vim' },
      launchEditor: async () => {
        launched = true;
        return 0;
      },
    });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(envYaml('writing'));
    expect(launched).toBe(false);
  });

  it('launches $EDITOR against a private staged env.yaml path', async () => {
    await run(['create', 'writing'], { env: tmp.env });
    let call: { command: string; args: readonly string[] } | undefined;
    const result = await run(['edit', 'writing'], {
      env: { ...tmp.env, EDITOR: 'nano' },
      launchEditor: async (command, args) => {
        call = { command, args };
        return 0;
      },
    });
    expect(result.code).toBe(0);
    expect(call?.command).toBe('nano');
    expect(call?.args).not.toContain(envYaml('writing'));
    expect(call?.args.at(-1)).toContain(join(tmp.home, 'live', 'commands'));
  });

  it('prefers $VISUAL over $EDITOR and passes editor flags through', async () => {
    await run(['create', 'writing'], { env: tmp.env });
    let call: { command: string; args: readonly string[] } | undefined;
    await run(['edit', 'writing'], {
      env: { ...tmp.env, EDITOR: 'nano', VISUAL: 'code -w' },
      launchEditor: async (command, args) => {
        call = { command, args };
        return 0;
      },
    });
    expect(call?.command).toBe('code');
    expect(call?.args[0]).toBe('-w');
    expect(call?.args[1]).toContain(join(tmp.home, 'live', 'commands'));
  });

  it('prints the path and a hint when no editor is configured', async () => {
    await run(['create', 'writing'], { env: tmp.env });
    let launched = false;
    const result = await run(['edit', 'writing'], {
      env: { ...tmp.env, EDITOR: '', VISUAL: '' },
      launchEditor: async () => {
        launched = true;
        return 0;
      },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(envYaml('writing'));
    expect(launched).toBe(false);
  });

  it('propagates a non-zero editor exit code', async () => {
    await run(['create', 'writing'], { env: tmp.env });
    const result = await run(['edit', 'writing'], {
      env: { ...tmp.env, EDITOR: 'nano' },
      launchEditor: async () => 3,
    });
    expect(result.code).toBe(3);
  });

  it('errors on an unknown environment', async () => {
    const result = await run(['edit', 'ghost', '--print-path'], { env: tmp.env });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('ghost');
  });

  it('requires a name', async () => {
    const result = await run(['edit'], { env: tmp.env });
    expect(result.code).not.toBe(0);
  });
});
