import { spawn, spawnSync, execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolvePaths } from '../src/paths.js';
import { readState } from '../src/state.js';
import { makeTempHome, type TempHome } from './helpers.js';

const projectRoot = join(import.meta.dirname, '..');
const childScript = join(import.meta.dirname, 'fixtures', 'content-move-kill-child.mjs');
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

interface KillOptions {
  failAfterSource?: boolean;
  whileStopped?: (home: TempHome) => void;
}

async function killMoveAt(boundary: string, options: KillOptions = {}): Promise<TempHome> {
  const home = makeTempHome();
  homes.push(home);
  const child = spawn(process.execPath, [childScript], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...home.env,
      KILL_BOUNDARY: boundary,
      FAIL_AFTER_SOURCE: options.failAfterSource ? '1' : '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`child did not reach '${boundary}'; stdout=${stdout}; stderr=${stderr}`));
    }, 8_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (!stdout.includes(`READY ${boundary}\n`)) return;
      clearTimeout(timeout);
      try {
        options.whileStopped?.(home);
        child.kill('SIGKILL');
        resolve();
      } catch (error) {
        child.kill('SIGKILL');
        reject(error as Error);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal === 'SIGKILL') return;
      clearTimeout(timeout);
      reject(new Error(`child exited early (${code}); ${stderr}`));
    });
  });
  await new Promise<void>((resolve) => child.once('close', () => resolve()));
  return home;
}

function recoverInFreshProcess(home: TempHome): void {
  const result = spawnSync(process.execPath, [childScript], {
    cwd: projectRoot,
    env: { ...process.env, ...home.env, MODE: 'recover' },
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
}

async function expectRecovered(home: TempHome, post: boolean): Promise<void> {
  const paths = resolvePaths(home.env);
  const source = join(paths.envDir('source'), 'commands', 'safe.md');
  const destination = join(paths.envDir('destination'), 'commands', 'safe.md');
  expect(existsSync(source)).toBe(!post);
  expect(existsSync(destination)).toBe(post);
  expect(readFileSync(post ? destination : source, 'utf8')).toBe('source bytes\n');
  expect(readFileSync(paths.envYaml('source'), 'utf8'))
    .toBe('version: "1.0"\ndescription: test\n');
  expect(readFileSync(paths.envYaml('destination'), 'utf8'))
    .toBe('version: "1.0"\ndescription: test\n');
  expect(existsSync(join(paths.base, 'content-move-git-complete'))).toBe(post);
  expect((await readState(paths)).commands).toEqual([]);
}

const forwardBoundaries = [
  ['planned', false],
  ['destination-applying', false],
  ['destination-applied', false],
  ['source-applying', false],
  ['source-applied', false],
  ['committed', true],
  ['git-pending', true],
] as const;

describe.skipIf(process.platform === 'win32')('content move fresh-process recovery', () => {
  for (const [boundary, post] of forwardBoundaries) {
    it(`recovers a real SIGKILL at ${boundary} to the exact ${post ? 'post' : 'pre'}-state`, async () => {
      const home = await killMoveAt(boundary);
      const paths = resolvePaths(home.env);
      const plan = (await readState(paths)).commands[0];
      expect(plan?.kind).toBe('content-move');
      expect(plan?.operations.filter((operation) => operation.kind === 'replace-path')
        .map((operation) => operation.id)).toEqual([
          'destination-environment',
          'source-environment',
        ]);
      expect(plan?.commitPoint).toBe(post);
      expect(existsSync(join(paths.live, 'commands', plan!.transactionId))).toBe(true);
      expect(existsSync(join(paths.base, 'content-move-git-complete'))).toBe(false);

      recoverInFreshProcess(home);
      await expectRecovered(home, post);
      expect(existsSync(join(paths.live, 'commands', plan!.transactionId))).toBe(false);
    });
  }

  for (const boundary of [
    'rollback-source-undoing',
    'rollback-source-undone',
    'rollback-destination-undoing',
    'rollback-destination-undone',
  ]) {
    it(`resumes reverse-order rollback after a real SIGKILL at ${boundary}`, async () => {
      const home = await killMoveAt(boundary, { failAfterSource: true });
      recoverInFreshProcess(home);
      await expectRecovered(home, false);
    });
  }

  it.each(['destination-applied', 'source-applied'] as const)(
    'quarantines a concurrent whole-environment replacement after %s',
    async (boundary) => {
      const side = boundary === 'destination-applied' ? 'destination' : 'source';
      const home = await killMoveAt(boundary, {
        whileStopped: (stoppedHome) => {
          const paths = resolvePaths(stoppedHome.env);
          const environment = paths.envDir(side);
          renameSync(environment, join(stoppedHome.home, `${side}-interrupted-post`));
          mkdirSync(environment);
          writeFileSync(paths.envYaml(side), 'version: "1.0"\ndescription: concurrent\n');
          writeFileSync(join(environment, 'concurrent.txt'), `${side} replacement\n`);
        },
      });

      recoverInFreshProcess(home);
      await expectRecovered(home, false);
      const state = await readState(resolvePaths(home.env));
      const quarantine = state.quarantine.find((record) => record.path.endsWith(`/${side}`));
      expect(quarantine).toBeDefined();
      expect(readFileSync(join(quarantine!.retainedPath, 'concurrent.txt'), 'utf8'))
        .toBe(`${side} replacement\n`);
    },
  );
});
