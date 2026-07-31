import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runGit } from '../src/skill-source.js';

/**
 * F1 regression (HIGH), skill-source edition: `add skill <git-source>` clones with
 * `runGit`, and its timeout must stop a black-holing remote.
 *
 * Real `git clone` spawns a transport helper (`git-remote-https`) as a grandchild
 * that inherits git's stdout pipe. Against a dead/DROPping host, killing only the
 * direct `git` leaves that helper alive (reparented) holding the pipe open, so a
 * runner that resolves on `'close'` NEVER resolves — the awaited clone hangs past
 * the timeout and `add skill` wedges forever.
 *
 * We model that shape with a fake `git` on a temp PATH: it backgrounds two children
 * that inherit fd 1 (the stdout pipe) then blocks. `runGit` must still RESOLVE
 * within its timeout budget (kill the whole process group + resolve on `'exit'`),
 * surface a timed-out failure, and leave no grandchild running.
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

describe('skill-source runGit: a black-holing clone is bounded by the timeout (F1)', () => {
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

    // runGit reads PATH from process.env; point it at the fake git for this test.
    const savedPath = process.env.PATH;
    const savedPidfile = process.env.AGENTENV_TEST_PIDFILE;
    process.env.PATH = `${bin}:${savedPath ?? ''}`;
    process.env.AGENTENV_TEST_PIDFILE = pidfile;

    try {
      const started = Date.now();
      const d = deadline(5_000);
      const race = await Promise.race([
        runGit(['clone', '--depth', '1', 'https://black.hole/x.git', join(work, 'clone')], work, 500),
        d.promise,
      ]);
      d.cancel();
      const elapsed = Date.now() - started;

      // The old code (resolve-on-'close' + kill-only-the-child) never resolves, so
      // the race lands on 'DEADLINE'. The fix must resolve with a timed-out result.
      expect(race).not.toBe('DEADLINE');
      const result = race as Awaited<ReturnType<typeof runGit>>;
      // A timeout resolves with code: null and a 'git timed out' marker in stderr.
      expect(result.code).toBeNull();
      expect(result.stderr).toContain('git timed out');
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
    } finally {
      process.env.PATH = savedPath;
      if (savedPidfile === undefined) delete process.env.AGENTENV_TEST_PIDFILE;
      else process.env.AGENTENV_TEST_PIDFILE = savedPidfile;
    }
  });
});
