import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrationWorkspace, type MigrationBoundary } from '../src/migration.js';
import { capturePathIdentity, type PathIdentity } from '../src/path-identity.js';
import { resolvePaths, type Paths } from '../src/paths.js';

const projectRoot = join(import.meta.dirname, '..');
const childScript = join(import.meta.dirname, 'fixtures', 'migration-kill-child.mjs');
const roots: string[] = [];

interface Fixture {
  root: string;
  env: NodeJS.ProcessEnv;
  paths: Paths;
  external: string;
  rootBefore: PathIdentity;
  externalBefore: PathIdentity;
}

beforeAll(() => {
  execFileSync(join(projectRoot, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], {
    cwd: projectRoot,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  });
});

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(path: string, contents: string, mode?: number): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents, mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
  if (mode !== undefined) chmodSync(path, mode);
}

async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'agentenv-migration-kill-'));
  roots.push(root);
  const base = join(root, 'agentenv');
  const env = { AGENTENV_HOME: base };
  const paths = resolvePaths(env);
  const external = join(root, 'external', 'review');

  write(paths.envYaml('work'), 'version: 1.0\nname: work\n');
  write(join(paths.envDir('work'), 'skills', 'review', 'SKILL.md'), '# review\n');
  write(paths.state, `${JSON.stringify({
    version: '1.0',
    items: [
      {
        surface: 'dir-merge',
        action: 'symlink',
        path: external,
        target: join(paths.envDir('work'), 'skills', 'review'),
        ownerEnv: 'work',
        backupRef: { kind: 'absent' },
      },
    ],
    globalStack: ['work'],
  }, null, 2)}\n`);
  write(join(paths.base, 'sessions.json'), '{"version":"1.0","bindings":[]}\n');
  write(join(paths.live, 'S1', 'fixture', 'config.txt'), 'legacy view bytes\n');
  write(join(paths.shims, 'fixture-harness'), '#!/bin/sh\nprintf old-shim\n', 0o755);
  mkdirSync(join(external, '..'), { recursive: true });
  symlinkSync(join(paths.envDir('work'), 'skills', 'review'), external);

  return {
    root,
    env,
    paths,
    external,
    rootBefore: await capturePathIdentity(paths.base),
    externalBefore: await capturePathIdentity(external),
  };
}

async function killAt(boundary: MigrationBoundary): Promise<Fixture> {
  const subject = await fixture();
  const child = spawn(process.execPath, [childScript], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...subject.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      KILL_BOUNDARY: boundary,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise<void>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`child did not reach '${boundary}'; stdout=${stdout}; stderr=${stderr}`));
    }, 5_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (!stdout.includes(`READY ${boundary}\n`)) return;
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
      reject(new Error(`child exited before '${boundary}' (code=${code}); stderr=${stderr}`));
    });
  });
  await new Promise<void>((resolve) => child.once('close', () => resolve()));
  return subject;
}

function recover(subject: Fixture): void {
  const result = spawnSync(process.execPath, [childScript], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...subject.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      MODE: 'rollback',
    },
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
}

const boundaries: readonly MigrationBoundary[] = [
  'gate-installed',
  'quiescent',
  'root-backed-up',
  'external-backed-up',
  'import-staged',
  'old-root-moved',
  'pointer-switched',
  'global-cow-converted',
  'probes-passed',
  'before-open',
];

describe.skipIf(process.platform === 'win32')('v1 migration real subprocess kill matrix', () => {
  for (const boundary of boundaries) {
    it(`restores exact v1 bytes after SIGKILL at ${boundary}`, async () => {
      const subject = await killAt(boundary);
      recover(subject);

      expect(await capturePathIdentity(subject.paths.base)).toEqual(subject.rootBefore);
      expect(await capturePathIdentity(subject.external)).toEqual(subject.externalBefore);
      expect(readFileSync(join(subject.paths.shims, 'fixture-harness'), 'utf8')).toContain('old-shim');
      const wal = JSON.parse(
        readFileSync(join(migrationWorkspace(subject.paths), 'wal.json'), 'utf8'),
      ) as { migration: { phase: string; gate: string; commitPoint: boolean } };
      expect(wal.migration).toMatchObject({ phase: 'rolled-back', gate: 'closed', commitPoint: false });
    });
  }
});
