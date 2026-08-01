import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LockError, withLock } from '../src/lock.js';
import { resolvePaths } from '../src/paths.js';
import { expectRealHomeUntouched, makeTempHome, guardRealHome } from './helpers.js';

/** A promise plus its resolver — the barrier these tests sequence on. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A logical clock for the two timeout tests.
 *
 * `withLock` reads time ONLY through `options.now`, so stepping it a fixed
 * amount per read makes "the deadline expired" a function of how many times the
 * poll loop went round rather than of how fast the machine is. The real
 * `delay(pollMs)` between rounds still runs — the poll loop is genuinely
 * exercised — but a starved process merely takes longer to reach the same
 * outcome instead of reaching a different one.
 */
function steppingClock(stepMs: number): () => number {
  let t = 0;
  return () => (t += stepMs);
}

describe('withLock', () => {
  let temp: ReturnType<typeof makeTempHome>;
  let realBefore: ReturnType<typeof guardRealHome>;

  beforeEach(() => {
    realBefore = guardRealHome();
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
    // A barrier, not a sleep. The winner stays inside its section until the
    // loser has PROVABLY contended: `withLock` probes the holder's liveness on
    // every failed acquire, so that probe is the loser announcing "I tried and
    // was refused". If the lock did not serialise, the loser would slip in here
    // and interleave the markers — and there is no wall-clock window to blow.
    const contended = deferred();
    let inside = 0;
    let maxInside = 0;
    const critical = (tag: string) =>
      withLock(
        p,
        async () => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          events.push(`${tag}:start`);
          // If mutual exclusion is broken the loser never contends, so nothing
          // would ever resolve the barrier — release it here so the test fails
          // on the interleaved markers rather than on a 15s timeout.
          if (inside > 1) contended.resolve();
          await contended.promise;
          events.push(`${tag}:end`);
          inside -= 1;
        },
        // Generous acquire timeout: this asserts mutual exclusion, not a
        // deadline. Under parallel vitest workers the holder's release can be
        // scheduling-starved past the 10s default, spuriously throwing LockError.
        {
          pollMs: 5,
          timeoutMs: 60_000,
          isProcessAlive: () => {
            contended.resolve();
            return true;
          },
        },
      );

    await Promise.all([critical('A'), critical('B')]);

    // Whichever ran first completed fully before the other started.
    expect(maxInside).toBe(1);
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
        // Logical clock: the deadline expires after a fixed NUMBER of poll
        // rounds (4), not after 60 real milliseconds — a 60ms wall-clock budget
        // is routinely blown by a loaded box and fails for reasons that have
        // nothing to do with the lock.
        {
          timeoutMs: 100,
          pollMs: 5,
          staleMs: 10_000_000,
          isProcessAlive: () => true,
          now: steppingClock(25),
        },
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
        // staleMs is deliberately far below the holder's age; the logical clock
        // (see steppingClock) fixes the deadline at 4 poll rounds so the "waiter
        // times out" half is machine-speed independent.
        {
          timeoutMs: 100,
          pollMs: 5,
          staleMs: 1000,
          isProcessAlive: () => true,
          now: steppingClock(25),
        },
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

    // Three barriers replace what used to be three sleeps. Nothing here waits on
    // wall-clock time, so load can make the test slower but never wrong.
    const aEntered = deferred(); // A is provably inside its critical section
    const bSettled = deferred(); // B has been refused (or, on the bug, got in)

    const run = (tag: string, staleMs: number, isProcessAlive: (pid: number) => boolean) =>
      withLock(
        p,
        async () => {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          events.push(`${tag}:start`);
          if (tag === 'A') {
            aEntered.resolve();
            await bSettled.promise; // hold the section open across B's attempt
          } else {
            // On the buggy code B arrives here WHILE A is still inside; the
            // overlap is already recorded in maxConcurrent above.
            bSettled.resolve();
          }
          events.push(`${tag}:end`);
          concurrent -= 1;
        },
        { pollMs: 5, staleMs, timeoutMs: 60_000, isProcessAlive },
      );

    // A takes the lock first and stays inside its section. B runs with an
    // aggressive staleMs: on the buggy code it reclaims A's still-held lock by
    // age and slips into the critical section alongside A (double-entry).
    const a = run('A', 60_000, () => true);
    await aEntered.promise; // A is IN — not "8ms have passed, it probably is"

    // Each liveness probe is one failed acquire by B. After three of them B is
    // demonstrably blocked rather than merely slow, so A may leave.
    let refusals = 0;
    const b = run('B', 1, () => {
      if ((refusals += 1) >= 3) bSettled.resolve();
      return true;
    });
    // Safety net: if B fails outright (e.g. LockError) it would otherwise leave
    // A parked on bSettled forever, turning a clear failure into a test timeout.
    void b.catch(() => {}).finally(() => bSettled.resolve());

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
    // Barrier, not a sleep: the winner holds its section open until the loser
    // has probed it and been refused (see the serialisation test above).
    const contended = deferred();
    // Alive only for our own pid; the planted 999999 reads as dead. A probe of
    // OUR pid means a waiter found the other acquirer holding the lock.
    const isProcessAlive = (pid: number) => {
      if (pid !== process.pid) return false;
      contended.resolve();
      return true;
    };
    const critical = (tag: string) =>
      withLock(
        p,
        async () => {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          events.push(`${tag}:start`);
          // Both in at once => nobody will ever contend and resolve the barrier;
          // release it so the failure is the assertion, not a test timeout.
          if (concurrent > 1) contended.resolve();
          await contended.promise;
          events.push(`${tag}:end`);
          concurrent -= 1;
        },
        // Generous acquire timeout (asserts serialisation, not a deadline) so a
        // scheduling-starved holder under parallel workers can't spuriously fail.
        { pollMs: 5, timeoutMs: 60_000, isProcessAlive },
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
