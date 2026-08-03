import type { Adapter } from './adapter.js';
import type { ConflictedFile, GitRunner } from './git.js';
import type { Paths } from './paths.js';
import type { CaptureFn, ExecHarness } from './session/exec.js';
import type { MigrationRequest } from './migration.js';

/** Outcome of a CLI invocation: text to print and a process exit code. */
export interface RunResult {
  stdout: string;
  stderr?: string;
  code: number;
}

/** One skill offered by the `add skills` checklist: a name and its description. */
export interface SkillChoice {
  name: string;
  description: string;
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
   * Choose which discovered skills `add skills` installs (design D17). Injected
   * in tests so the checklist runs with no TTY; returns the selected skill names.
   * When absent, commands fall back to the default TTY selector (or `--all`).
   */
  selectSkills?: (choices: readonly SkillChoice[]) => Promise<readonly string[]>;
  /**
   * Launch an external editor, resolving to its exit code. Injected in tests
   * so `edit` never spawns a real editor.
   */
  launchEditor?: (command: string, args: readonly string[]) => Promise<number>;
  /**
   * The adapter registry the session commands (`run`, `__shim`, `shell-init`)
   * resolve harnesses against. Defaults to the real registry (empty in Phase 1);
   * tests inject the fixture adapter so the machinery runs with no real harness.
   */
  adapters?: readonly Adapter[];
  /** Exec seam for session launches; defaults to spawning with inherited stdio. */
  execHarness?: ExecHarness;
  /** Capture seam for adapter self-check probes; defaults to spawning captured. */
  capture?: CaptureFn;
  /** Injectable clock (view build timestamps). */
  now?: () => number;
  /**
   * Injectable `git` runner for the store sync lifecycle (Task 2.1). Defaults to
   * the real spawn-based runner; tests inject it to count pushes / simulate a
   * failing or unreachable remote deterministically, with no network.
   */
  gitRun?: GitRunner;
  /**
   * Resolve a rebase conflict during `agentenv sync --resolve` (Task 2.2). This is
   * the "user resolved the files on disk" step, injected so the walkthrough is
   * testable non-interactively: it receives the conflicted store files and MUST
   * write the resolved content to each `absPath`, returning `true` to continue the
   * rebase or `false` to abort and keep local. agentenv NEVER auto-resolves — with
   * no seam the command runs the guided on-disk two-step flow (show files → edit →
   * re-run to continue).
   */
  resolveConflicts?: (files: readonly ConflictedFile[]) => Promise<boolean>;
  /** Hermetic migration seams for quiescence, probes, clocks, and fault tests. */
  migration?: Omit<MigrationRequest, 'paths' | 'adapters'>;
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
  /** Internal commands (e.g. the `__shim` entrypoint) are hidden from `--help`. */
  hidden?: boolean;
  run(ctx: CommandContext): Promise<RunResult>;
}
