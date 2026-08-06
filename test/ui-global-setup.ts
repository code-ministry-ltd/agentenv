import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function launchUrlFrom(child: ChildProcess): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let output = '';
    const fail = (error: Error): void => {
      clearTimeout(timeout);
      reject(error);
    };
    const timeout = setTimeout(() => fail(new Error('UI test server did not start')), 10_000);
    child.once('error', fail);
    child.once('exit', (code) => fail(new Error(`UI test server exited early (${code})`)));
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const match = /agentenv UI: (http:\/\/127\.0\.0\.1:\d+\/#launch=[A-Za-z0-9_-]+)/.exec(
        output,
      );
      if (match?.[1] !== undefined) {
        clearTimeout(timeout);
        resolve(match[1]);
      } else if (output.length > 4_096) {
        fail(new Error('UI test server returned an invalid launch response'));
      }
    });
  });
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const home = await mkdtemp(join(tmpdir(), 'agentenv-ui-e2e-'));
  const child = spawn(
    process.execPath,
    ['dist/bin.js', 'ui', '--no-open', '--port', '41739'],
    {
      cwd: process.cwd(),
      env: { ...process.env, AGENTENV_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  try {
    process.env.AGENTENV_UI_TEST_LAUNCH_URL = await launchUrlFrom(child);
  } catch (error) {
    child.kill('SIGKILL');
    await rm(home, { recursive: true, force: true });
    throw error;
  }

  return async () => {
    delete process.env.AGENTENV_UI_TEST_LAUNCH_URL;
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    await rm(home, { recursive: true, force: true });
  };
}
