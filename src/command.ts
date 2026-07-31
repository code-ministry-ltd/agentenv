import type { Paths } from './paths.js';

/** Outcome of a CLI invocation: text to print and a process exit code. */
export interface RunResult {
  stdout: string;
  stderr?: string;
  code: number;
}

/**
 * Injectable seams for a single invocation. Everything a command needs from
 * the outside world arrives here so command logic stays pure and unit-testable
 * — no direct `process.env`, no TTY prompts, no editor spawning baked in.
 */
export interface RunOptions {
  /** Environment lookup; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Working directory; defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * Confirm a destructive action. Injected in tests to avoid a TTY. When
   * absent, commands fall back to a safe non-interactive default (decline).
   */
  confirm?: (question: string) => Promise<boolean>;
  /**
   * Launch an external editor, resolving to its exit code. Injected in tests
   * so `edit` never spawns a real editor.
   */
  launchEditor?: (command: string, args: readonly string[]) => Promise<number>;
}

/** Everything a command handler receives for one invocation. */
export interface CommandContext {
  /** Positional args and flags after the command name. */
  args: readonly string[];
  /** Resolved agentenv paths (already scoped to the invocation's env). */
  paths: Paths;
  /** The effective environment (options.env ?? process.env). */
  env: NodeJS.ProcessEnv;
  /** The effective working directory. */
  cwd: string;
  /** The raw injectable seams, for the few commands that need them. */
  options: RunOptions;
}

/** A named subcommand registered in the dispatch table. */
export interface Command {
  /** The token users type, e.g. `create`. */
  name: string;
  /** One-line description shown in `--help`. */
  summary: string;
  /** Argument summary shown in `--help`, e.g. `<name>`. */
  usage: string;
  run(ctx: CommandContext): Promise<RunResult>;
}
