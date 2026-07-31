import { describe, expect, it } from 'vitest';
import { makeCapture } from '../src/session/exec.js';

/**
 * M3 regression: the self-check capture must never hang the launch. A harness
 * that never exits is killed after the timeout and the capture resolves with
 * `code: null`, so the self-check finds no matching root → ok:false → fail-open.
 */
describe('session self-check capture timeout (M3)', () => {
  it('kills a hanging harness and resolves quickly with code null', async () => {
    // A child that never exits on its own.
    const capture = makeCapture(200);
    const start = Date.now();
    const res = await capture(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], process.env);
    const elapsed = Date.now() - start;

    expect(res.code).toBeNull(); // timed out, not a clean exit
    expect(res.stderr).toContain('timed out');
    expect(elapsed).toBeLessThan(5000); // resolved via the timeout, did not hang
  });

  it('resolves normally (with the exit code) when the harness exits before the timeout', async () => {
    const capture = makeCapture(5000);
    const res = await capture(process.execPath, ['-e', 'process.stdout.write("hi"); process.exit(0)'], process.env);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('hi');
  });
});
