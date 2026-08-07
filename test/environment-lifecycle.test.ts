import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cloneEnvironment as cloneEnvironmentOperation,
  createEnvironment as createEnvironmentOperation,
  type CloneEnvironmentInput,
  type CreateEnvironmentInput,
} from '../src/application/environment-lifecycle.js';
import {
  createEnvironmentLifecycleRuntime,
  type EnvironmentLifecycleRuntime,
} from '../src/application/environment-lifecycle-runtime.js';
import { run } from '../src/cli.js';
import { createCommandPlan } from '../src/command-plan.js';
import { defaultGitRunner, type GitRunner } from '../src/git.js';
import { capturePathIdentity } from '../src/path-identity.js';
import { resolvePaths } from '../src/paths.js';
import { emptyManifest, readState, writeState } from '../src/state.js';
import { makeTempHome, type TempHome } from './helpers.js';

const homes: TempHome[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) home.cleanup();
});

function tempHome(extraEnv: NodeJS.ProcessEnv = {}): TempHome {
  const home = makeTempHome(extraEnv);
  homes.push(home);
  return home;
}

function failingCommits(): GitRunner {
  return (args, options) => args.includes('commit')
    ? Promise.resolve({
        code: 1,
        stdout: '',
        stderr: 'injected lifecycle Git failure',
        timedOut: false,
      })
    : defaultGitRunner(args, options);
}

type TestCreateInput = Omit<CreateEnvironmentInput, 'runtime'> & {
  env?: NodeJS.ProcessEnv;
  runtime?: EnvironmentLifecycleRuntime;
};

type TestCloneInput = Omit<CloneEnvironmentInput, 'runtime'> & {
  env?: NodeJS.ProcessEnv;
  runtime?: EnvironmentLifecycleRuntime;
};

function createEnvironment(input: TestCreateInput) {
  return createEnvironmentOperation({
    paths: input.paths,
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.faults ? { faults: input.faults } : {}),
    runtime: input.runtime ?? createEnvironmentLifecycleRuntime({ paths: input.paths }),
  });
}

function cloneEnvironment(input: TestCloneInput) {
  return cloneEnvironmentOperation({
    paths: input.paths,
    name: input.name,
    source: input.source,
    ...(input.faults ? { faults: input.faults } : {}),
    runtime: input.runtime ?? createEnvironmentLifecycleRuntime({ paths: input.paths }),
  });
}

describe('environment lifecycle application operations', () => {
  it('creates the valid CLI scaffold with an application-supplied description', async () => {
    const home = tempHome();
    const paths = resolvePaths(home.env);

    const result = await createEnvironment({
      paths,
      env: home.env,
      name: 'writing',
      description: 'Long-form writing',
    });

    expect(result).toMatchObject({
      status: 'created',
      operation: 'create',
      name: 'writing',
      publication: 'complete',
    });
    expect(result).not.toHaveProperty('notices');
    expect(readFileSync(paths.envYaml('writing'), 'utf8')).toContain(
      'description: Long-form writing',
    );
    expect(existsSync(paths.storeReadme)).toBe(true);
  });

  it('clones the exact complete source tree including provenance, modes, and symlinks', async () => {
    const home = tempHome();
    const paths = resolvePaths(home.env);
    const source = paths.envDir('writing');
    mkdirSync(join(source, 'skills', 'thinking-partner'), { recursive: true });
    writeFileSync(
      paths.envYaml('writing'),
      'version: "1.0"\n' +
        'description: source\n' +
        'sources:\n' +
        '  thinking-partner:\n' +
        '    repo: owner/repo\n' +
        '    path: skills/thinking-partner\n' +
        '    ref: main\n' +
        '    commit: abcdef123456\n' +
        '    hash: deadbeef\n',
    );
    const skill = join(source, 'skills', 'thinking-partner', 'SKILL.md');
    writeFileSync(skill, '---\nname: thinking-partner\ndescription: Think.\n---\n\n# Think\n');
    chmodSync(skill, 0o640);
    writeFileSync(join(source, 'notes.txt'), 'opaque source bytes\n');
    symlinkSync('notes.txt', join(source, 'notes-link'));

    const result = await cloneEnvironment({
      paths,
      env: home.env,
      source: 'writing',
      name: 'blogging',
    });

    expect(result).toMatchObject({
      status: 'created',
      operation: 'clone',
      name: 'blogging',
      source: 'writing',
      publication: 'complete',
    });
    expect(await capturePathIdentity(paths.envDir('blogging'))).toEqual(
      await capturePathIdentity(source),
    );
    expect(readlinkSync(join(paths.envDir('blogging'), 'notes-link'))).toBe('notes.txt');
  });

  it.each(['outside', 'dangling'] as const)(
    'refuses a %s source-root symlink without touching the link or its target',
    async (kind) => {
      const home = tempHome();
      const paths = resolvePaths(home.env);
      mkdirSync(paths.environments, { recursive: true });
      const source = paths.envDir('writing');
      const target = join(home.home, kind === 'outside' ? 'external-environment' : 'missing-environment');
      if (kind === 'outside') {
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, 'env.yaml'), 'version: "1.0"\ndescription: external\n');
      }
      symlinkSync(target, source);
      const sourceBefore = await capturePathIdentity(source);
      const targetBefore = await capturePathIdentity(target);

      const result = await cloneEnvironment({
        paths,
        env: home.env,
        source: 'writing',
        name: 'blogging',
      });

      expect(result).toMatchObject({ status: 'failure' });
      expect(await capturePathIdentity(source)).toEqual(sourceBefore);
      expect(readlinkSync(source)).toBe(target);
      expect(await capturePathIdentity(target)).toEqual(targetBefore);
      expect(await capturePathIdentity(paths.envDir('blogging'))).toEqual({ kind: 'absent' });
    },
  );

  it('never reads or clones through a symlinked environments ancestor', async () => {
    const home = tempHome();
    const paths = resolvePaths(home.env);
    const outside = join(home.home, 'external-environments');
    const source = join(outside, 'writing');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'env.yaml'), 'version: "1.0"\ndescription: external\n');
    mkdirSync(paths.store, { recursive: true });
    symlinkSync(outside, paths.environments);

    const result = await cloneEnvironment({
      paths,
      env: home.env,
      source: 'writing',
      name: 'blogging',
    });

    expect(result).toMatchObject({ status: 'failure' });
    expect(existsSync(join(outside, 'blogging'))).toBe(false);
    expect(readFileSync(join(source, 'env.yaml'), 'utf8')).toContain('external');
  });

  it('refuses a non-regular env.yaml without following it outside the source tree', async () => {
    const home = tempHome();
    const paths = resolvePaths(home.env);
    const source = paths.envDir('writing');
    const outsideYaml = join(home.home, 'outside-env.yaml');
    mkdirSync(source, { recursive: true });
    writeFileSync(outsideYaml, 'version: "1.0"\ndescription: outside\n');
    symlinkSync(outsideYaml, paths.envYaml('writing'));
    const sourceBefore = await capturePathIdentity(source);
    const outsideBefore = await capturePathIdentity(outsideYaml);

    const result = await cloneEnvironment({
      paths,
      env: home.env,
      source: 'writing',
      name: 'blogging',
    });

    expect(result).toMatchObject({ status: 'failure' });
    expect(await capturePathIdentity(source)).toEqual(sourceBefore);
    expect(await capturePathIdentity(outsideYaml)).toEqual(outsideBefore);
    expect(await capturePathIdentity(paths.envDir('blogging'))).toEqual({ kind: 'absent' });
  });

  it.each([
    [
      'absolute',
      (source: string, outside: string) => {
        void outside;
        return source;
      },
      (source: string) => join(source, 'notes.txt'),
    ],
    ['out-of-tree', (_source: string, outside: string) => outside, () => '../../outside.txt'],
  ] as const)(
    'refuses an %s internal symlink so the clone cannot escape its own tree',
    async (_kind, setupTarget, linkTarget) => {
      const home = tempHome();
      const paths = resolvePaths(home.env);
      const source = paths.envDir('writing');
      const outside = join(home.home, 'outside.txt');
      mkdirSync(source, { recursive: true });
      writeFileSync(paths.envYaml('writing'), 'version: "1.0"\ndescription: source\n');
      writeFileSync(outside, 'outside bytes\n');
      writeFileSync(join(source, 'notes.txt'), 'inside bytes\n');
      symlinkSync(linkTarget(source), join(source, 'hostile-link'));
      const protectedPath = setupTarget(source, outside);
      const protectedBefore = await capturePathIdentity(protectedPath);

      const result = await cloneEnvironment({
        paths,
        env: home.env,
        source: 'writing',
        name: 'blogging',
      });

      expect(result).toMatchObject({ status: 'failure' });
      expect(await capturePathIdentity(protectedPath)).toEqual(protectedBefore);
      expect(await capturePathIdentity(paths.envDir('blogging'))).toEqual({ kind: 'absent' });
    },
  );

  it('treats a dangling destination symlink as existing and preserves its exact target', async () => {
    const home = tempHome();
    const paths = resolvePaths(home.env);
    mkdirSync(paths.environments, { recursive: true });
    const destination = paths.envDir('writing');
    const danglingTarget = '../missing-writing';
    symlinkSync(danglingTarget, destination);
    const before = await capturePathIdentity(destination);

    const result = await createEnvironment({ paths, env: home.env, name: 'writing' });

    expect(result).toEqual({ status: 'exists', name: 'writing' });
    expect(await capturePathIdentity(destination)).toEqual(before);
    expect(readlinkSync(destination)).toBe(danglingTarget);
    expect(existsSync(join(paths.environments, 'missing-writing'))).toBe(false);
  });

  it('refuses invalid, missing-source, existing, and invalid-source requests without publication', async () => {
    const home = tempHome();
    const paths = resolvePaths(home.env);

    expect(await createEnvironment({ paths, env: home.env, name: '../escape' }))
      .toMatchObject({ status: 'invalid', field: 'name' });
    expect(await cloneEnvironment({ paths, env: home.env, source: 'ghost', name: 'copy' }))
      .toMatchObject({ status: 'source-not-found', source: 'ghost' });
    expect(existsSync(paths.environments)).toBe(false);

    await createEnvironment({ paths, env: home.env, name: 'writing' });
    expect(await createEnvironment({ paths, env: home.env, name: 'writing' }))
      .toMatchObject({ status: 'exists', name: 'writing' });

    mkdirSync(paths.envDir('broken'), { recursive: true });
    writeFileSync(paths.envYaml('broken'), 'version: [not valid\n');
    expect(await cloneEnvironment({ paths, env: home.env, source: 'broken', name: 'copy' }))
      .toMatchObject({ status: 'failure' });
    expect(existsSync(paths.envDir('copy'))).toBe(false);
  });

  it('refuses a stale source and preserves its concurrent replacement', async () => {
    const home = tempHome();
    const paths = resolvePaths(home.env);
    await createEnvironment({ paths, env: home.env, name: 'writing' });
    const replacement = 'version: "1.0"\ndescription: concurrent source\n';

    const result = await cloneEnvironment({
      paths,
      env: home.env,
      source: 'writing',
      name: 'blogging',
      faults: {
        afterSourceCopy: async () => {
          writeFileSync(paths.envYaml('writing'), replacement);
        },
      },
    });

    expect(result).toMatchObject({ status: 'stale', field: 'source', name: 'writing' });
    expect(readFileSync(paths.envYaml('writing'), 'utf8')).toBe(replacement);
    expect(existsSync(paths.envDir('blogging'))).toBe(false);
  });

  it('rechecks the durable source precondition after WAL persistence and before publication', async () => {
    const home = tempHome();
    const paths = resolvePaths(home.env);
    await createEnvironment({ paths, env: home.env, name: 'writing' });
    const source = paths.envDir('writing');
    const expectedSource = await capturePathIdentity(source);
    const replacement = 'version: "1.0"\ndescription: after persist replacement\n';
    let replaced = false;

    const result = await cloneEnvironment({
      paths,
      env: home.env,
      source: 'writing',
      name: 'blogging',
      faults: {
        afterPersist: async (plan) => {
          const sourcePrecondition = plan.operations.find(
            (operation) => operation.id === 'source-environment',
          );
          if (plan.phase === 'planned') {
            expect(sourcePrecondition).toMatchObject({
              kind: 'read-path-precondition',
              path: source,
              preIdentity: expectedSource,
              postIdentity: expectedSource,
              state: 'pending',
            });
          }
          if (
            !replaced &&
            plan.phase === 'applying' &&
            sourcePrecondition?.state === 'applied' &&
            plan.operations.find((operation) => operation.id === 'environment')?.state === 'pending'
          ) {
            replaced = true;
            rmSync(source, { recursive: true });
            mkdirSync(source, { recursive: true });
            writeFileSync(paths.envYaml('writing'), replacement);
          }
        },
      },
    });

    expect(replaced).toBe(true);
    expect(result).toMatchObject({ status: 'stale', field: 'source', name: 'writing' });
    expect(readFileSync(paths.envYaml('writing'), 'utf8')).toBe(replacement);
    expect(await capturePathIdentity(paths.envDir('blogging'))).toEqual({ kind: 'absent' });
    expect((await readState(paths)).commands).toEqual([]);
  });

  it('refuses a stale destination and preserves its concurrent creation', async () => {
    const home = tempHome();
    const paths = resolvePaths(home.env);
    const replacement = 'version: "1.0"\ndescription: concurrent destination\n';

    const result = await createEnvironment({
      paths,
      env: home.env,
      name: 'writing',
      faults: {
        afterStage: async () => {
          mkdirSync(paths.envDir('writing'), { recursive: true });
          writeFileSync(paths.envYaml('writing'), replacement);
        },
      },
    });

    expect(result).toMatchObject({ status: 'stale', field: 'destination', name: 'writing' });
    expect(readFileSync(paths.envYaml('writing'), 'utf8')).toBe(replacement);
  });

  it.each(['create', 'clone'] as const)(
    'maps a post-persist %s destination replacement to stale and preserves it',
    async (operation) => {
      const home = tempHome();
      const paths = resolvePaths(home.env);
      if (operation === 'clone') {
        await createEnvironment({ paths, env: home.env, name: 'source' });
      }
      const destination = paths.envDir('writing');
      const replacement = `version: "1.0"\ndescription: concurrent ${operation} destination\n`;
      let replaced = false;

      const faults = {
        afterPersist: async (plan: ReturnType<typeof createCommandPlan>) => {
          if (replaced || plan.phase !== 'planned') return;
          replaced = true;
          mkdirSync(destination, { recursive: true });
          writeFileSync(join(destination, 'env.yaml'), replacement);
        },
      };
      const result = operation === 'create'
        ? await createEnvironment({ paths, env: home.env, name: 'writing', faults })
        : await cloneEnvironment({
            paths,
            env: home.env,
            source: 'source',
            name: 'writing',
            faults,
          });

      expect(replaced).toBe(true);
      expect(result).toMatchObject({
        status: 'stale',
        field: 'destination',
        name: 'writing',
      });
      expect(readFileSync(join(destination, 'env.yaml'), 'utf8')).toBe(replacement);
      expect((await readState(paths)).commands).toEqual([]);
    },
  );

  it('keeps environment-container identity durable until the first create mutation', async () => {
    const home = tempHome();
    const paths = resolvePaths(home.env);
    const outside = join(home.home, 'external-environments');
    let replaced = false;
    let sawDurableContainer = false;

    const result = await createEnvironment({
      paths,
      env: home.env,
      name: 'writing',
      faults: {
        afterPersist: async (plan) => {
          const container = plan.operations.find(
            (operation) => operation.id === 'environment-container',
          );
          if (plan.phase === 'planned') {
            sawDurableContainer = container?.kind === 'read-path-precondition';
            if (!replaced) {
              replaced = true;
              mkdirSync(paths.store, { recursive: true });
              mkdirSync(outside, { recursive: true });
              rmSync(paths.environments, { recursive: true, force: true });
              symlinkSync(outside, paths.environments);
            }
          }
        },
      },
    });

    expect(sawDurableContainer).toBe(true);
    expect(result).toMatchObject({ status: 'stale', field: 'destination', name: 'writing' });
    expect(existsSync(join(outside, 'writing'))).toBe(false);
    expect((await readState(paths)).commands).toEqual([]);
  });

  it('reports pending recovery before staging or publishing another environment', async () => {
    const home = tempHome();
    const paths = resolvePaths(home.env);
    const manifest = emptyManifest();
    manifest.commands.push(createCommandPlan({
      transactionId: 'retained-command',
      kind: 'environment-edit',
      operations: [],
    }));
    await writeState(paths, manifest);

    const result = await createEnvironment({ paths, env: home.env, name: 'writing' });

    expect(result).toMatchObject({
      status: 'pending-recovery',
      transactionId: 'retained-command',
    });
    expect(existsSync(paths.envDir('writing'))).toBe(false);
    expect(existsSync(paths.storeReadme)).toBe(false);
  });

  it('rolls back every published path when publication fails before the commit point', async () => {
    const home = tempHome();
    const paths = resolvePaths(home.env);

    const result = await createEnvironment({
      paths,
      env: home.env,
      name: 'writing',
      faults: {
        afterApply: async (operationId) => {
          if (operationId === 'environment') throw new Error('injected publication failure');
        },
      },
    });

    expect(result).toMatchObject({ status: 'failure', message: 'injected publication failure' });
    expect(existsSync(paths.envDir('writing'))).toBe(false);
    expect(existsSync(paths.storeReadme)).toBe(false);
    expect((await readState(paths)).commands).toEqual([]);
  });

  it('reports a complete local post-state as Git-pending when required bookkeeping fails', async () => {
    const home = tempHome({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' });
    const paths = resolvePaths(home.env);
    await run(['init'], { env: home.env });

    const result = await createEnvironment({
      paths,
      env: home.env,
      name: 'writing',
      runtime: createEnvironmentLifecycleRuntime({
        paths,
        gitBookkeeping: async () => {
          throw new Error('injected lifecycle Git failure');
        },
      }),
    });

    expect(result).toMatchObject({
      status: 'git-pending',
      publication: 'git-pending',
      operation: 'create',
    });
    expect(existsSync(paths.envYaml('writing'))).toBe(true);
    const retained = (await readState(paths)).commands[0]!;
    expect(retained).toMatchObject({
      kind: 'environment-create',
      phase: 'git-pending',
      commitPoint: true,
    });
    expect(retained.operations).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'environment', state: 'applied' })]),
    );
  });

  it('keeps the CLI fail-soft success and recovery notice for required Git failure', async () => {
    const home = tempHome({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' });
    const paths = resolvePaths(home.env);
    await run(['init'], { env: home.env });

    const result = await run(['create', 'writing'], {
      env: home.env,
      gitRun: failingCommits(),
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("Created environment 'writing'.\n");
    expect(result.stderr).toMatch(
      /agentenv: required commit is pending .* local change and recovery data are retained/,
    );
    expect(existsSync(paths.envYaml('writing'))).toBe(true);
    expect((await readState(paths)).commands).toHaveLength(1);
  });

  it('creates exactly one path-scoped Git commit for each lifecycle operation', async () => {
    const home = tempHome({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' });
    const paths = resolvePaths(home.env);
    await run(['init'], { env: home.env });

    await run(['create', 'writing'], { env: home.env });
    await run(['create', 'blogging', '--from', 'writing'], { env: home.env });

    const subjects = execFileSync('git', ['log', '-2', '--format=%s'], {
      cwd: paths.store,
      env: home.env,
      encoding: 'utf8',
    }).trim().split('\n');
    expect(subjects).toEqual([
      'agentenv: create env blogging (from writing)',
      'agentenv: create env writing',
    ]);
    const clonePaths = execFileSync('git', ['show', '--format=', '--name-only', 'HEAD'], {
      cwd: paths.store,
      env: home.env,
      encoding: 'utf8',
    });
    expect(clonePaths).toContain('environments/blogging/env.yaml');
    expect(clonePaths).not.toContain('environments/writing/env.yaml');
  });
});
