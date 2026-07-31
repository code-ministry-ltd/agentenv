import type { Command, RunOptions, RunResult } from './command.js';
import { commands, findCommand } from './commands/index.js';
import { resolvePaths } from './paths.js';
import { getVersion } from './version.js';

export type { RunResult, RunOptions } from './command.js';

function helpText(): string {
  const lines = [
    'agentenv - virtual environments for AI agents',
    '',
    'Usage:',
    '  agentenv <command> [options]',
    '',
  ];

  const visible = commands.filter((c) => !c.hidden);
  if (visible.length > 0) {
    const width = Math.max(...visible.map((c) => commandInvocation(c).length));
    lines.push('Commands:');
    for (const c of visible) {
      lines.push(`  ${commandInvocation(c).padEnd(width)}  ${c.summary}`);
    }
    lines.push('');
  }

  lines.push(
    'Options:',
    '  -v, --version   Print the version and exit',
    '  -h, --help      Show this help and exit',
    '',
  );
  return lines.join('\n');
}

function commandInvocation(c: Command): string {
  return c.usage ? `${c.name} ${c.usage}` : c.name;
}

/**
 * The CLI entry point: parse argv (without the node/script prefix), dispatch to
 * a registered command, and return what to print plus an exit code. All I/O is
 * injected via {@link RunOptions} so the whole surface is unit-testable; the
 * executable wrapper in bin.ts performs the only real stream writes.
 */
export async function run(
  argv: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  const first = argv[0];

  if (first === '--version' || first === '-v') {
    return { stdout: `${getVersion()}\n`, code: 0 };
  }

  // No command, or an explicit help request, prints usage and exits 0.
  if (first === undefined || first === '--help' || first === '-h') {
    return { stdout: helpText(), code: 0 };
  }

  const command = findCommand(first);
  if (!command) {
    return {
      stderr: `agentenv: unknown command '${first}'\nRun 'agentenv --help' for usage.\n`,
      stdout: '',
      code: 1,
    };
  }

  return command.run({
    args: argv.slice(1),
    paths: resolvePaths(env),
    env,
    cwd,
    options,
  });
}
