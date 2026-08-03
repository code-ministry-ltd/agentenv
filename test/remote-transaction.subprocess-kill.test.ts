import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { getRemoteUrl } from '../src/git.js';
import { resolvePaths } from '../src/paths.js';
import { readState } from '../src/state.js';
import { makeTempHome } from './helpers.js';

const projectRoot = join(import.meta.dirname, '..');
const childScript = join(import.meta.dirname, 'fixtures', 'remote-transaction-kill-child.mjs');
const roots: string[] = [];

beforeAll(() => {
  execFileSync(join(projectRoot, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], {
    cwd: projectRoot,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  });
});

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function emptyRemote(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentenv-remote-kill-'));
  roots.push(root);
  const bare = join(root, 'store.git');
  execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
  return pathToFileURL(bare).href;
}

describe.skipIf(process.platform === 'win32')('remote replacement fresh-process recovery', () => {
  it('restores the old origin before a normal invocation can push after SIGKILL', async () => {
    const home = makeTempHome({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' });
    roots.push(home.home);
    const paths = resolvePaths(home.env);
    const oldUrl = emptyRemote();
    const newUrl = emptyRemote();
    expect((await run(['init'], { env: home.env })).code).toBe(0);
    expect((await run(['remote', oldUrl], { env: home.env })).code).toBe(0);

    const child = spawn(process.execPath, [childScript], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ...home.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        NEW_REMOTE_URL: newUrl,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`child did not publish URL; stdout=${stdout}; stderr=${stderr}`));
      }, 8_000);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        if (!stdout.includes('READY url-applied\n')) return;
        clearTimeout(timeout);
        child.kill('SIGKILL');
        resolve();
      });
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.once('error', reject);
    });
    await new Promise<void>((resolve) => child.once('close', () => resolve()));

    expect(await getRemoteUrl(paths, home.env)).toBe(newUrl);
    const serviced = await run(['list'], { env: home.env });
    expect(serviced.code).toBe(0);
    expect(await getRemoteUrl(paths, home.env)).toBe(oldUrl);
    expect((await readState(paths)).commands).toEqual([]);
  });
});
