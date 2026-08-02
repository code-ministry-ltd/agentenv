import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { adoptSweep, snapshotInventory } from '../src/adopt.js';
import { claudeAdapter } from '../src/adapters/claude.js';
import { codexAdapter } from '../src/adapters/codex.js';
import { run } from '../src/cli.js';
import { resolvePaths } from '../src/paths.js';
import { composeView } from '../src/session/composer.js';
import { readState } from '../src/state.js';
import {
  FIXTURE_CONFIG_ENV,
  makeFixtureAdapter,
} from './fixtures/fixture-adapter.js';
import { makeTempHome, type TempHome } from './helpers.js';

const homes: TempHome[] = [];

function home(): TempHome {
  const value = makeTempHome();
  homes.push(value);
  return value;
}

afterEach(() => {
  for (const value of homes.splice(0)) value.cleanup();
});

function seedSkill(th: TempHome, envName = 'writing'): void {
  const skill = join(resolvePaths(th.env).envDir(envName), 'skills', 'w-skill');
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '# writing\n');
}

describe('merge baseline — accepted known failures', () => {
  it.fails('Claude sessions use launch arguments and never relocate the config root', () => {
    const launch = (
      claudeAdapter as unknown as {
        sessionLaunch?: (root: string, args: readonly string[]) => {
          args: readonly string[];
          env: NodeJS.ProcessEnv;
        };
      }
    ).sessionLaunch?.('/private/view', ['--model', 'sonnet']);

    expect(claudeAdapter.overrideEnv('/private/view')).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    expect(launch).toEqual({
      args: [
        '--add-dir=/private/view',
        '--mcp-config=/private/view/.mcp.json',
        '--model',
        'sonnet',
      ],
      env: { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1' },
    });
  });

  it.fails('drop --global without environment names clears the active global stack', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const realRoot = join(th.home, 'fixture-real');
    const env = { ...th.env, [FIXTURE_CONFIG_ENV]: realRoot };
    const adapters = [makeFixtureAdapter()];
    seedSkill(th);

    expect((await run(['use', 'writing', '--global'], { env, adapters })).code).toBe(0);
    expect((await readState(paths)).globalStack).toEqual(['writing']);

    expect((await run(['drop', '--global'], { env, adapters })).code).toBe(0);
    expect((await readState(paths)).globalStack).toEqual([]);
  });

  it.fails('a session view generation records its complete launch-time inventory', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const realRoot = join(th.home, 'fixture-real');
    mkdirSync(realRoot, { recursive: true });
    seedSkill(th);

    await composeView({
      paths,
      adapter: makeFixtureAdapter(),
      envs: ['writing'],
      session: 'session-1',
      realConfigRoot: realRoot,
      env: th.env,
    });

    const meta = JSON.parse(
      readFileSync(join(paths.live, 'session-1', 'fixture.meta.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(Object.keys(meta).some((key) => /inventor/i.test(key))).toBe(true);
  });

  it.fails('a deactivated but still-existing environment is not a valid adoption owner', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const envDir = paths.envDir('writing');
    const surfaceDir = join(th.home, 'surface', 'skills');
    mkdirSync(envDir, { recursive: true });
    mkdirSync(surfaceDir, { recursive: true });
    writeFileSync(paths.envYaml('writing'), 'version: "1.0"\ndescription: writing\n');
    await snapshotInventory(paths, [
      { dir: surfaceDir, scope: 'global', storeKind: 'skills', ownerEnv: 'writing' },
    ]);

    const candidate = join(surfaceDir, 'late-skill');
    mkdirSync(candidate, { recursive: true });
    writeFileSync(
      join(candidate, 'SKILL.md'),
      '---\nname: late-skill\ndescription: created after deactivation\n---\n\n# late\n',
    );

    const result = await adoptSweep({ paths });
    expect(result.adopted).toEqual([]);
    expect(result.skipped).toContainEqual(
      expect.objectContaining({ name: 'late-skill', reason: 'no-env' }),
    );
  });

  it.fails('Codex declares a traversal-safe raw mapping for TOML subagents', () => {
    const rawMappings = (
      codexAdapter as unknown as { rawMappings?: readonly Record<string, unknown>[] }
    ).rawMappings;
    expect(rawMappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          storeRelativePath: 'agents',
          sessionRelativePath: 'agents',
          globalRelativePath: 'agents',
        }),
      ]),
    );
  });
});
