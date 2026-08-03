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
  });
});
