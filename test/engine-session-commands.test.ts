import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { resolvePaths } from '../src/paths.js';
import {
  findBinding,
  readSessionRegistry,
  resolveProjectRoot,
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

/** Seed the store with the given env names so `use` can bind them. */
async function seedEnvs(env: NodeJS.ProcessEnv, ...names: string[]): Promise<void> {
  for (const name of names) {
    const res = await run(['create', name], { env });
    expect(res.code).toBe(0);
  }
}

describe('engine: session use', () => {
  it('binds this shell+project to an env stack (registry written)', async () => {
    const th = home();
    await seedEnvs(th.env, 'writing', 'research');
    const env = { ...th.env, AGENTENV_SESSION: 'S1' };

    const res = await run(['use', 'writing', 'research'], { env, cwd: th.home });
    expect(res.code).toBe(0);

    const paths = resolvePaths(th.env);
    const projectRoot = await resolveProjectRoot(th.home);
    const binding = findBinding(await readSessionRegistry(paths), 'S1', projectRoot);
    expect(binding?.envs).toEqual(['writing', 'research']);
    expect(binding?.global).toBeFalsy();
  });

  it('warns and skips a missing env, binding the survivors', async () => {
    const th = home();
    await seedEnvs(th.env, 'writing');
    const env = { ...th.env, AGENTENV_SESSION: 'S1' };

    const res = await run(['use', 'writing', 'ghost'], { env, cwd: th.home });
    expect(res.code).toBe(0);
    expect(res.stderr).toContain('ghost');

    const paths = resolvePaths(th.env);
    const projectRoot = await resolveProjectRoot(th.home);
    const binding = findBinding(await readSessionRegistry(paths), 'S1', projectRoot);
    expect(binding?.envs).toEqual(['writing']);
  });

  it('records --harness scoping on the binding', async () => {
    const th = home();
    await seedEnvs(th.env, 'writing');
    const env = { ...th.env, AGENTENV_SESSION: 'S1' };

    const res = await run(['use', 'writing', '--harness', 'claude,codex'], { env, cwd: th.home });
    expect(res.code).toBe(0);

    const paths = resolvePaths(th.env);
    const projectRoot = await resolveProjectRoot(th.home);
    const binding = findBinding(await readSessionRegistry(paths), 'S1', projectRoot);
    expect(binding?.harnesses).toEqual(['claude', 'codex']);
  });

  it('errors when every named env is missing', async () => {
    const th = home();
    const env = { ...th.env, AGENTENV_SESSION: 'S1' };
    const res = await run(['use', 'ghost'], { env, cwd: th.home });
    expect(res.code).toBe(1);
  });

  it('errors when the shell has no session id', async () => {
    const th = home();
    await seedEnvs(th.env, 'writing');
    const res = await run(['use', 'writing'], { env: th.env, cwd: th.home });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('shell-init');
  });
});

describe('engine: session drop', () => {
  it('removes the whole binding when no envs are named', async () => {
    const th = home();
    await seedEnvs(th.env, 'writing');
    const env = { ...th.env, AGENTENV_SESSION: 'S1' };
    await run(['use', 'writing'], { env, cwd: th.home });

    const res = await run(['drop'], { env, cwd: th.home });
    expect(res.code).toBe(0);

    const paths = resolvePaths(th.env);
    const projectRoot = await resolveProjectRoot(th.home);
    expect(findBinding(await readSessionRegistry(paths), 'S1', projectRoot)).toBeUndefined();
  });

  it('removes only the named env from the stack, keeping the rest', async () => {
    const th = home();
    await seedEnvs(th.env, 'writing', 'research');
    const env = { ...th.env, AGENTENV_SESSION: 'S1' };
    await run(['use', 'writing', 'research'], { env, cwd: th.home });

    const res = await run(['drop', 'research'], { env, cwd: th.home });
    expect(res.code).toBe(0);

    const paths = resolvePaths(th.env);
    const projectRoot = await resolveProjectRoot(th.home);
    const binding = findBinding(await readSessionRegistry(paths), 'S1', projectRoot);
    expect(binding?.envs).toEqual(['writing']);
  });

  it('drops the binding when the last env is removed', async () => {
    const th = home();
    await seedEnvs(th.env, 'writing');
    const env = { ...th.env, AGENTENV_SESSION: 'S1' };
    await run(['use', 'writing'], { env, cwd: th.home });

    const res = await run(['drop', 'writing'], { env, cwd: th.home });
    expect(res.code).toBe(0);

    const paths = resolvePaths(th.env);
    const projectRoot = await resolveProjectRoot(th.home);
    expect(findBinding(await readSessionRegistry(paths), 'S1', projectRoot)).toBeUndefined();
  });

  it('--all removes the binding', async () => {
    const th = home();
    await seedEnvs(th.env, 'writing', 'research');
    const env = { ...th.env, AGENTENV_SESSION: 'S1' };
    await run(['use', 'writing', 'research'], { env, cwd: th.home });

    const res = await run(['drop', '--all'], { env, cwd: th.home });
    expect(res.code).toBe(0);

    const paths = resolvePaths(th.env);
    const projectRoot = await resolveProjectRoot(th.home);
    expect(findBinding(await readSessionRegistry(paths), 'S1', projectRoot)).toBeUndefined();
  });

  it('is a friendly no-op when nothing is bound', async () => {
    const th = home();
    const env = { ...th.env, AGENTENV_SESSION: 'S1' };
    const res = await run(['drop'], { env, cwd: th.home });
    expect(res.code).toBe(0);
    expect(res.stdout.toLowerCase()).toContain('nothing');
  });
});
