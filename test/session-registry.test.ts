import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePaths } from '../src/paths.js';
import {
  SessionRegistryError,
  clearSession,
  findAgentenvFile,
  findBinding,
  readSessionRegistry,
  removeBinding,
  resolveProjectRoot,
  resolveSessionBinding,
  sessionRegistryPath,
  setBinding,
} from '../src/session/registry.js';
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

describe('session registry', () => {
  it('an absent registry reads as empty; setBinding round-trips by (session, projectRoot)', async () => {
    const paths = resolvePaths(home().env);
    expect((await readSessionRegistry(paths)).bindings).toEqual([]);

    await setBinding(paths, { session: 's1', projectRoot: '/repo', envs: ['writing'] });
    const reg = await readSessionRegistry(paths);
    expect(findBinding(reg, 's1', '/repo')?.envs).toEqual(['writing']);
    expect(findBinding(reg, 's1', '/other')).toBeUndefined();
    expect(findBinding(reg, 's2', '/repo')).toBeUndefined();
  });

  it('setBinding upserts (same session+root replaces; different root coexists)', async () => {
    const paths = resolvePaths(home().env);
    await setBinding(paths, { session: 's1', projectRoot: '/repo', envs: ['a'] });
    await setBinding(paths, { session: 's1', projectRoot: '/repo', envs: ['a', 'b'] });
    await setBinding(paths, { session: 's1', projectRoot: '/repo2', envs: ['c'] });
    const reg = await readSessionRegistry(paths);
    expect(reg.bindings).toHaveLength(2);
    expect(findBinding(reg, 's1', '/repo')?.envs).toEqual(['a', 'b']);
    expect(findBinding(reg, 's1', '/repo2')?.envs).toEqual(['c']);
  });

  it('removeBinding and clearSession remove exactly what they name', async () => {
    const paths = resolvePaths(home().env);
    await setBinding(paths, { session: 's1', projectRoot: '/r1', envs: ['a'] });
    await setBinding(paths, { session: 's1', projectRoot: '/r2', envs: ['b'] });
    await setBinding(paths, { session: 's2', projectRoot: '/r1', envs: ['c'] });

    expect(await removeBinding(paths, 's1', '/r1')).toBe(true);
    expect(await removeBinding(paths, 's1', '/r1')).toBe(false);
    expect(await clearSession(paths, 's1')).toBe(1); // only /r2 remained for s1
    const reg = await readSessionRegistry(paths);
    expect(reg.bindings).toHaveLength(1);
    expect(reg.bindings[0]?.session).toBe('s2');
  });

  it('a corrupt registry throws a typed error naming the file', async () => {
    const paths = resolvePaths(home().env);
    mkdirSync(paths.base, { recursive: true });
    writeFileSync(sessionRegistryPath(paths), '{ this is not json');
    await expect(readSessionRegistry(paths)).rejects.toBeInstanceOf(SessionRegistryError);
  });

  it('resolveSessionBinding returns explicit for a bound session, none for unbound', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    await setBinding(paths, { session: 's1', projectRoot: '/repo', envs: ['writing'] });

    const bound = await resolveSessionBinding({
      paths,
      session: 's1',
      projectRoot: '/repo',
      env: th.env,
    });
    expect(bound.source).toBe('explicit');
    expect(bound.binding?.envs).toEqual(['writing']);

    const unbound = await resolveSessionBinding({
      paths,
      session: 's1',
      projectRoot: '/elsewhere',
      env: th.env,
    });
    expect(unbound.source).toBe('none');

    const noSession = await resolveSessionBinding({
      paths,
      session: undefined,
      projectRoot: '/repo',
      env: th.env,
    });
    expect(noSession.source).toBe('none');
  });

  it('resolveProjectRoot returns the containing worktree root, else the cwd', async () => {
    const th = home();
    const repo = join(th.home, 'proj');
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
    mkdirSync(join(repo, '.git'));
    expect(await resolveProjectRoot(join(repo, 'src', 'deep'))).toBe(repo);

    const loose = join(th.home, 'loose');
    mkdirSync(loose, { recursive: true });
    expect(await resolveProjectRoot(loose)).toBe(loose);
  });

  it('findAgentenvfile is a hook point: discovers the file but pickup stays deferred', async () => {
    const th = home();
    const repo = join(th.home, 'proj');
    mkdirSync(join(repo, 'sub'), { recursive: true });
    mkdirSync(join(repo, '.git'));
    const file = join(repo, '.agentenv');
    writeFileSync(file, 'writing\n');

    expect(await findAgentenvFile(join(repo, 'sub'), th.env)).toBe(file);

    // Discovered, but not applied without approval (Task 3.2) → source stays 'none'.
    const resolved = await resolveSessionBinding({
      paths: resolvePaths(th.env),
      session: 'unbound',
      projectRoot: repo,
      env: th.env,
    });
    expect(resolved.source).toBe('none');
    expect(resolved.note).toContain('approval');
  });
});
