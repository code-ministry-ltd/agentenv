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

  it('reclaims a lock older than staleMs even if its owner still looks alive', async () => {
    const p = paths();
    writeFileSync(
      p.lock,
      JSON.stringify({
        pid: process.pid,
        timestamp: Date.now() - 100_000,
        host: hostname(),
        token: 'old',
      }),
    );
    const warnings: string[] = [];

    const result = await withLock(p, async () => 'ran', {
      staleMs: 1000, // lock is ~100s old
      isProcessAlive: () => true,
      onWarn: (m) => warnings.push(m),
    });

    expect(result).toBe('ran');
    expect(warnings.some((w) => /reclaiming stale lock/.test(w))).toBe(true);
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
