import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run, type RunOptions } from '../src/cli.js';
import { findCommand } from '../src/commands/index.js';
import type {
  StartUiServerOptions,
  UiServerHandle,
} from '../src/ui/server.js';
import { makeTempHome, type TempHome } from './helpers.js';

describe('agentenv ui command', () => {
  let temp: TempHome;
  let starts: StartUiServerOptions[];
  let opened: string[];

  beforeEach(() => {
    temp = makeTempHome();
    starts = [];
    opened = [];
  });

  afterEach(() => temp.cleanup());

  function options(launchUrl = 'http://127.0.0.1:43210/#launch=secret'): RunOptions {
    return {
      env: temp.env,
      startUiServer: async (serverOptions): Promise<UiServerHandle> => {
        starts.push(serverOptions);
        return {
          origin: 'http://127.0.0.1:43210',
          launchUrl,
          close: async () => undefined,
        };
      },
      openUiUrl: async (url) => {
        opened.push(url);
      },
    };
  }

  it('advertises the command after browser authentication is complete', async () => {
    const result = await run(['--help'], { env: temp.env });

    expect(findCommand('ui')).toMatchObject({ name: 'ui', hidden: false });
    expect(result.stdout).toContain('ui [--no-open] [--port <port>]');
  });

  it('starts on the requested non-privileged port without opening when asked', async () => {
    const result = await run(['ui', '--no-open', '--port', '43210'], options());

    expect(result).toMatchObject({
      code: 0,
      stdout: 'agentenv UI: http://127.0.0.1:43210/#launch=secret\n',
    });
    expect(starts).toEqual([
      {
        port: 43210,
        cwd: process.cwd(),
        env: temp.env,
        paths: expect.objectContaining({ base: temp.home }),
        runOptions: expect.objectContaining({
          globals: { json: false, offline: false, verbose: false },
        }),
      },
    ]);
    expect(opened).toEqual([]);
  });

  it('opens the launch URL by default and keeps it usable when opening fails', async () => {
    const success = await run(['ui'], options());
    expect(opened).toEqual(['http://127.0.0.1:43210/#launch=secret']);
    expect(success.code).toBe(0);

    const failed = await run(['ui'], {
      ...options(),
      openUiUrl: async () => {
        throw new Error('no desktop opener');
      },
    });
    expect(failed.code).toBe(0);
    expect(failed.stdout).toContain('http://127.0.0.1:43210/#launch=secret');
    expect(failed.stderr).toBe('ui: could not open a browser; use the URL above\n');
  });

  it('rejects invalid arguments before starting a listener', async () => {
    for (const args of [
      ['ui', '--port', '80'],
      ['ui', '--port', 'not-a-port'],
      ['ui', '--port'],
      ['ui', '--unknown'],
    ]) {
      const result = await run(args, options());
      expect(result.code).toBe(1);
    }
    expect(starts).toEqual([]);
  });
});
