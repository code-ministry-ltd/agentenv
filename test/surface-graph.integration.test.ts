import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexAdapter } from '../src/adapters/codex.js';
import { opencodeAdapter } from '../src/adapters/opencode.js';
import { materialiseGlobal } from '../src/engine.js';
import { resolvePaths } from '../src/paths.js';
import { readState } from '../src/state.js';
import { makeTempHome, type TempHome } from './helpers.js';

const homes: TempHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.cleanup();
});

describe('production global surface graph', () => {
  it('materialises a shared agents-standard skill once for all consumers', async () => {
    const th = makeTempHome();
    homes.push(th);
    const paths = resolvePaths(th.env);
    const skill = join(paths.envDir('work'), 'skills', 'shared');
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '# shared\n');
    const env = { ...th.env, HOME: th.home, USERPROFILE: th.home };

    const result = await materialiseGlobal({
      paths,
      adapters: [codexAdapter, opencodeAdapter],
      envs: ['work'],
      env,
    });

    expect(result.applied).toBe(1);
    const surfacePath = join(th.home, '.agents', 'skills', 'shared');
    const state = await readState(paths);
    expect(state.items.filter((item) => item.path === surfacePath)).toHaveLength(1);
    expect(
      state.globalProjections.filter((projection) => projection.surfacePath === surfacePath),
    ).toHaveLength(1);
  });
});
