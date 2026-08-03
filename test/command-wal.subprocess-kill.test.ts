import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolvePaths } from '../src/paths.js';
import { readState } from '../src/state.js';
import { makeTempHome, type TempHome } from './helpers.js';

const projectRoot = join(import.meta.dirname, '..');
const childScript = join(import.meta.dirname, 'fixtures', 'command-wal-child.mjs');
const homes: TempHome[] = [];

beforeAll(() => {
  execFileSync(join(projectRoot, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], {
    cwd: projectRoot,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  });
});

afterAll(() => {
  for (const home of homes.splice(0)) home.cleanup();
});

async function killAt(label: string, failForward: boolean): Promise<TempHome> {
  const home = makeTempHome();
  homes.push(home);
  const child = spawn(process.execPath, [childScript], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...home.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      KILL_LABEL: label,
      FAIL_FORWARD: failForward ? '1' : '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise<void>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`child did not reach '${label}'; stdout=${stdout}; stderr=${stderr}`));
    }, 5_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (!stdout.includes(`READY ${label}\n`)) return;
      clearTimeout(timeout);
      child.kill('SIGKILL');
      resolve();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (signal === 'SIGKILL') return;
      clearTimeout(timeout);
      reject(new Error(`child exited before '${label}' (code=${code}); stderr=${stderr}`));
    });
  });

  await new Promise<void>((resolve) => child.once('close', () => resolve()));
  return home;
}

function recover(home: TempHome): void {
  const result = spawnSync(process.execPath, [childScript], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...home.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      MODE: 'recover',
    },
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
}

async function expectRecovered(home: TempHome, committed: boolean): Promise<void> {
  const paths = resolvePaths(home.env);
  const effectsDir = join(paths.base, 'wal-effects');
  for (const id of ['a', 'b']) {
    const target = join(effectsDir, `${id}.txt`);
    expect(existsSync(target), `${id} presence`).toBe(committed);
    if (committed) expect(readFileSync(target, 'utf8')).toBe(`effect-${id}\n`);
  }
  expect(existsSync(join(effectsDir, 'git-complete'))).toBe(committed);
  expect((await readState(paths)).commands).toEqual([]);
}

const forwardBoundaries = [
  ['planned|pending,pending', false],
  ['applying|pending,pending', false],
  ['applying|applying,pending', false],
  ['applying|applied,pending', false],
  ['applying|applied,applying', false],
  ['applying|applied,applied', false],
  ['committed|applied,applied', true],
  ['git-pending|applied,applied', true],
  ['complete|applied,applied', true],
] as const;

const rollbackBoundaries = [
  'rolling-back|applied,applying',
  'rolling-back|applied,undoing',
  'rolling-back|applied,undone',
  'rolling-back|undoing,undone',
  'rolling-back|undone,undone',
  'rolled-back|undone,undone',
] as const;

describe.skipIf(process.platform === 'win32')('whole-command WAL real subprocess kill matrix', () => {
  for (const [label, committed] of forwardBoundaries) {
    it(`recovers after SIGKILL at forward boundary ${label}`, async () => {
      const home = await killAt(label, false);
      recover(home);
      await expectRecovered(home, committed);
    });
  }

  for (const label of rollbackBoundaries) {
    it(`recovers after SIGKILL at rollback boundary ${label}`, async () => {
      const home = await killAt(label, true);
      recover(home);
      await expectRecovered(home, false);
    });
  }
});
