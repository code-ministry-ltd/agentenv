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
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { dematerialiseGlobal, materialiseGlobal } from '../src/engine.js';
import {
  globalCowRetainedPath,
  reconcileRetiredGlobalCows,
  retireActiveGlobalCowSurface,
} from '../src/global-cow.js';
import { resolvePaths } from '../src/paths.js';
import { readState } from '../src/state.js';
import { FIXTURE_CONFIG_ENV, makeFixtureAdapter } from './fixtures/fixture-adapter.js';
import { makeTempHome, type TempHome } from './helpers.js';

const homes: TempHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.cleanup();
});

describe('retained global COW integration', () => {
  it('resumes an interrupted live-to-retained handoff without deleting its only bytes', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const realRoot = join(home.home, 'real');
    const canonical = join(paths.envDir('writing'), 'skills', 'w-skill', 'SKILL.md');
    mkdirSync(join(canonical, '..'), { recursive: true });
    writeFileSync(canonical, '# ORIGINAL\n');
    const env = { ...home.env, [FIXTURE_CONFIG_ENV]: realRoot };
    await materialiseGlobal({
      paths,
      adapters: [makeFixtureAdapter()],
      envs: ['writing'],
      env,
    });
    const live = join(realRoot, 'skills', 'w-skill');
    const projection = (await readState(paths)).globalProjections.find(
      (candidate) => candidate.surfacePath === live,
    )!;

    await expect(
      retireActiveGlobalCowSurface(paths, live, Date.now(), async (boundary) => {
        if (boundary === 'retained') throw new Error('injected kill after retain');
      }),
    ).rejects.toThrow(/injected kill/);
    expect((await readState(paths)).globalProjections.find((item) => item.id === projection.id)?.phase)
      .toBe('retiring');
    expect(lstatSync(globalCowRetainedPath(paths, projection.id)).isDirectory()).toBe(true);
    expect(() => lstatSync(live)).toThrow();

    const retired = await retireActiveGlobalCowSurface(paths, live, Date.now());
    expect(retired?.phase).toBe('retired');
    expect(readFileSync(join(live, 'SKILL.md'), 'utf8')).toBe('# ORIGINAL\n');
    expect(readFileSync(join(globalCowRetainedPath(paths, projection.id), 'SKILL.md'), 'utf8'))
      .toBe('# ORIGINAL\n');
  });

  it('quarantines rather than deleting a pre-existing retained handoff target', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const realRoot = join(home.home, 'real');
    const canonical = join(paths.envDir('writing'), 'skills', 'w-skill', 'SKILL.md');
    mkdirSync(join(canonical, '..'), { recursive: true });
    writeFileSync(canonical, '# ORIGINAL\n');
    const env = { ...home.env, [FIXTURE_CONFIG_ENV]: realRoot };
    await materialiseGlobal({
      paths,
      adapters: [makeFixtureAdapter()],
      envs: ['writing'],
      env,
    });
    const live = join(realRoot, 'skills', 'w-skill');
    const projection = (await readState(paths)).globalProjections.find(
      (candidate) => candidate.surfacePath === live,
    )!;
    const retained = globalCowRetainedPath(paths, projection.id);
    mkdirSync(retained, { recursive: true });
    writeFileSync(join(retained, 'SKILL.md'), '# THIRD IDENTITY\n');

    await expect(retireActiveGlobalCowSurface(paths, live, Date.now())).rejects.toThrow(
      /already exists/,
    );
    expect(readFileSync(join(live, 'SKILL.md'), 'utf8')).toBe('# ORIGINAL\n');
    expect(readFileSync(join(retained, 'SKILL.md'), 'utf8')).toBe('# THIRD IDENTITY\n');
    expect((await readState(paths)).globalProjections.find((item) => item.id === projection.id)?.phase)
      .toBe('quarantined');
  });

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

  it('rolls a faulted drop handoff back without invalidating an open writer descriptor', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const realRoot = join(home.home, 'real');
    const canonical = join(paths.envDir('writing'), 'skills', 'w-skill', 'SKILL.md');
    mkdirSync(join(canonical, '..'), { recursive: true });
    writeFileSync(canonical, '# ORIGINAL\n');
    const env = { ...home.env, [FIXTURE_CONFIG_ENV]: realRoot };
    const adapter = makeFixtureAdapter();

    await materialiseGlobal({ paths, adapters: [adapter], envs: ['writing'], env });
    const liveSkill = join(realRoot, 'skills', 'w-skill');
    const descriptor = openSync(join(liveSkill, 'SKILL.md'), 'r+');

    await expect(
      dematerialiseGlobal({
        paths,
        adapters: [adapter],
        envs: ['writing'],
        all: true,
        env,
        commandHooks: {
          afterPublish: async (path) => {
            if (path === liveSkill) throw new Error('fault after inode handoff');
          },
        },
      }),
    ).rejects.toThrow(/fault after inode handoff/);

    ftruncateSync(descriptor, 0);
    writeSync(descriptor, '# STILL LIVE\n', 0, 'utf8');
    closeSync(descriptor);

    expect(readFileSync(join(liveSkill, 'SKILL.md'), 'utf8')).toBe('# STILL LIVE\n');
    const manifest = await readState(paths);
    expect(manifest.commands).toEqual([]);
    expect(manifest.globalProjections.find((projection) => projection.surfacePath === liveSkill)?.phase)
      .toBe('active');
  });

  it('rolls an identity projection back when canonical publication faults', async () => {
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
    writeFileSync(join(projection.retainedPath!, 'SKILL.md'), '# EDITED\n');

    expect(
      await reconcileRetiredGlobalCows(paths, {
        ids: [projection.id],
        quiescent: true,
        afterCanonicalApply: async () => {
          throw new Error('injected identity publication failure');
        },
      }),
    ).toEqual({ reconciled: 0, quarantined: 1 });
    expect(readFileSync(canonical, 'utf8')).toBe('# ORIGINAL\n');
    expect(readFileSync(join(projection.retainedPath!, 'SKILL.md'), 'utf8')).toBe('# EDITED\n');
    expect((await readState(paths)).commands).toEqual([]);
  });

  it('retains late whole-file writes to a global instruction projection', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const realRoot = join(home.home, 'real');
    const instructionFile = join(realRoot, 'INSTRUCTIONS.md');
    const canonical = join(paths.envDir('writing'), 'instructions', 'base.md');
    mkdirSync(join(paths.envDir('writing'), 'instructions'), { recursive: true });
    mkdirSync(realRoot, { recursive: true });
    writeFileSync(instructionFile, '# USER INSTRUCTIONS\n');
    writeFileSync(canonical, '# MANAGED BASELINE\n');
    const env = { ...home.env, [FIXTURE_CONFIG_ENV]: realRoot };
    const adapter = makeFixtureAdapter();

    await materialiseGlobal({ paths, adapters: [adapter], envs: ['writing'], env });
    const descriptor = openSync(instructionFile, 'r+');

    await dematerialiseGlobal({
      paths,
      adapters: [adapter],
      envs: ['writing'],
      all: true,
      env,
    });

    ftruncateSync(descriptor, 0);
    writeSync(descriptor, '# LATE WHOLE-FILE WRITE\n', 0, 'utf8');
    closeSync(descriptor);

    const projection = (await readState(paths)).globalProjections.find(
      (candidate) => candidate.surfacePath === instructionFile,
    );
    expect(projection).toMatchObject({ phase: 'retired', transform: 'file-block' });
    expect(readFileSync(projection!.retainedPath!, 'utf8')).toBe('# LATE WHOLE-FILE WRITE\n');
    expect(readFileSync(instructionFile, 'utf8')).toBe('# USER INSTRUCTIONS\n');
    expect(readFileSync(canonical, 'utf8')).toBe('# MANAGED BASELINE\n');

    expect(
      await reconcileRetiredGlobalCows(paths, { ids: [projection!.id], quiescent: true }),
    ).toEqual({ reconciled: 0, quarantined: 1 });
    expect(readFileSync(canonical, 'utf8')).toBe('# MANAGED BASELINE\n');
    expect(readFileSync(projection!.retainedPath!, 'utf8')).toBe('# LATE WHOLE-FILE WRITE\n');
  });

  it('retains late whole-file writes to a global config-key projection', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const realRoot = join(home.home, 'real');
    const configFile = join(realRoot, 'config.json');
    const canonical = join(paths.envDir('writing'), 'mcp', 'servers.yaml');
    mkdirSync(join(paths.envDir('writing'), 'mcp'), { recursive: true });
    mkdirSync(realRoot, { recursive: true });
    writeFileSync(configFile, '{"mcpServers":{"user":{"url":"https://user"}}}\n');
    writeFileSync(canonical, 'managed:\n  url: https://managed\n');
    const env = { ...home.env, [FIXTURE_CONFIG_ENV]: realRoot };
    const adapter = makeFixtureAdapter();

    await materialiseGlobal({ paths, adapters: [adapter], envs: ['writing'], env });
    const descriptor = openSync(configFile, 'r+');

    await dematerialiseGlobal({
      paths,
      adapters: [adapter],
      envs: ['writing'],
      all: true,
      env,
    });

    ftruncateSync(descriptor, 0);
    writeSync(descriptor, '{"late":true}\n', 0, 'utf8');
    closeSync(descriptor);

    const projection = (await readState(paths)).globalProjections.find(
      (candidate) => candidate.surfacePath === configFile,
    );
    expect(projection).toMatchObject({ phase: 'retired', transform: 'config-keys' });
    expect(readFileSync(projection!.retainedPath!, 'utf8')).toBe('{"late":true}\n');
    expect(JSON.parse(readFileSync(configFile, 'utf8'))).toEqual({
      mcpServers: { user: { url: 'https://user' } },
    });
    expect(readFileSync(canonical, 'utf8')).toBe('managed:\n  url: https://managed\n');

    expect(
      await reconcileRetiredGlobalCows(paths, { ids: [projection!.id], quiescent: true }),
    ).toEqual({ reconciled: 0, quarantined: 1 });
    expect(readFileSync(canonical, 'utf8')).toBe('managed:\n  url: https://managed\n');
    expect(readFileSync(projection!.retainedPath!, 'utf8')).toBe('{"late":true}\n');
  });

  it('reverse-projects only an attributable late config-key edit', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const realRoot = join(home.home, 'real');
    const configFile = join(realRoot, 'config.json');
    const canonical = join(paths.envDir('writing'), 'mcp', 'servers.yaml');
    mkdirSync(join(paths.envDir('writing'), 'mcp'), { recursive: true });
    mkdirSync(realRoot, { recursive: true });
    writeFileSync(configFile, '{"mcpServers":{"user":{"url":"https://user"}}}\n');
    writeFileSync(canonical, 'managed:\n  url: https://managed\n  future: keep-me\n');
    const env = { ...home.env, [FIXTURE_CONFIG_ENV]: realRoot };
    const adapter = makeFixtureAdapter();

    await materialiseGlobal({ paths, adapters: [adapter], envs: ['writing'], env });
    const rendered = JSON.parse(readFileSync(configFile, 'utf8'));
    rendered.mcpServers.managed.url = 'https://late-edit';
    const edited = `${JSON.stringify(rendered, null, 2)}\n`;
    const descriptor = openSync(configFile, 'r+');
    await dematerialiseGlobal({ paths, adapters: [adapter], envs: ['writing'], all: true, env });
    ftruncateSync(descriptor, 0);
    writeSync(descriptor, edited, 0, 'utf8');
    closeSync(descriptor);

    const projection = (await readState(paths)).globalProjections.find(
      (candidate) => candidate.surfacePath === configFile,
    )!;
    expect(
      await reconcileRetiredGlobalCows(paths, {
        ids: [projection.id],
        quiescent: true,
        adapters: [adapter],
      }),
    ).toEqual({ reconciled: 1, quarantined: 0 });
    expect(parseYaml(readFileSync(canonical, 'utf8'))).toEqual({
      managed: { url: 'https://late-edit', future: 'keep-me' },
    });
    expect(JSON.parse(readFileSync(configFile, 'utf8'))).toEqual({
      mcpServers: { user: { url: 'https://user' } },
    });
    expect(readFileSync(projection.retainedPath!, 'utf8')).toBe(edited);
  });

  it('restores secret placeholders before reverse-projecting a config-key edit', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const realRoot = join(home.home, 'real');
    const configFile = join(realRoot, 'config.json');
    const canonical = join(paths.envDir('writing'), 'mcp', 'servers.yaml');
    mkdirSync(join(paths.envDir('writing'), 'mcp'), { recursive: true });
    mkdirSync(realRoot, { recursive: true });
    writeFileSync(configFile, '{}\n');
    writeFileSync(canonical, 'managed:\n  url: https://managed\n  token: ${TOKEN}\n');
    const secret = 'AKIAZ7Q2W9E4R6T1Y8U3';
    const env = { ...home.env, [FIXTURE_CONFIG_ENV]: realRoot, TOKEN: secret };
    const adapter = makeFixtureAdapter({ substituteMcp: true });

    await materialiseGlobal({ paths, adapters: [adapter], envs: ['writing'], env });
    const rendered = JSON.parse(readFileSync(configFile, 'utf8'));
    expect(rendered.mcpServers.managed.token).toBe(secret);
    rendered.mcpServers.managed.url = 'https://late-edit';
    const edited = `${JSON.stringify(rendered)}\n`;
    const descriptor = openSync(configFile, 'r+');
    await dematerialiseGlobal({ paths, adapters: [adapter], envs: ['writing'], all: true, env });
    ftruncateSync(descriptor, 0);
    writeSync(descriptor, edited, 0, 'utf8');
    closeSync(descriptor);

    const projection = (await readState(paths)).globalProjections.find(
      (candidate) => candidate.surfacePath === configFile,
    )!;
    expect(
      await reconcileRetiredGlobalCows(paths, {
        ids: [projection.id],
        quiescent: true,
        adapters: [adapter],
      }),
    ).toEqual({ reconciled: 1, quarantined: 0 });
    const persisted = readFileSync(canonical, 'utf8');
    expect(persisted).toContain('${TOKEN}');
    expect(persisted).not.toContain(secret);
  });

  it('quarantines a config-key edit when canonical YAML changed concurrently', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const realRoot = join(home.home, 'real');
    const configFile = join(realRoot, 'config.json');
    const canonical = join(paths.envDir('writing'), 'mcp', 'servers.yaml');
    mkdirSync(join(paths.envDir('writing'), 'mcp'), { recursive: true });
    mkdirSync(realRoot, { recursive: true });
    writeFileSync(configFile, '{}\n');
    writeFileSync(canonical, 'managed:\n  url: https://baseline\n');
    const env = { ...home.env, [FIXTURE_CONFIG_ENV]: realRoot };
    const adapter = makeFixtureAdapter();

    await materialiseGlobal({ paths, adapters: [adapter], envs: ['writing'], env });
    const rendered = JSON.parse(readFileSync(configFile, 'utf8'));
    rendered.mcpServers.managed.url = 'https://late-edit';
    const edited = `${JSON.stringify(rendered)}\n`;
    const descriptor = openSync(configFile, 'r+');
    await dematerialiseGlobal({ paths, adapters: [adapter], envs: ['writing'], all: true, env });
    ftruncateSync(descriptor, 0);
    writeSync(descriptor, edited, 0, 'utf8');
    closeSync(descriptor);
    writeFileSync(canonical, 'managed:\n  url: https://concurrent\n');

    const projection = (await readState(paths)).globalProjections.find(
      (candidate) => candidate.surfacePath === configFile,
    )!;
    expect(
      await reconcileRetiredGlobalCows(paths, {
        ids: [projection.id],
        quiescent: true,
        adapters: [adapter],
      }),
    ).toEqual({ reconciled: 0, quarantined: 1 });
    expect(parseYaml(readFileSync(canonical, 'utf8'))).toEqual({
      managed: { url: 'https://concurrent' },
    });
    expect(readFileSync(projection.retainedPath!, 'utf8')).toBe(edited);
  });

  it('reverse-projects only an attributable late instruction sub-block edit', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const realRoot = join(home.home, 'real');
    const instructionFile = join(realRoot, 'INSTRUCTIONS.md');
    const canonical = join(paths.envDir('writing'), 'instructions', 'base.md');
    mkdirSync(join(paths.envDir('writing'), 'instructions'), { recursive: true });
    mkdirSync(realRoot, { recursive: true });
    writeFileSync(instructionFile, '# USER INSTRUCTIONS\n');
    writeFileSync(canonical, '# MANAGED BASELINE\n');
    const env = { ...home.env, [FIXTURE_CONFIG_ENV]: realRoot };
    const adapter = makeFixtureAdapter();

    await materialiseGlobal({ paths, adapters: [adapter], envs: ['writing'], env });
    const rendered = readFileSync(instructionFile, 'utf8');
    const edited = rendered.replace('# MANAGED BASELINE', '# ATTRIBUTABLE EDIT');
    const descriptor = openSync(instructionFile, 'r+');

    await dematerialiseGlobal({ paths, adapters: [adapter], envs: ['writing'], all: true, env });
    ftruncateSync(descriptor, 0);
    writeSync(descriptor, edited, 0, 'utf8');
    closeSync(descriptor);

    const projection = (await readState(paths)).globalProjections.find(
      (candidate) => candidate.surfacePath === instructionFile,
    )!;
    expect(
      await reconcileRetiredGlobalCows(paths, { ids: [projection.id], quiescent: true }),
    ).toEqual({ reconciled: 1, quarantined: 0 });
    expect(readFileSync(canonical, 'utf8')).toBe('# ATTRIBUTABLE EDIT\n');
    expect(readFileSync(instructionFile, 'utf8')).toBe('# USER INSTRUCTIONS\n');
    expect(readFileSync(projection.retainedPath!, 'utf8')).toBe(edited);
  });

  it('quarantines an instruction edit when its canonical source changed concurrently', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const realRoot = join(home.home, 'real');
    const instructionFile = join(realRoot, 'INSTRUCTIONS.md');
    const canonical = join(paths.envDir('writing'), 'instructions', 'base.md');
    mkdirSync(join(paths.envDir('writing'), 'instructions'), { recursive: true });
    mkdirSync(realRoot, { recursive: true });
    writeFileSync(instructionFile, '# USER\n');
    writeFileSync(canonical, '# BASELINE\n');
    const env = { ...home.env, [FIXTURE_CONFIG_ENV]: realRoot };
    const adapter = makeFixtureAdapter();

    await materialiseGlobal({ paths, adapters: [adapter], envs: ['writing'], env });
    const edited = readFileSync(instructionFile, 'utf8').replace('# BASELINE', '# LATE EDIT');
    const descriptor = openSync(instructionFile, 'r+');
    await dematerialiseGlobal({ paths, adapters: [adapter], envs: ['writing'], all: true, env });
    ftruncateSync(descriptor, 0);
    writeSync(descriptor, edited, 0, 'utf8');
    closeSync(descriptor);
    writeFileSync(canonical, '# CONCURRENT CANONICAL\n');

    const projection = (await readState(paths)).globalProjections.find(
      (candidate) => candidate.surfacePath === instructionFile,
    )!;
    expect(
      await reconcileRetiredGlobalCows(paths, { ids: [projection.id], quiescent: true }),
    ).toEqual({ reconciled: 0, quarantined: 1 });
    expect(readFileSync(canonical, 'utf8')).toBe('# CONCURRENT CANONICAL\n');
    expect(readFileSync(projection.retainedPath!, 'utf8')).toBe(edited);
  });

  it('rolls every canonical field back when a multi-source projection publish faults', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const realRoot = join(home.home, 'real');
    const instructionFile = join(realRoot, 'INSTRUCTIONS.md');
    const instructionDir = join(paths.envDir('writing'), 'instructions');
    const base = join(instructionDir, 'base.md');
    const fixture = join(instructionDir, 'fixture.md');
    mkdirSync(instructionDir, { recursive: true });
    mkdirSync(realRoot, { recursive: true });
    writeFileSync(instructionFile, '# USER\n');
    writeFileSync(base, '# BASE ONE\n');
    writeFileSync(fixture, '# BASE TWO\n');
    const env = { ...home.env, [FIXTURE_CONFIG_ENV]: realRoot };
    const adapter = makeFixtureAdapter();

    await materialiseGlobal({ paths, adapters: [adapter], envs: ['writing'], env });
    const edited = readFileSync(instructionFile, 'utf8')
      .replace('# BASE ONE', '# EDIT ONE')
      .replace('# BASE TWO', '# EDIT TWO');
    const descriptor = openSync(instructionFile, 'r+');
    await dematerialiseGlobal({ paths, adapters: [adapter], envs: ['writing'], all: true, env });
    ftruncateSync(descriptor, 0);
    writeSync(descriptor, edited, 0, 'utf8');
    closeSync(descriptor);

    const projection = (await readState(paths)).globalProjections.find(
      (candidate) => candidate.surfacePath === instructionFile,
    )!;
    let applied = 0;
    expect(
      await reconcileRetiredGlobalCows(paths, {
        ids: [projection.id],
        quiescent: true,
        afterCanonicalApply: async () => {
          applied += 1;
          if (applied === 2) throw new Error('injected second canonical failure');
        },
      }),
    ).toEqual({ reconciled: 0, quarantined: 1 });
    expect(readFileSync(base, 'utf8')).toBe('# BASE ONE\n');
    expect(readFileSync(fixture, 'utf8')).toBe('# BASE TWO\n');
    expect((await readState(paths)).commands).toEqual([]);
    expect(readFileSync(projection.retainedPath!, 'utf8')).toBe(edited);
  });

  it('resumes required Git bookkeeping without replaying canonical writes', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const realRoot = join(home.home, 'real');
    const instructionFile = join(realRoot, 'INSTRUCTIONS.md');
    const canonical = join(paths.envDir('writing'), 'instructions', 'base.md');
    mkdirSync(join(paths.envDir('writing'), 'instructions'), { recursive: true });
    mkdirSync(realRoot, { recursive: true });
    writeFileSync(instructionFile, '# USER\n');
    writeFileSync(canonical, '# BASELINE\n');
    const env = { ...home.env, [FIXTURE_CONFIG_ENV]: realRoot };
    const adapter = makeFixtureAdapter();
    await materialiseGlobal({ paths, adapters: [adapter], envs: ['writing'], env });
    const edited = readFileSync(instructionFile, 'utf8').replace('# BASELINE', '# EDITED');
    const descriptor = openSync(instructionFile, 'r+');
    await dematerialiseGlobal({ paths, adapters: [adapter], envs: ['writing'], all: true, env });
    ftruncateSync(descriptor, 0);
    writeSync(descriptor, edited, 0, 'utf8');
    closeSync(descriptor);
    const projection = (await readState(paths)).globalProjections.find(
      (candidate) => candidate.surfacePath === instructionFile,
    )!;

    await expect(
      reconcileRetiredGlobalCows(paths, {
        ids: [projection.id],
        quiescent: true,
        gitBookkeeping: async () => {
          throw new Error('injected commit failure');
        },
      }),
    ).rejects.toThrow(/injected commit failure/);
    expect(readFileSync(canonical, 'utf8')).toBe('# EDITED\n');
    expect((await readState(paths)).globalProjections.find((item) => item.id === projection.id)).toMatchObject({
      phase: 'reconciling',
    });
    expect((await readState(paths)).commands).toMatchObject([
      { transactionId: `projection-${projection.id}`, phase: 'git-pending' },
    ]);

    let commits = 0;
    expect(
      await reconcileRetiredGlobalCows(paths, {
        ids: [projection.id],
        quiescent: true,
        gitBookkeeping: async () => {
          commits += 1;
        },
      }),
    ).toEqual({ reconciled: 1, quarantined: 0 });
    expect(commits).toBe(1);
    expect(readFileSync(canonical, 'utf8')).toBe('# EDITED\n');
    expect((await readState(paths)).commands).toEqual([]);
    expect((await readState(paths)).globalProjections.find((item) => item.id === projection.id)).toMatchObject({
      phase: 'reconciled',
    });
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
