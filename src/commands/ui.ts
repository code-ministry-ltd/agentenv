import { spawn } from 'node:child_process';
import type { Command, RunResult } from '../command.js';
import { startUiServer } from '../ui/server.js';

const USAGE = 'Usage: agentenv ui [--no-open] [--port <port>]\n';

interface UiArguments {
  noOpen: boolean;
  port: number;
}

function argumentError(message: string): RunResult {
  return { stdout: '', stderr: `ui: ${message}\n${USAGE}`, code: 1 };
}

function parseUiArguments(args: readonly string[]): UiArguments | RunResult {
  let noOpen = false;
  let port = 0;
  let portSeen = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--no-open') {
      noOpen = true;
      continue;
    }
    if (argument === '--port') {
      if (portSeen) return argumentError("option '--port' may only be supplied once");
      const value = args[index + 1];
      if (value === undefined) return argumentError("option '--port' requires a value");
      if (!/^\d+$/.test(value)) return argumentError(`invalid port '${value}'`);
      port = Number(value);
      portSeen = true;
      index += 1;
      if (port < 1_024 || port > 65_535) {
        return argumentError('port must be an integer from 1024 to 65535');
      }
      continue;
    }
    return argumentError(`unexpected argument '${argument}'`);
  }
  return { noOpen, port };
}

async function openWithPlatformApplication(url: string): Promise<void> {
  const executable = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'linux'
      ? 'xdg-open'
      : undefined;
  if (executable === undefined) throw new Error('unsupported desktop platform');

  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [url], { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export const uiCommand: Command = {
  name: 'ui',
  usage: '[--no-open] [--port <port>]',
  summary: 'Browse and edit environments in a local web app',
  hidden: false,

  async run({ args, options }) {
    const parsed = parseUiArguments(args);
    if ('code' in parsed) return parsed;

    const start = options.startUiServer ?? startUiServer;
    let server;
    try {
      server = await start({ port: parsed.port });
    } catch {
      return {
        stdout: '',
        stderr: 'ui: could not start the local server\n',
        code: 1,
      };
    }

    let stderr: string | undefined;
    if (!parsed.noOpen) {
      try {
        await (options.openUiUrl ?? openWithPlatformApplication)(server.launchUrl);
      } catch {
        stderr = 'ui: could not open a browser; use the URL above\n';
      }
    }

    return {
      stdout: `agentenv UI: ${server.launchUrl}\n`,
      stderr,
      code: 0,
      data: { url: server.launchUrl },
    };
  },
};
