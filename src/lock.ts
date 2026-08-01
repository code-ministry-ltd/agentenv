import { randomBytes } from 'node:crypto';
import { link, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
   * Age (ms) after which a **different-host** holder — whose pid we cannot probe
   * locally — is treated as reclaimable. It is NOT applied to a same-host holder
   * whose pid is still alive: those are never reclaimed by age (see
   * {@link withLock}). Default 60000.
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

/** Outcome of a reclaim attempt. */
type ReclaimResult =
  | 'reclaimed' // we evicted the stale lock; the caller may now acquire
  | 'lost' // another racer moved it first — re-poll
  | 'superseded'; // a fresh, different holder had replaced it — restored, re-poll

/**
 * Race-free, identity-verified reclaim (TOCTOU-safe).
 *
 * `rename(lockPath → aside)` is atomic: if two waiters race, only one wins the
 * rename; the loser gets ENOENT ('lost') and re-polls. After winning, we re-read
 * the bytes we moved aside and evict ONLY if the on-disk `token` still matches
 * the holder we judged reclaimable (`expectedToken`, or `null` when we judged it
 * reclaimable because it was malformed). If it does not match, a *fresh* holder
 * replaced the lock between our decision and our rename — we `rename(aside →
 * lockPath)` to restore it and re-poll WITHOUT acquiring ('superseded').
 */
async function reclaim(lockPath: string, expectedToken: string | null): Promise<ReclaimResult> {
  const aside = `${lockPath}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await rename(lockPath, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'lost';
    throw err;
  }

  // We now exclusively hold `aside`. Verify the identity we judged reclaimable
  // is still the one on disk before destroying it.
  const moved = await readHolder(aside);
  const identityOk =
    expectedToken === null
      ? moved === 'malformed' // reclaimable because unreadable — still is
      : moved !== 'gone' && moved !== 'malformed' && moved.token === expectedToken;

  if (identityOk) {
    await rm(aside, { force: true });
    return 'reclaimed';
  }

  // A fresh holder took the lock between our decision and our rename. Put its
  // record back so we don't destroy a live lock, then re-poll.
  try {
    await rename(aside, lockPath);
  } catch {
    // The slot is already occupied again (or aside vanished); discard our copy
    // rather than leak it. Whoever holds lockPath now is the authority.
    await rm(aside, { force: true });
  }
  return 'superseded';
}

/**
 * `link(2)` failures that mean "this filesystem cannot make hard links" rather
 * than "the lock is taken". EPERM is the one Linux reports for a filesystem
 * without hard-link support; the others cover the same refusal elsewhere.
 */
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK']);

/**
 * Publish our holder record at `lockPath` **atomically**, or report that
 * someone else holds it.
 *
 * The record is written to a private temp file first and then hard-linked into
 * place, because `link` is the one primitive that is both exclusive and
 * all-at-once: it fails EEXIST if the target exists (the O_EXCL semantics the
 * lock is built on) and, when it succeeds, the lock file carries its holder
 * record from the very instant it becomes visible.
 *
 * The obvious alternative — `open(lockPath, 'wx')` then write — is exclusive
 * but *not* all-at-once: it leaves the lock existing-but-empty across an await.
 * A waiter reading it there cannot parse a holder, judges the lock ownerless,
 * and reclaims it out from under us (see {@link withLock}'s malformed path,
 * whose "still malformed" identity check the same empty bytes satisfy) —
 * breaking mutual exclusion. A sub-millisecond window, but a real one: it
 * failed the serialisation test intermittently under load.
 *
 * Fallback: on a filesystem with no hard links we have no atomic publish
 * available, so we take the two-step create and its window rather than refuse
 * to lock at all. In practice agentenv already needs symlinks elsewhere, so a
 * store on such a filesystem is not a supported configuration.
 */
async function tryAcquire(lockPath: string, self: LockHolder): Promise<boolean> {
  const record = JSON.stringify(self);
  const temp = `${lockPath}.new-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await writeFile(temp, record, { flag: 'wx' });
    try {
      await link(temp, lockPath);
      return true; // the lock is ours, fully formed, as of the link
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return false; // someone else holds it
      if (!LINK_UNSUPPORTED.has(code ?? '')) throw err;
      // else: no hard links here — fall through to the two-step create.
    }
  } finally {
    // The link (or its failure) is the outcome; our copy is always disposable.
    await rm(temp, { force: true });
  }
  return await createInPlace(lockPath, record);
}

/** Non-atomic publish, used only where {@link link} is unsupported. */
async function createInPlace(lockPath: string, record: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(lockPath, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    await handle.writeFile(record);
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
 * - **Mutual exclusion** via an atomic, exclusive publish of `{pid, timestamp,
 *   host, token}` at `paths.lock` (write-temp-then-`link`, see
 *   {@link tryAcquire}). A second acquirer never enters the critical section
 *   while the first holds the lock — and never observes the lock file without
 *   its holder record, so an acquire in flight cannot be mistaken for an
 *   ownerless one and reclaimed.
 * - **Blocks, then fails** — a contending caller polls every `pollMs` and
 *   proceeds the instant the lock frees; if it is still held after `timeoutMs`
 *   it throws {@link LockError} (deterministic, not an indefinite hang).
 * - **Always releases** — the lock is removed in a `finally`, so a throw from
 *   `fn` frees it (the throw propagates). Release only removes the lock if the
 *   on-disk `token` still matches ours, so a lock reclaimed from us mid-run is
 *   never clobbered (we would delete the *new* holder's lock otherwise).
 * - **Stale reclaim (liveness-first, never age-first for a live local holder)** —
 *   a holder is reclaimed only when it is *provably* gone: its file is malformed/
 *   unreadable, or it is a **same-host** pid that is dead. A same-host, still-alive
 *   pid is NEVER reclaimed however old it is — waiters block until it releases or
 *   they hit `timeoutMs` ({@link LockError}). `staleMs` is a fallback used ONLY
 *   for a **different-host** holder, whose pid we cannot probe locally; a
 *   cross-host holder older than `staleMs` is reclaimed. Reclaim is atomic and
 *   identity-verified (rename-aside + token check) so two racers cannot both
 *   evict, and a holder that changed under us is restored rather than destroyed.
 *
 *   Residual risk: a genuinely-alive holder on a *different* host, held past
 *   `staleMs`, can still be reclaimed — we have no cross-host liveness probe.
 *   This is the deliberate, documented trade-off; same-host (the common case) is
 *   fully safe.
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

    // An unreadable/malformed lock has no live owner to protect: reclaim it
    // (identity = "still malformed" is verified inside reclaim).
    if (holder === 'malformed') {
      const outcome = await reclaim(lockPath, null);
      if (outcome === 'reclaimed') {
        onWarn(`agentenv: reclaiming stale lock at ${lockPath} (malformed lock file)`);
      }
      continue;
    }

    // Decide reclaimability. A live, same-host pid is authoritative: never
    // reclaimed, regardless of age. Only provably-gone holders are reclaimed.
    let reclaimable: boolean;
    let which: string;
    if (holder.host === self.host) {
      // Same host: we can probe the pid. Reclaim ONLY if it is dead — a slow but
      // alive holder (e.g. a long `git clone`) keeps the lock however old it is.
      reclaimable = !isProcessAlive(holder.pid);
      which = `dead process ${describeHolder(holder)}`;
    } else {
      // Different host: no local liveness probe, so fall back to age. See the
      // documented cross-host residual risk on withLock.
      reclaimable = now() - holder.timestamp >= staleMs;
      which = `aged-out cross-host holder ${describeHolder(holder)}`;
    }

    if (reclaimable) {
      const outcome = await reclaim(lockPath, holder.token);
      if (outcome === 'reclaimed') {
        onWarn(`agentenv: reclaiming stale lock at ${lockPath} (${which})`);
      }
      // reclaimed → loop and acquire; lost/superseded → loop and re-evaluate.
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
