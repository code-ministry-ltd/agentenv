import { describe, expect, it } from 'vitest';
import { defaultExecHarness } from '../src/session/exec.js';
import type { ProcessIdentity } from '../src/view-generation.js';

describe('session exec process-group supervision', () => {
  it.skipIf(process.platform === 'win32')(
    'records the spawned process identity and waits for descendants in its group',
    async () => {
      let identity: ProcessIdentity | undefined;
      const childScript = [
        "const { spawn } = require('node:child_process')",
        "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 180)'], { stdio: 'ignore' })",
        'child.unref()',
      ].join(';');
      const startedAt = Date.now();

      const code = await defaultExecHarness({
        binaryPath: process.execPath,
        args: ['-e', childScript],
        env: process.env,
        cwd: process.cwd(),
        onSpawn: (spawned) => {
          identity = spawned;
        },
      });

      expect(code).toBe(0);
      expect(identity).toMatchObject({
        processGroupId: expect.any(Number),
        pid: expect.any(Number),
        processStart: expect.any(String),
      });
      expect(identity?.processGroupId).toBe(identity?.pid);
      expect(identity?.processStart).not.toBe('');
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(120);
      expect(() => process.kill(-(identity?.processGroupId ?? 0), 0)).toThrow();
    },
  );
});
