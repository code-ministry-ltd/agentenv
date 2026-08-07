import { spawn, spawnSync, execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolvePaths } from '../src/paths.js';
import { readState } from '../src/state.js';
import { makeTempHome, type TempHome } from './helpers.js';

const projectRoot = join(import.meta.dirname, '..');
const childScript = join(import.meta.dirname, 'fixtures', 'staged-command-kill-child.mjs');
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
  precondition?: boolean;
  whileStopped?: (home: TempHome) => void;
}

async function killAt(
  label: string,
  failForward: boolean,
  kind = 'staged-kill-test',
  options: KillOptions = {},
): Promise<TempHome> {
  const home = makeTempHome();
  homes.push(home);
  const child = spawn(process.execPath, [childScript], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...home.env,
      KILL_LABEL: label,
      FAIL_FORWARD: failForward ? '1' : '0',
      COMMAND_KIND: kind,
      USE_PRECONDITION: options.precondition ? '1' : '0',
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

function recover(home: TempHome): void {
  const result = spawnSync(process.execPath, [childScript], {
    cwd: projectRoot,
    env: { ...process.env, ...home.env, MODE: 'recover' },
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
}

async function expectRecovered(home: TempHome, committed: boolean): Promise<void> {
  const paths = resolvePaths(home.env);
  const root = join(paths.base, 'staged-effects');
  for (const name of ['a', 'b']) {
    expect(readFileSync(join(root, `${name}.txt`), 'utf8')).toBe(
      committed ? `new-${name}\n` : `old-${name}\n`,
    );
  }
  expect(existsSync(join(root, 'git-complete'))).toBe(committed);
  expect((await readState(paths)).inventory).toEqual([committed ? 'new' : 'old']);
  expect((await readState(paths)).commands).toEqual([]);
}

const forward = [
  ['planned|pending,pending,pending', false],
  ['applying|pending,pending,pending', false],
  ['applying|applying,pending,pending', false],
  ['applying|applied,pending,pending', false],
  ['applying|applied,applying,pending', false],
  ['applying|applied,applied,pending', false],
  ['applying|applied,applied,applying', false],
  ['applying|applied,applied,applied', false],
  ['committed|applied,applied,applied', true],
  ['git-pending|applied,applied,applied', true],
  ['complete|applied,applied,applied', true],
] as const;
const rollback = [
  'rolling-back|applied,applying,pending',
  'rolling-back|applied,undoing,pending',
  'rolling-back|applied,undone,pending',
  'rolling-back|undoing,undone,pending',
  'rolling-back|undone,undone,pending',
  'rolled-back|undone,undone,pending',
] as const;
const preconditionBoundaries = [
  'planned|pending,pending,pending,pending',
  'applying|applying,pending,pending,pending',
  'applying|applied,pending,pending,pending',
  'applying|applied,applying,pending,pending',
] as const;

describe.skipIf(process.platform === 'win32')('staged command real subprocess kill recovery', () => {
  for (const [label, committed] of forward) {
    it(`recovers forward boundary ${label}`, async () => {
      const home = await killAt(label, false);
      recover(home);
      await expectRecovered(home, committed);
    });
  }
  for (const label of rollback) {
    it(`recovers rollback boundary ${label}`, async () => {
      const home = await killAt(label, true);
      recover(home);
      await expectRecovered(home, false);
    });
  }

  for (const label of preconditionBoundaries) {
    it(`preserves a replacement source after fresh-process recovery from precondition boundary ${label}`, async () => {
      const replacement = 'version: "1.0"\ndescription: concurrent replacement\n';
      let destinationBefore: Array<{ bytes: Buffer; mode: number }> = [];
      const home = await killAt(label, false, 'environment-create', {
        precondition: true,
        whileStopped: (stoppedHome) => {
          const paths = resolvePaths(stoppedHome.env);
          const root = join(paths.base, 'staged-effects');
          destinationBefore = ['a', 'b'].map((name) => {
            const path = join(root, `${name}.txt`);
            return {
              bytes: readFileSync(path),
              mode: lstatSync(path).mode & 0o7777,
            };
          });
          const source = join(root, 'source');
          rmSync(source, { recursive: true, force: true });
          mkdirSync(source, { recursive: true });
          writeFileSync(join(source, 'env.yaml'), replacement);
        },
      });

      recover(home);

      const paths = resolvePaths(home.env);
      const root = join(paths.base, 'staged-effects');
      expect(readFileSync(join(root, 'source', 'env.yaml'), 'utf8')).toBe(replacement);
      for (const [index, name] of ['a', 'b'].entries()) {
        const path = join(root, `${name}.txt`);
        expect(readFileSync(path)).toEqual(destinationBefore[index]!.bytes);
        expect(lstatSync(path).mode & 0o7777).toBe(destinationBefore[index]!.mode);
      }
      expect((await readState(paths)).inventory).toEqual(['old']);
      expect((await readState(paths)).commands).toEqual([]);
      expect(existsSync(join(paths.live, 'commands', 'staged-subprocess'))).toBe(false);
    });
  }

  for (const kind of [
    'drift-sweep', 'capture', 'manual-adopt', 'adoption-disown',
    'doctor-repair', 'doctor-restore', 'environment-create',
    'environment-edit', 'environment-remove',
  ]) {
    it(`uses recoverable staged semantics for ${kind}`, async () => {
      const preCommit = await killAt('applying|applied,applying,pending', false, kind);
      recover(preCommit);
      await expectRecovered(preCommit, false);
      const postCommit = await killAt('git-pending|applied,applied,applied', false, kind);
      recover(postCommit);
      await expectRecovered(postCommit, true);
    });
  }
});
