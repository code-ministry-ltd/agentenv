import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { publishStagedBundle } from '../src/filesystem-bundle.js';
import { resolvePaths } from '../src/paths.js';
import { readState } from '../src/state.js';
import { makeTempHome, type TempHome } from './helpers.js';

const homes: TempHome[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) home.cleanup();
});

describe('whole-command staged filesystem publication', () => {
  it('rolls content and metadata back together when the second effect fails', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const targetSkill = join(paths.store, 'environments', 'work', 'skills', 'one');
    const targetYaml = join(paths.store, 'environments', 'work', 'env.yaml');
    mkdirSync(targetSkill, { recursive: true });
    writeFileSync(join(targetSkill, 'SKILL.md'), 'old skill\n');
    writeFileSync(targetYaml, 'old metadata\n');

    const stagingRoot = join(paths.live, 'commands', 'test-bundle');
    const stagedSkill = join(stagingRoot, 'skill');
    const stagedYaml = join(stagingRoot, 'env.yaml');
    mkdirSync(stagedSkill, { recursive: true });
    writeFileSync(join(stagedSkill, 'SKILL.md'), 'new skill\n');
    writeFileSync(stagedYaml, 'new metadata\n');

    await expect(
      publishStagedBundle({
        paths,
        transactionId: 'test-bundle',
        stagingRoot,
        entries: [
          { id: 'skill', target: targetSkill, staged: stagedSkill },
          { id: 'metadata', target: targetYaml, staged: stagedYaml },
        ],
        afterApply: async (entry) => {
          if (entry.id === 'metadata') throw new Error('injected metadata publication failure');
        },
      }),
    ).rejects.toThrow(/injected metadata publication failure/);

    expect(readFileSync(join(targetSkill, 'SKILL.md'), 'utf8')).toBe('old skill\n');
    expect(readFileSync(targetYaml, 'utf8')).toBe('old metadata\n');
    expect((await readState(paths)).commands).toEqual([]);
  });
});
