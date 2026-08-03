import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexAdapter } from '../src/adapters/codex.js';
import { run } from '../src/cli.js';
import { describeGlobal } from '../src/engine.js';
import { resolvePaths } from '../src/paths.js';
import { composeView } from '../src/session/composer.js';
import { makeTempHome, type TempHome } from './helpers.js';

const homes: TempHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.cleanup();
});

function scenario() {
  const th = makeTempHome();
  homes.push(th);
  const paths = resolvePaths(th.env);
  const userHome = join(th.home, 'user-home');
  const realRoot = join(userHome, '.codex');
  const canonical = join(paths.envDir('work'), 'files', 'codex', 'agents', 'reviewer.toml');
  mkdirSync(join(realRoot, 'agents'), { recursive: true });
  writeFileSync(join(realRoot, 'agents', 'user.toml'), 'name = "user"\n');
  mkdirSync(join(canonical, '..'), { recursive: true });
  writeFileSync(canonical, 'name = "reviewer"\n');
  const env = { ...th.env, HOME: userHome, CODEX_HOME: realRoot };
  return { th, paths, userHome, realRoot, canonical, env };
}

describe('generic raw mappings', () => {
  it('maps Codex TOML subagents into a session and writes edits through', async () => {
    const { paths, realRoot, canonical, env } = scenario();
    const nestedCanonical = join(canonical, '..', 'teams', 'backend.toml');
    mkdirSync(join(nestedCanonical, '..'), { recursive: true });
    writeFileSync(nestedCanonical, 'name = "backend"\n');
    const result = await composeView({
      paths,
      adapter: codexAdapter,
      envs: ['work'],
      session: 'raw-session',
      realConfigRoot: realRoot,
      env,
    });
    const reviewer = join(result.viewRoot, 'agents', 'reviewer.toml');
    const backend = join(result.viewRoot, 'agents', 'teams', 'backend.toml');
    const user = join(result.viewRoot, 'agents', 'user.toml');

    expect(readlinkSync(reviewer)).toBe(canonical);
    expect(readlinkSync(backend)).toBe(nestedCanonical);
    expect(readlinkSync(user)).toBe(join(realRoot, 'agents', 'user.toml'));
    writeFileSync(reviewer, 'name = "edited"\n');
    expect(readFileSync(canonical, 'utf8')).toBe('name = "edited"\n');
  });

  it('maps and removes Codex TOML subagents globally without replacing user files', async () => {
    const { paths, realRoot, canonical, env } = scenario();
    const opts = { env, adapters: [codexAdapter] };

    expect((await run(['use', 'work', '--global'], opts)).code).toBe(0);
    const reviewer = join(realRoot, 'agents', 'reviewer.toml');
    expect(lstatSync(reviewer).isSymbolicLink()).toBe(false);
    expect(readFileSync(reviewer, 'utf8')).toBe(readFileSync(canonical, 'utf8'));
    expect(readFileSync(join(realRoot, 'agents', 'user.toml'), 'utf8')).toBe('name = "user"\n');
    expect(
      (await describeGlobal({ paths, adapters: [codexAdapter], env })).adapters[0]?.surfaces,
    ).toContainEqual(
      expect.objectContaining({
        surfaceId: 'codex-agents',
        mechanism: 'raw',
        supported: true,
        ownedItems: 1,
      }),
    );

    expect((await run(['drop', '--global'], opts)).code).toBe(0);
    expect(() => lstatSync(reviewer)).toThrow();
    expect(readFileSync(join(realRoot, 'agents', 'user.toml'), 'utf8')).toBe('name = "user"\n');
    expect((await import('../src/state.js')).readState(paths).then((state) => state.items)).resolves.toEqual([]);
  });

  it('lets an unowned same-path user file win in session and global modes', async () => {
    const { realRoot, canonical, env, paths } = scenario();
    const userReviewer = join(realRoot, 'agents', 'reviewer.toml');
    writeFileSync(userReviewer, 'name = "user-reviewer"\n');

    const session = await composeView({
      paths,
      adapter: codexAdapter,
      envs: ['work'],
      session: 'collision-session',
      realConfigRoot: realRoot,
      env,
    });
    expect(readlinkSync(join(session.viewRoot, 'agents', 'reviewer.toml'))).toBe(userReviewer);
    expect(session.skipped).toContainEqual(
      expect.objectContaining({ surfaceId: 'codex-agents', reason: 'collision' }),
    );

    const global = await run(['use', 'work', '--global'], { env, adapters: [codexAdapter] });
    expect(global.code).toBe(0);
    expect(lstatSync(userReviewer).isSymbolicLink()).toBe(false);
    expect(readFileSync(userReviewer, 'utf8')).toBe('name = "user-reviewer"\n');
    expect(readFileSync(canonical, 'utf8')).toBe('name = "reviewer"\n');
  });

  it('rejects an escaping canonical symlink before any global surface is changed', async () => {
    const { paths, canonical, env, userHome } = scenario();
    const outside = join(paths.base, 'outside.toml');
    writeFileSync(outside, 'name = "outside"\n');
    unlinkSync(canonical);
    symlinkSync(outside, canonical);

    const skill = join(paths.envDir('work'), 'skills', 'safe-skill');
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '# safe\n');

    await expect(
      run(['use', 'work', '--global'], { env, adapters: [codexAdapter] }),
    ).rejects.toThrow('raw mapping symlink escapes its root');
    expect(existsSync(join(userHome, '.agents', 'skills', 'safe-skill'))).toBe(false);
    expect(readFileSync(outside, 'utf8')).toBe('name = "outside"\n');
  });
});
