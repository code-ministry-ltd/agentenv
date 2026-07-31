import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Adapter } from '../src/adapter.js';
import { resolvePaths } from '../src/paths.js';
import { composeView } from '../src/session/composer.js';
import type { ExecHarness, ExecSpec } from '../src/session/exec.js';
import { launchHarness } from '../src/session/launch.js';
import {
  FIXTURE_CONFIG_ENV,
  installFixtureHarness,
  makeFixtureAdapter,
} from './fixtures/fixture-adapter.js';
import { makeTempHome, type TempHome } from './helpers.js';

const homes: TempHome[] = [];
function home(): TempHome {
  const h = makeTempHome();
  homes.push(h);
  return h;
}
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
});

/**
 * An adapter that needs the PROJECT PATH to compose (Codex trust): it emits a
 * `[projects."<projectRoot>"] trust_level = "trusted"` keyed injection derived
 * from the compile context's projectRoot. Unrepresentable until H3 threaded the
 * launch cwd through composeView → ComposeRequest → compileConfigKeys.
 */
function trustAdapter(): Adapter {
  const base = makeFixtureAdapter();
  return {
    ...base,
    async compileConfigKeys(surface, ctx) {
      if (surface.id !== 'mcp') return [];
      const projectRoot = ctx.projectRoot;
      if (!projectRoot) return [];
      return [
        { style: 'keyed', keyPath: ['projects', projectRoot, 'trust_level'], value: 'trusted' },
      ];
    },
  };
}

function seedSkill(envDir: string): void {
  mkdirSync(join(envDir, 'skills', 'w-skill'), { recursive: true });
  writeFileSync(join(envDir, 'skills', 'w-skill', 'SKILL.md'), '# w\n');
}

function capturingExec(): { exec: ExecHarness; calls: ExecSpec[] } {
  const calls: ExecSpec[] = [];
  const exec: ExecHarness = async (spec) => {
    calls.push(spec);
    const r = spawnSync(spec.binaryPath, [...spec.args], { env: spec.env, encoding: 'utf8' });
    return r.status ?? 0;
  };
  return { exec, calls };
}

describe('session projectRoot threading (H3)', () => {
  it('composeView threads projectRoot into compileConfigKeys so an adapter can emit a project-path-keyed injection', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    seedSkill(paths.envDir('writing'));
    const projectRoot = join(th.home, 'my', 'project');

    const res = await composeView({
      paths,
      adapter: trustAdapter(),
      envs: ['writing'],
      session: 'sess-1',
      realConfigRoot: join(th.home, 'no-real-root'),
      projectRoot,
      onWarn: () => {},
    });

    const cfg = JSON.parse(readFileSync(join(res.viewRoot, 'config.json'), 'utf8'));
    expect(cfg.projects[projectRoot].trust_level).toBe('trusted');
  });

  it('launchHarness passes the launch cwd through as projectRoot', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const binDir = join(th.home, 'bin');
    installFixtureHarness(binDir);
    seedSkill(paths.envDir('writing'));
    const env: NodeJS.ProcessEnv = { ...th.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}` };
    const projectRoot = join(th.home, 'work', 'repo');
    const { exec, calls } = capturingExec();

    const result = await launchHarness({
      paths,
      adapter: trustAdapter(),
      envs: ['writing'],
      session: 'sess-1',
      args: ['--print-config-root'],
      env,
      cwd: projectRoot,
      execHarness: exec,
    });

    expect(result.mode).toBe('applied');
    const viewRoot = calls[0]?.env[FIXTURE_CONFIG_ENV];
    expect(viewRoot).toBeTruthy();
    const cfg = JSON.parse(readFileSync(join(viewRoot!, 'config.json'), 'utf8'));
    expect(cfg.projects[projectRoot].trust_level).toBe('trusted');
  });
});
