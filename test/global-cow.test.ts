import {
  closeSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dematerialiseGlobal, materialiseGlobal } from '../src/engine.js';
import { reconcileRetiredGlobalCows } from '../src/global-cow.js';
import { resolvePaths } from '../src/paths.js';
import { readState } from '../src/state.js';
import { FIXTURE_CONFIG_ENV, makeFixtureAdapter } from './fixtures/fixture-adapter.js';
import { makeTempHome, type TempHome } from './helpers.js';

const homes: TempHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.cleanup();
});

describe('retained global COW integration', () => {
  it('keeps a late write through an open descriptor after global drop', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const realRoot = join(home.home, 'real');
    const envDir = paths.envDir('writing');
    const canonical = join(envDir, 'skills', 'w-skill', 'SKILL.md');
    mkdirSync(join(envDir, 'skills', 'w-skill'), { recursive: true });
    writeFileSync(canonical, '# ORIGINAL\n');
    const env = { ...home.env, [FIXTURE_CONFIG_ENV]: realRoot };
    const adapter = makeFixtureAdapter();

    await materialiseGlobal({ paths, adapters: [adapter], envs: ['writing'], env });
    const liveSkill = join(realRoot, 'skills', 'w-skill');
    expect(lstatSync(liveSkill).isDirectory()).toBe(true);
    expect(lstatSync(liveSkill).isSymbolicLink()).toBe(false);
    const descriptor = openSync(join(liveSkill, 'SKILL.md'), 'r+');

    await dematerialiseGlobal({
      paths,
      adapters: [adapter],
      envs: ['writing'],
      all: true,
      env,
    });

    ftruncateSync(descriptor, 0);
    writeSync(descriptor, '# LATE WRITE\n', 0, 'utf8');
    closeSync(descriptor);

    const projection = (await readState(paths)).globalProjections.find(
      (candidate) => candidate.surfacePath === liveSkill,
    );
    expect(projection).toMatchObject({
      phase: 'retired',
      canonicalPath: join(envDir, 'skills', 'w-skill'),
    });
    expect(readFileSync(join(projection!.retainedPath!, 'SKILL.md'), 'utf8')).toBe(
      '# LATE WRITE\n',
    );
    expect(readFileSync(canonical, 'utf8')).toBe('# ORIGINAL\n');

    const reconciled = await reconcileRetiredGlobalCows(paths, {
      ids: [projection!.id],
      quiescent: true,
    });
    expect(reconciled).toEqual({ reconciled: 1, quarantined: 0 });
    expect(readFileSync(canonical, 'utf8')).toBe('# LATE WRITE\n');
    expect(
      (await readState(paths)).globalProjections.find(
        (candidate) => candidate.id === projection!.id,
      )?.phase,
    ).toBe('reconciled');
    expect(readFileSync(join(projection!.retainedPath!, 'SKILL.md'), 'utf8')).toBe(
      '# LATE WRITE\n',
    );
  });

  it('requires an explicit quiescent assertion before reverse projection', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    await expect(
      reconcileRetiredGlobalCows(paths, { ids: [], quiescent: false }),
    ).rejects.toThrow(/quiescent/i);
  });

  it('quarantines a secret-bearing late write before it reaches the canonical store', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const realRoot = join(home.home, 'real');
    const envDir = paths.envDir('writing');
    const canonical = join(envDir, 'skills', 'w-skill', 'SKILL.md');
    mkdirSync(join(envDir, 'skills', 'w-skill'), { recursive: true });
    writeFileSync(canonical, '# ORIGINAL\n');
    const env = { ...home.env, [FIXTURE_CONFIG_ENV]: realRoot };
    const adapter = makeFixtureAdapter();

    await materialiseGlobal({ paths, adapters: [adapter], envs: ['writing'], env });
    await dematerialiseGlobal({ paths, adapters: [adapter], envs: ['writing'], all: true, env });
    const projection = (await readState(paths)).globalProjections.find(
      (candidate) => candidate.canonicalPath === join(envDir, 'skills', 'w-skill'),
    )!;
    const secret = 'AKIAZ7Q2W9E4R6T1Y8U3';
    writeFileSync(join(projection.retainedPath!, 'SKILL.md'), `api_key: ${secret}\n`);

    expect(
      await reconcileRetiredGlobalCows(paths, { ids: [projection.id], quiescent: true }),
    ).toEqual({ reconciled: 0, quarantined: 1 });
    expect(readFileSync(canonical, 'utf8')).toBe('# ORIGINAL\n');
    const after = (await readState(paths)).globalProjections.find(
      (candidate) => candidate.id === projection.id,
    )!;
    expect(after.phase).toBe('quarantined');
    expect(after.failure).toMatch(/secret/i);
    expect(after.failure).not.toContain(secret);
  });
});
