import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import type { Paths } from './paths.js';

/**
 * Failure to acquire the agentenv lock within the timeout. Carries the lock
 * path so callers can point the user at it.
 */
export class LockError extends Error {
  constructor(
    message: string,
    readonly lockPath: string,
  ) {
    super(message);
    this.name = 'LockError';
  }
}

/** The record written into the lock file, identifying its holder. */
interface LockHolder {
  pid: number;
  timestamp: number;
  host: string;
  /** A per-acquisition nonce: the true ownership marker for release/reclaim. */
  token: string;
}

/** Tuning + injectable seams for {@link withLock}. Defaults suit real use. */
export interface LockOptions {
  /** Max time (ms) to wait for a held lock before throwing. Default 10000. */
  timeoutMs?: number;
  /** Poll interval (ms) while waiting for a held lock. Default 25. */
  pollMs?: number;
  /**
   * A lock at least this old (ms) is treated as stale and reclaimed, even if
   * its owner still looks alive — the backstop for a process that acquired the
   * lock and then wedged. Default 60000.
   */
  staleMs?: number;
  /** Clock, injected for deterministic tests. Default {@link Date.now}. */
  now?: () => number;
  /** Liveness probe for a pid, injected in tests. Default uses `kill(pid, 0)`. */
  isProcessAlive?: (pid: number) => boolean;
  /** Where reclaim warnings go. Default `console.warn`. */
  onWarn?: (message: string) => void;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH => no such process; EPERM => exists but not ours (still alive).
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read and validate the current holder, or a sentinel. */
async function readHolder(lockPath: string): Promise<LockHolder | 'gone' | 'malformed'> {
  let text: string;
  try {
    text = await readFile(lockPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'gone';
    throw err;
  }
  try {
    const raw = JSON.parse(text) as Partial<LockHolder>;
    if (
      typeof raw.pid === 'number' &&
      typeof raw.timestamp === 'number' &&
      typeof raw.token === 'string' &&
      typeof raw.host === 'string'
    ) {
      return { pid: raw.pid, timestamp: raw.timestamp, host: raw.host, token: raw.token };
    }
  } catch {
    // fall through
  }
  return 'malformed';
}

function describeHolder(holder: LockHolder): string {
  return `pid ${holder.pid} on ${holder.host} since ${new Date(holder.timestamp).toISOString()}`;
}

/**
 * Race-free reclaim: rename the stale lock aside (only one racer wins the
 * rename), then delete it. Losing the rename (ENOENT) means another process
 * already reclaimed it — harmless, we just retry the acquire loop.
 */
async function reclaim(lockPath: string): Promise<void> {
  const aside = `${lockPath}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await rename(lockPath, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  await rm(aside, { force: true });
}

/** Attempt an atomic O_EXCL create carrying our holder record. */
async function tryAcquire(lockPath: string, self: LockHolder): Promise<boolean> {
  let handle;
  try {
    handle = await open(lockPath, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    await handle.writeFile(JSON.stringify(self));
  } finally {
    await handle.close();
  }
  return true;
}

/**
 * Run `fn` while holding the machine-local agentenv lock (design D11: serialises
 * the tool's own store/global mutations; session-view builds need no lock).
 *
 * Contract:
 * - **Mutual exclusion** via an atomic O_EXCL create at `paths.lock` carrying
 *   `{pid, timestamp, host, token}`. A second acquirer never enters the
 *   critical section while the first holds the lock.
 * - **Blocks, then fails** — a contending caller polls every `pollMs` and
 *   proceeds the instant the lock frees; if it is still held after `timeoutMs`
 *   it throws {@link LockError} (deterministic, not an indefinite hang).
 * - **Always releases** — the lock is removed in a `finally`, so a throw from
 *   `fn` frees it (the throw propagates). Release only removes the lock if we
 *   still own it (token match), so a lock reclaimed from us mid-run is not
 *   clobbered.
 * - **Stale reclaim** — a lock whose owner pid is dead, whose age exceeds
 *   `staleMs`, or whose file is malformed is reclaimed (race-free rename-aside)
 *   with a warning via `onWarn`, then acquisition proceeds.
 *
 * Not reentrant: calling `withLock` again from within `fn` in the same process
 * contends with itself and will time out.
 */
export async function withLock<T>(
  paths: Paths,
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const {
    timeoutMs = 10_000,
    pollMs = 25,
    staleMs = 60_000,
    now = Date.now,
    isProcessAlive = defaultIsProcessAlive,
    onWarn = (m: string) => console.warn(m),
  } = options;

  const lockPath = paths.lock;
  await mkdir(dirname(lockPath), { recursive: true });

  const self: LockHolder = {
    pid: process.pid,
    timestamp: now(),
    host: hostname(),
    token: randomBytes(8).toString('hex'),
  };
  const deadline = now() + timeoutMs;

  for (;;) {
    if (await tryAcquire(lockPath, self)) break;

    const holder = await readHolder(lockPath);
    if (holder === 'gone') continue; // freed between our attempt and our read

    const stale =
      holder === 'malformed' ||
      !isProcessAlive(holder.pid) ||
      now() - holder.timestamp >= staleMs;

    if (stale) {
      const which =
        holder === 'malformed' ? 'malformed lock file' : `abandoned by ${describeHolder(holder)}`;
      onWarn(`agentenv: reclaiming stale lock at ${lockPath} (${which})`);
      await reclaim(lockPath);
      continue;
    }

    if (now() >= deadline) {
      throw new LockError(
        `could not acquire agentenv lock at ${lockPath} within ${timeoutMs}ms ` +
          `(held by ${describeHolder(holder)})`,
        lockPath,
      );
    }
    await delay(pollMs);
  }

  try {
    return await fn();
  } finally {
    const holder = await readHolder(lockPath);
    if (holder !== 'gone' && holder !== 'malformed' && holder.token === self.token) {
      await rm(lockPath, { force: true });
    }
  }
}
