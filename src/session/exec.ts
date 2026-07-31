import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';

/** What to exec: a resolved real binary, its args, the environment and cwd. */
export interface ExecSpec {
  binaryPath: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

/**
 * Exec a resolved harness binary and resolve its exit code. Injected as a seam so
 * the launch decision is unit-testable without spawning a real process; the
 * default spawns with inherited stdio (the harness owns the terminal) and
 * forwards the exit code (128+signal when it was signalled).
 */
export type ExecHarness = (spec: ExecSpec) => Promise<number>;

/** Spawn-and-capture, used by self-check probes. Injected for the same reason. */
export type CaptureFn = (
  binaryPath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/**
 * The production exec: hand the terminal to the child (`stdio: 'inherit'`) and
 * forward the common termination signals so Ctrl-C reaches the harness. Resolves
 * the child's exit code; a spawn error resolves 127 (command-not-executable),
 * matching a shell.
 */
export const defaultExecHarness: ExecHarness = (spec) =>
  new Promise((resolve) => {
    const child = spawn(spec.binaryPath, [...spec.args], {
      env: spec.env,
      cwd: spec.cwd,
      stdio: 'inherit',
    });
    const forward = (sig: NodeJS.Signals): void => {
      try {
        child.kill(sig);
      } catch {
        /* child already gone */
      }
    };
    const handlers = FORWARDED_SIGNALS.map((s) => {
      const h = (): void => forward(s);
      process.on(s, h);
      return [s, h] as const;
    });
    const cleanup = (): void => {
      for (const [s, h] of handlers) process.off(s, h);
    };
    child.on('exit', (code, signal) => {
      cleanup();
      if (signal) {
        const num = (osConstants.signals as Record<string, number>)[signal] ?? 0;
        resolve(128 + num);
      } else {
        resolve(code ?? 0);
      }
    });
    child.on('error', () => {
      cleanup();
      resolve(127);
    });
  });

/** The production capture: spawn with piped stdout/stderr and collect both. */
export const defaultCapture: CaptureFn = (binaryPath, args, env) =>
  new Promise((resolve) => {
    const child = spawn(binaryPath, [...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
    child.on('error', () => resolve({ code: 127, stdout, stderr }));
  });
