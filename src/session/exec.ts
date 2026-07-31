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

/**
 * Default self-check capture timeout (ms). A self-check probe spawns the harness;
 * a hung harness must not hang the launch (M3) — the spike hard-times every
 * harness call. On timeout the child is killed and the capture resolves with
 * `code: null`, so the self-check sees no matching root → `ok: false` → fail-open.
 */
export const CAPTURE_TIMEOUT_MS = 10_000;

/**
 * Build a spawn-and-capture that kills the child and resolves after `timeoutMs`,
 * so a self-check against a hanging harness can never block the launch.
 */
export function makeCapture(timeoutMs: number): CaptureFn {
  return (binaryPath, args, env) =>
    new Promise((resolve) => {
      const child = spawn(binaryPath, [...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const settle = (r: { code: number | null; stdout: string; stderr: string }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        settle({ code: null, stdout, stderr: `${stderr}\n[agentenv: self-check timed out after ${timeoutMs}ms]` });
      }, timeoutMs);
      timer.unref?.(); // never keep the event loop alive for the probe timer
      child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('exit', (code) => settle({ code, stdout, stderr }));
      child.on('error', () => settle({ code: 127, stdout, stderr }));
    });
}

/** The production capture: spawn with piped stdout/stderr, collect both, time out. */
export const defaultCapture: CaptureFn = makeCapture(CAPTURE_TIMEOUT_MS);
