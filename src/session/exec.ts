import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import type { ProcessIdentity } from '../view-generation.js';

/** What to exec: a resolved real binary, its args, the environment and cwd. */
export interface ExecSpec {
  binaryPath: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Called once the child process-group identity is known. */
  onSpawn?: (identity: ProcessIdentity) => void | Promise<void>;
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
    const detached = process.platform !== 'win32';
    const child = spawn(spec.binaryPath, [...spec.args], {
      env: spec.env,
      cwd: spec.cwd,
      stdio: 'inherit',
      detached,
    });
    let spawnedPid: number | null = null;
    let spawnRecorded = Promise.resolve();
    child.once('spawn', () => {
      if (!child.pid) return;
      spawnedPid = child.pid;
      spawnRecorded = Promise.resolve(
        spec.onSpawn?.({
          processGroupId: child.pid,
          pid: child.pid,
          processStart: processStartIdentity(child.pid),
        }),
      ).catch(() => {
        // Launch lifecycle callbacks retain/quarantine their own failures. The
        // user's harness must keep running even if lifecycle persistence fails.
      });
    });
    const forward = (sig: NodeJS.Signals): void => {
      try {
        if (detached && spawnedPid) process.kill(-spawnedPid, sig);
        else child.kill(sig);
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
    let settled = false;
    const settle = async (code: number): Promise<void> => {
      if (settled) return;
      settled = true;
      cleanup();
      await spawnRecorded;
      if (detached && spawnedPid) await waitForProcessGroupExit(spawnedPid);
      resolve(code);
    };
    child.on('exit', (code, signal) => {
      const result = signal
        ? 128 + ((osConstants.signals as Record<string, number>)[signal] ?? 0)
        : (code ?? 0);
      void settle(result);
    });
    child.on('error', () => void settle(127));
  });

function processStartIdentity(pid: number): string {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const afterCommand = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      const startTicks = afterCommand[19];
      if (startTicks) return `linux-start-ticks:${startTicks}`;
    } catch {
      // Fall through to ps.
    }
  }
  try {
    const ps = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1_000,
    });
    const value = ps.stdout.trim();
    if (ps.status === 0 && value) return `ps-start:${value}`;
  } catch {
    // A timestamp still distinguishes this launch conservatively on platforms
    // without a queryable process start identity.
  }
  return `spawn-observed:${Date.now()}`;
}

async function waitForProcessGroupExit(processGroupId: number): Promise<void> {
  while (true) {
    try {
      process.kill(-processGroupId, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return;
      // EPERM means the group still exists but is not signalable by this user.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

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
