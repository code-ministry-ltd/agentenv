import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LockError, withLock } from '../src/lock.js';
import { resolvePaths } from '../src/paths.js';
import { expectRealHomeUntouched, makeTempHome, realHomeSnapshot } from './helpers.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('withLock', () => {
  let temp: ReturnType<typeof makeTempHome>;
  let realBefore: ReturnType<typeof realHomeSnapshot>;

  beforeEach(() => {
    realBefore = realHomeSnapshot();
    temp = makeTempHome();
  });

  afterEach(() => {
    temp.cleanup();
    expectRealHomeUntouched(realBefore);
  });

  function paths() {
    return resolvePaths(temp.env);
  }

  it('runs fn while holding the lock and releases it afterwards', async () => {
    const p = paths();
    const result = await withLock(p, async () => {
      expect(existsSync(p.lock)).toBe(true); // held during fn
      return 42;
    });
    expect(result).toBe(42);
    expect(existsSync(p.lock)).toBe(false); // released after fn
  });

  it('releases the lock even when fn throws', async () => {
    const p = paths();
    await expect(
      withLock(p, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(existsSync(p.lock)).toBe(false);
  });

  it('serialises overlapping critical sections — they do not interleave', async () => {
    const p = paths();
    const events: string[] = [];
    const critical = (tag: string) =>
      withLock(
        p,
        async () => {
          events.push(`${tag}:start`);
          // Yield to the event loop: if the lock did NOT serialise, the other
          // caller would slip in here and interleave the markers.
          await delay(15);
          events.push(`${tag}:end`);
        },
        { pollMs: 5 },
      );

    await Promise.all([critical('A'), critical('B')]);

    // Whichever ran first completed fully before the other started.
    expect(events).toHaveLength(4);
    expect(events[0]!.split(':')[0]).toBe(events[1]!.split(':')[0]);
    expect(events[2]!.split(':')[0]).toBe(events[3]!.split(':')[0]);
    expect(events[1]).toMatch(/:end$/);
    expect(events[3]).toMatch(/:end$/);
  });

  it('fails clearly after the timeout when the lock is held by a live owner', async () => {
    const p = paths();
    // A live, non-stale holder already owns the lock.
    writeFileSync(
      p.lock,
      JSON.stringify({ pid: process.pid, timestamp: Date.now(), host: hostname(), token: 'held' }),
    );

    let ran = false;
    await expect(
      withLock(
        p,
        async () => {
          ran = true;
          return 'nope';
        },
        { timeoutMs: 60, pollMs: 10, staleMs: 10_000_000, isProcessAlive: () => true },
      ),
    ).rejects.toBeInstanceOf(LockError);

    expect(ran).toBe(false); // never entered the critical section
    expect(existsSync(p.lock)).toBe(true); // the real holder's lock is untouched
  });

  it('reclaims a lock whose owner pid is dead, with a warning', async () => {
    const p = paths();
    writeFileSync(
      p.lock,
      JSON.stringify({ pid: 999_999, timestamp: Date.now(), host: hostname(), token: 'dead' }),
    );
    const warnings: string[] = [];

    const result = await withLock(p, async () => 'ran', {
      isProcessAlive: () => false, // owner is dead
      onWarn: (m) => warnings.push(m),
    });

    expect(result).toBe('ran');
    expect(warnings.some((w) => /reclaiming stale lock/.test(w))).toBe(true);
    expect(existsSync(p.lock)).toBe(false);
  });

  it('reclaims a cross-host lock aged past staleMs (liveness unprovable off-host)', async () => {
    const p = paths();
    // A holder on ANOTHER machine, aged past staleMs. We cannot probe a remote
    // pid locally, so the age threshold is the only available reclaim signal.
    writeFileSync(
      p.lock,
      JSON.stringify({
        pid: 4321,
        timestamp: Date.now() - 100_000,
        host: `${hostname()}-elsewhere`,
        token: 'remote-old',
      }),
    );
    const warnings: string[] = [];

    const result = await withLock(p, async () => 'ran', {
      staleMs: 1000, // lock is ~100s old
      isProcessAlive: () => true, // even "alive" is untrustworthy for a remote pid
      onWarn: (m) => warnings.push(m),
    });

    expect(result).toBe('ran');
    expect(warnings.some((w) => /reclaiming stale lock/.test(w))).toBe(true);
  });

  it('does NOT reclaim a LIVE same-host holder held past staleMs — waiter times out', async () => {
    const p = paths();
    // Same host, still-alive pid, but held far longer than staleMs (e.g. a slow
    // `git clone` in `add skills`). Age alone must NOT evict a live holder.
    writeFileSync(
      p.lock,
      JSON.stringify({
        pid: process.pid,
        timestamp: Date.now() - 100_000,
        host: hostname(),
        token: 'live-but-old',
      }),
    );

    let ran = false;
    await expect(
      withLock(
        p,
        async () => {
          ran = true;
          return 'nope';
        },
        { timeoutMs: 60, pollMs: 10, staleMs: 1000, isProcessAlive: () => true },
      ),
    ).rejects.toBeInstanceOf(LockError);

    expect(ran).toBe(false); // never entered the critical section
    // The original holder's lock is untouched (token unchanged).
    expect(JSON.parse(readFileSync(p.lock, 'utf8')).token).toBe('live-but-old');
  });

  it('never double-enters: a waiter must not reclaim a LIVE same-host holder by age', async () => {
    const p = paths();
    let concurrent = 0;
    let maxConcurrent = 0;
    const events: string[] = [];

    const run = (tag: string, staleMs: number) =>
      withLock(
        p,
        async () => {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          events.push(`${tag}:start`);
          await delay(40);
          events.push(`${tag}:end`);
          concurrent -= 1;
        },
        { pollMs: 5, staleMs, timeoutMs: 5000, isProcessAlive: () => true },
      );

    // A takes the lock first and stays inside its section. B runs with an
    // aggressive staleMs: on the buggy code it reclaims A's still-held lock by
    // age and slips into the critical section alongside A (double-entry).
    const a = run('A', 60_000);
    await delay(8); // let A acquire and enter its section
    const b = run('B', 1);
    await Promise.all([a, b]);

    expect(maxConcurrent).toBe(1); // the sections never overlapped
    expect(events).toHaveLength(4);
    // Whichever ran first completed fully before the other started.
    expect(events[0]!.split(':')[0]).toBe(events[1]!.split(':')[0]);
    expect(events[1]).toMatch(/:end$/);
    expect(events[3]).toMatch(/:end$/);
  });

  it('serialises two acquirers reclaiming a dead-pid stale lock — one section at a time', async () => {
    const p = paths();
    // A stale lock left by a crashed process (pid dead on THIS host).
    writeFileSync(
      p.lock,
      JSON.stringify({ pid: 999_999, timestamp: Date.now() - 1, host: hostname(), token: 'dead' }),
    );

    let concurrent = 0;
    let maxConcurrent = 0;
    const events: string[] = [];
    // Alive only for our own pid; the planted 999999 reads as dead.
    const isProcessAlive = (pid: number) => pid === process.pid;
    const critical = (tag: string) =>
      withLock(
        p,
        async () => {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          events.push(`${tag}:start`);
          await delay(20);
          events.push(`${tag}:end`);
          concurrent -= 1;
        },
        { pollMs: 5, isProcessAlive },
      );

    await Promise.all([critical('A'), critical('B')]);

    expect(maxConcurrent).toBe(1); // exactly one critical section at a time
    expect(events).toHaveLength(4);
    expect(events[0]!.split(':')[0]).toBe(events[1]!.split(':')[0]);
    expect(events[1]).toMatch(/:end$/);
  });

  it('reclaims a malformed lock file', async () => {
    const p = paths();
    writeFileSync(p.lock, 'not json {{{');
    const warnings: string[] = [];

    const result = await withLock(p, async () => 'ran', {
      onWarn: (m) => warnings.push(m),
    });

    expect(result).toBe('ran');
    expect(warnings.some((w) => /malformed lock file/.test(w))).toBe(true);
  });

  it('writes pid + timestamp into the lock while held', async () => {
    const p = paths();
    await withLock(p, async () => {
      const holder = JSON.parse(readFileSync(p.lock, 'utf8'));
      expect(holder.pid).toBe(process.pid);
      expect(typeof holder.timestamp).toBe('number');
      expect(typeof holder.token).toBe('string');
    });
  });
});
