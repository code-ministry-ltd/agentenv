import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  deleteEnvironment,
  inspectEnvironmentDeletion,
} from '../src/application/environment-lifecycle.js';
import {
  createEnvironmentDeleteRuntime,
  type EnvironmentDeleteRuntime,
} from '../src/application/environment-lifecycle-runtime.js';
import { capturePathIdentity } from '../src/path-identity.js';
import { resolvePaths, type Paths } from '../src/paths.js';
import {
  SessionEnvironmentUnavailableError,
  readSessionRegistry,
  setBinding,
  setBindingForExistingEnvironments,
} from '../src/session/registry.js';
import { emptyManifest, readState, writeState } from '../src/state.js';
import { withLock } from '../src/lock.js';
import { makeTempHome, type TempHome } from './helpers.js';

const homes: TempHome[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) home.cleanup();
});

function temp(): { home: TempHome; paths: Paths } {
  const home = makeTempHome();
  homes.push(home);
  return { home, paths: resolvePaths(home.env) };
}

function seed(paths: Paths, name = 'writing', text = 'original bytes\n'): string {
  const root = paths.envDir(name);
  mkdirSync(root, { recursive: true });
  writeFileSync(paths.envYaml(name), 'version: "1.0"\ndescription: test\n');
  writeFileSync(join(root, 'notes.txt'), text);
  return root;
}

function realRuntime(paths: Paths): EnvironmentDeleteRuntime {
  return createEnvironmentDeleteRuntime({
    paths,
    open: async () => ({ status: 'ready' }),
  });
}

describe('environment deletion application operation', () => {
  it('deletes one inactive environment through one recoverable publication', async () => {
    const { paths } = temp();
    seed(paths);

    const result = await deleteEnvironment({
      paths,
      name: 'writing',
      runtime: realRuntime(paths),
    });

    expect(result).toMatchObject({
      status: 'deleted',
      operation: 'delete',
      name: 'writing',
      publication: 'complete',
    });
    expect(await capturePathIdentity(paths.envDir('writing'))).toEqual({ kind: 'absent' });
    expect((await readState(paths)).commands).toEqual([]);
  });

  it.each([
    ['invalid', '../outside', 'invalid'],
    ['missing', 'missing', 'not-found'],
  ] as const)('refuses an %s name before opening publication', async (_label, name, status) => {
    const { paths } = temp();
    seed(paths);
    let opened = false;

    const result = await deleteEnvironment({
      paths,
      name,
      runtime: {
        open: async () => {
          opened = true;
          return { status: 'ready' };
        },
        close: async () => {},
        publish: async () => ({ status: 'complete' }),
      },
    });

    expect(result.status).toBe(status);
    expect(opened).toBe(false);
    expect(readFileSync(join(paths.envDir('writing'), 'notes.txt'), 'utf8')).toBe('original bytes\n');
  });

  it('reports every active-state cause and leaves environment and state byte-identical', async () => {
    const { paths } = temp();
    seed(paths);
    const manifest = emptyManifest();
    (manifest as typeof manifest & { globalStack: string[] }).globalStack = ['writing'];
    manifest.items.push({
      ownerEnv: 'writing',
      surface: 'test',
      action: 'write',
      path: '/not/used',
      target: '/not/used',
    });
    await writeState(paths, manifest);
    const stateBefore = readFileSync(paths.state, 'utf8');
    const targetBefore = await capturePathIdentity(paths.envDir('writing'));

    const result = await deleteEnvironment({
      paths,
      name: 'writing',
      runtime: realRuntime(paths),
    });

    expect(result).toMatchObject({
      status: 'active',
      activity: { session: false, globalStack: true, materialised: true },
    });
    expect(await capturePathIdentity(paths.envDir('writing'))).toEqual(targetBefore);
    expect(readFileSync(paths.state, 'utf8')).toBe(stateBefore);
  });

  it.each([
    { status: 'pending-recovery' as const, transactionId: 'pending-command' },
    { status: 'drift-blocked' as const, secretBearing: true },
  ])('leaves exact bytes untouched when opening reports $status', async (openResult) => {
    const { paths } = temp();
    seed(paths);
    const targetBefore = await capturePathIdentity(paths.envDir('writing'));
    const stateBefore = await readState(paths);
    let published = false;

    const result = await deleteEnvironment({
      paths,
      name: 'writing',
      runtime: {
        open: async () => openResult,
        close: async () => {},
        publish: async () => {
          published = true;
          return { status: 'complete' };
        },
      },
    });

    expect(result).toEqual(openResult);
    expect(published).toBe(false);
    expect(await capturePathIdentity(paths.envDir('writing'))).toEqual(targetBefore);
    expect(await readState(paths)).toEqual(stateBefore);
  });

  it('refuses a stale inspection without overwriting the concurrent replacement', async () => {
    const { paths } = temp();
    seed(paths);
    const inspection = await inspectEnvironmentDeletion({ paths, name: 'writing' });
    expect(inspection.status).toBe('ready');
    if (inspection.status !== 'ready') return;
    rmSync(paths.envDir('writing'), { recursive: true });
    seed(paths, 'writing', 'concurrent replacement\n');

    const result = await deleteEnvironment({
      paths,
      name: 'writing',
      runtime: realRuntime(paths),
      expectedTargetIdentity: inspection.targetIdentity,
      expectedContainerIdentity: inspection.containerIdentity,
    });

    expect(result).toMatchObject({ status: 'stale', field: 'target' });
    expect(readFileSync(join(paths.envDir('writing'), 'notes.txt'), 'utf8'))
      .toBe('concurrent replacement\n');
    expect((await readState(paths)).commands).toEqual([]);
  });

  it('retains a late replacement detected at the publication boundary', async () => {
    const { paths } = temp();
    seed(paths);

    const result = await deleteEnvironment({
      paths,
      name: 'writing',
      runtime: realRuntime(paths),
      faults: {
        afterStage: async () => {
          rmSync(paths.envDir('writing'), { recursive: true });
          seed(paths, 'writing', 'late replacement\n');
        },
      },
    });

    expect(result).toMatchObject({ status: 'stale', field: 'target' });
    expect(readFileSync(join(paths.envDir('writing'), 'notes.txt'), 'utf8'))
      .toBe('late replacement\n');
    expect((await readState(paths)).commands).toEqual([]);
  });

  it.each(['session', 'global-stack', 'materialised'] as const)(
    'retains an environment that becomes active through %s after its WAL is durable',
    async (kind) => {
      const { paths } = temp();
      seed(paths);
      let activated = false;

      const result = await deleteEnvironment({
        paths,
        name: 'writing',
        runtime: realRuntime(paths),
        faults: {
          afterPersist: async (plan) => {
            if (activated || plan.phase !== 'planned') return;
            activated = true;
            if (kind === 'session') {
              await setBinding(paths, {
                session: 'concurrent-shell',
                projectRoot: '/concurrent/project',
                envs: ['writing'],
              });
              return;
            }
            await withLock(paths, async () => {
              const manifest = await readState(paths);
              if (kind === 'global-stack') {
                (manifest as typeof manifest & { globalStack: string[] }).globalStack = ['writing'];
              } else {
                manifest.items.push({
                  ownerEnv: 'writing',
                  surface: 'test',
                  action: 'write',
                  path: '/concurrent/item',
                });
              }
              await writeState(paths, manifest);
            });
          },
        },
      });

      expect(result).toMatchObject({
        status: 'active',
        activity: {
          session: kind === 'session',
          globalStack: kind === 'global-stack',
          materialised: kind === 'materialised',
        },
      });
      expect(readFileSync(join(paths.envDir('writing'), 'notes.txt'), 'utf8'))
        .toBe('original bytes\n');
      expect((await readState(paths)).commands).toEqual([]);
    },
  );

  it('prevents a waiting session activation from binding after deletion', async () => {
    const { paths } = temp();
    seed(paths);
    let announceApplied: (() => void) | undefined;
    let releaseApplied: (() => void) | undefined;
    const applied = new Promise<void>((resolve) => { announceApplied = resolve; });
    const release = new Promise<void>((resolve) => { releaseApplied = resolve; });

    const deletion = deleteEnvironment({
      paths,
      name: 'writing',
      runtime: realRuntime(paths),
      faults: {
        afterApply: async () => {
          announceApplied!();
          await release;
        },
      },
    });
    await applied;
    let bindingSettled = false;
    const binding = setBindingForExistingEnvironments(paths, {
      session: 'waiting-shell',
      projectRoot: '/waiting/project',
      envs: ['writing'],
    }).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    ).finally(() => { bindingSettled = true; });
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(bindingSettled).toBe(false);

    releaseApplied!();
    await expect(deletion).resolves.toMatchObject({ status: 'deleted' });
    const bindingResult = await binding;
    expect(bindingResult.ok).toBe(false);
    if (!bindingResult.ok) {
      expect(bindingResult.error).toBeInstanceOf(SessionEnvironmentUnavailableError);
    }
    expect((await readSessionRegistry(paths)).bindings).toEqual([]);
    expect(await capturePathIdentity(paths.envDir('writing'))).toEqual({ kind: 'absent' });
  });

  it('cleans unpersisted staging and preserves exact bytes after an injected failure', async () => {
    const { paths } = temp();
    seed(paths);
    const before = await capturePathIdentity(paths.envDir('writing'));

    const result = await deleteEnvironment({
      paths,
      name: 'writing',
      runtime: realRuntime(paths),
      faults: { afterStage: async () => { throw new Error('injected delete failure'); } },
    });

    expect(result).toEqual({ status: 'failure', message: 'injected delete failure' });
    expect(await capturePathIdentity(paths.envDir('writing'))).toEqual(before);
    expect(readFileSync(join(paths.envDir('writing'), 'notes.txt'), 'utf8')).toBe('original bytes\n');
    expect((await readState(paths)).commands).toEqual([]);
  });

  it('never follows a deletion target or environments ancestor outside the store', async () => {
    const { home, paths } = temp();
    const outside = join(home.home, 'outside-environment');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'notes.txt'), 'protected outside bytes\n');
    mkdirSync(paths.environments, { recursive: true });
    symlinkSync(outside, paths.envDir('writing'));

    const result = await deleteEnvironment({
      paths,
      name: 'writing',
      runtime: realRuntime(paths),
    });

    expect(result.status).toBe('failure');
    expect(readFileSync(join(outside, 'notes.txt'), 'utf8')).toBe('protected outside bytes\n');
    expect(existsSync(paths.envDir('writing'))).toBe(true);
  });
});
