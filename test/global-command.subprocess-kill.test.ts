import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolvePaths } from '../src/paths.js';
import { readState } from '../src/state.js';
import { makeTempHome, type TempHome } from './helpers.js';

const projectRoot = join(import.meta.dirname, '..');
const childScript = join(import.meta.dirname, 'fixtures', 'global-command-child.mjs');
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

async function killAt(label: string): Promise<TempHome> {
  const home = makeTempHome();
  homes.push(home);
  const child = spawn(process.execPath, [childScript], {
    cwd: projectRoot,
    env: { ...process.env, ...home.env, GIT_CONFIG_GLOBAL: '/dev/null', KILL_LABEL: label },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`child did not reach '${label}'; stdout=${stdout}; stderr=${stderr}`));
    }, 8_000);
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
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal !== 'SIGKILL') reject(new Error(`child exited ${code}; stderr=${stderr}`));
    });
  });
  await new Promise<void>((resolve) => child.once('close', () => resolve()));
  return home;
}

function recover(home: TempHome): void {
  const result = spawnSync(process.execPath, [childScript], {
    cwd: projectRoot,
    env: { ...process.env, ...home.env, GIT_CONFIG_GLOBAL: '/dev/null', MODE: 'recover' },
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
}

describe.skipIf(process.platform === 'win32')('global command real subprocess recovery', () => {
  it('restores exact pre-command surfaces after a kill between surface and state publication', async () => {
    const home = await killAt('applying|applied,pending');
    recover(home);
    const paths = resolvePaths(home.env);
    const real = join(paths.base, 'real-harness', 'skills');
    expect(existsSync(join(real, 'managed'))).toBe(false);
    expect(readFileSync(join(real, 'user', 'SKILL.md'), 'utf8')).toBe('# USER\n');
    expect(await readState(paths)).toMatchObject({ items: [], commands: [] });
  });

  it('completes an already committed global command without undoing it', async () => {
    const home = await killAt('committed|applied,applied');
    recover(home);
    const paths = resolvePaths(home.env);
    const real = join(paths.base, 'real-harness', 'skills');
    expect(readFileSync(join(real, 'managed', 'SKILL.md'), 'utf8')).toBe('# MANAGED\n');
    expect((await readState(paths))).toMatchObject({ globalStack: ['writing'], commands: [] });
  });
});
