import { getVersion } from './version.js';

/** Outcome of a CLI invocation: text to print and a process exit code. */
export interface RunResult {
  stdout: string;
  code: number;
}

const USAGE = `agentenv - virtual environments for AI agents

Usage:
  agentenv [options]

Options:
  -v, --version   Print the version and exit
  -h, --help      Show this help and exit
`;

/**
 * Pure entry point for the CLI: given argv (without the node/script
 * prefix), return what to print and the exit code. Kept side-effect free
 * so it can be unit tested; the executable wrapper in bin.ts performs the
 * actual I/O.
 */
export function run(argv: readonly string[]): RunResult {
  if (argv.includes('--version') || argv.includes('-v')) {
    return { stdout: `${getVersion()}\n`, code: 0 };
  }

  // Default (including --help/-h and no arguments) prints usage.
  return { stdout: USAGE, code: 0 };
}
