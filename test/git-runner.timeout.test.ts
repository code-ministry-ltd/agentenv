import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultGitRunner, type GitRunResult } from '../src/git.js';

/**
 * F1 regression (HIGH): the git timeout must stop a black-holing remote.
 *
 * Real git spawns a transport helper (`git-remote-https`) as a grandchild that
 * inherits git's stdout pipe. Against a dead/DROPping host, killing only the
 * direct `git` leaves the helper alive (reparented) holding that pipe open, so a
 * runner that resolves on `'close'` NEVER resolves — the awaited promise hangs
 * forever and the timeout bounds nothing.
 *
 * We model that shape with a fake `git` on a temp PATH: it backgrounds two
 * children that inherit fd 1 (the stdout pipe) and then blocks. The runner must
 * still RESOLVE within its timeout budget (kill the whole process group + resolve
 * on `'exit'`), and must not leave the grandchildren running.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A temp dir cleaned up after the test. */
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** A deadline that resolves to 'DEADLINE' after `ms`, with a cancel to free the timer. */
function deadline(ms: number): { promise: Promise<'DEADLINE'>; cancel: () => void } {
  let t: NodeJS.Timeout;
  const promise = new Promise<'DEADLINE'>((r) => {
    t = setTimeout(() => r('DEADLINE'), ms);
  });
  return { promise, cancel: () => clearTimeout(t) };
}

describe('git runner: a black-holing remote is bounded by the timeout (F1)', () => {
  it('resolves within the timeout even when a grandchild holds the stdout pipe open', async () => {
    const bin = tempDir('agentenv-fakebin-');
    const work = tempDir('agentenv-work-');
    const pidfile = join(work, 'children.pids');

    // Fake git: two backgrounded children inherit fd 1 (our stdout pipe) and sleep;
    // git itself then blocks (`wait`) until it is killed — exactly the hang shape.
    writeFileSync(
      join(bin, 'git'),
      [
        '#!/bin/sh',
        'sleep 30 &',
        'echo "$!" >> "$AGENTENV_TEST_PIDFILE"',
        'echo hanging',
        'sleep 30 &',
        'echo "$!" >> "$AGENTENV_TEST_PIDFILE"',
        'wait',
        '',
      ].join('\n'),
    );
    chmodSync(join(bin, 'git'), 0o755);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      AGENTENV_TEST_PIDFILE: pidfile,
    };

    const started = Date.now();
    const d = deadline(5_000);
    const race = await Promise.race([
      defaultGitRunner(['fetch', 'origin'], { cwd: work, env, timeoutMs: 500 }),
      d.promise,
    ]);
    d.cancel();
    const elapsed = Date.now() - started;

    // The old code (resolve-on-'close' + kill-only-the-child) never resolves, so
    // the race lands on 'DEADLINE'. The fix must resolve with a timed-out result.
    expect(race).not.toBe('DEADLINE');
    const result = race as GitRunResult;
    expect(result.timedOut).toBe(true);
    // Bounded: well under the 5s deadline (timeout 500ms + kill/exit margin).
    expect(elapsed).toBeLessThan(3_000);
    // We still surface whatever stdout we captured before the kill.
    expect(result.stdout).toContain('hanging');

    // No lingering process: the whole group (both grandchildren) was killed.
    const pids = readFileSync(pidfile, 'utf8')
      .split('\n')
      .map((l) => Number(l.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
    expect(pids.length).toBe(2);
    // Give the group-kill a beat to be reaped, then prove each child is gone.
    await new Promise((r) => setTimeout(r, 200));
    for (const pid of pids) {
      let alive = true;
      try {
        process.kill(pid, 0); // signal 0 probes liveness
      } catch {
        alive = false; // ESRCH — the process is gone
      }
      expect(alive).toBe(false);
    }
  });
});
