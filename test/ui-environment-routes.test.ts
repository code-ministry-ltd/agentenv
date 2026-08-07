import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EnvironmentLifecycleResult } from '../src/application/environment-lifecycle.js';
import { scaffoldEnvYaml } from '../src/env-config.js';
import { capturePathIdentity } from '../src/path-identity.js';
import { resolvePaths, type Paths } from '../src/paths.js';
import { ensureStore } from '../src/store.js';
import { startUiServer, type UiServerHandle } from '../src/ui/server.js';

interface AuthenticatedSession {
  cookie: string;
  csrfToken: string;
}

async function authenticate(server: UiServerHandle): Promise<AuthenticatedSession> {
  const launch = new URL(server.launchUrl);
  const launchToken = new URLSearchParams(launch.hash.slice(1)).get('launch');
  const response = await fetch(`${server.origin}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.origin },
    body: JSON.stringify({ launchToken }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: { csrfToken: string } };
  return { cookie: response.headers.get('set-cookie')!, csrfToken: body.data.csrfToken };
}

function mutationHeaders(
  server: UiServerHandle,
  session: AuthenticatedSession,
): Record<string, string> {
  return {
    cookie: session.cookie,
    origin: server.origin,
    'content-type': 'application/json',
    'x-agentenv-csrf': session.csrfToken,
  };
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
}

async function seedCloneSource(paths: Paths): Promise<void> {
  const source = paths.envDir('writing');
  await mkdir(join(source, 'skills', 'drafting'), { recursive: true });
  await mkdir(join(source, 'instructions'), { recursive: true });
  await mkdir(join(source, 'mcp'), { recursive: true });
  await mkdir(join(source, 'agents'), { recursive: true });
  await mkdir(join(source, 'commands'), { recursive: true });
  await writeFile(
    paths.envYaml('writing'),
    [
      'version: "1.0"',
      'description: Complete source.',
      'sources:',
      '  drafting:',
      '    repo: owner/writing-tools',
      '    path: skills/drafting',
      '    ref: main',
      '    commit: abcdef1234567890abcdef1234567890abcdef12',
      '    hash: exact-source-hash',
      '',
    ].join('\n'),
  );
  const skill = join(source, 'skills', 'drafting', 'SKILL.md');
  await writeFile(
    skill,
    '---\nname: drafting\ndescription: Shape a draft.\n---\n\n# Drafting\n',
  );
  await chmod(skill, 0o640);
  await writeFile(join(source, 'instructions', 'base.md'), '# Source instructions\n');
  await writeFile(
    join(source, 'mcp', 'servers.yaml'),
    'linear:\n  transport: stdio\n  command: linear\n',
  );
  await writeFile(join(source, 'agents', 'editor.md'), '# Editor\n');
  await writeFile(join(source, 'commands', 'publish.md'), '# Publish\n');
  await writeFile(join(source, 'opaque.bin'), Buffer.from([0, 1, 2, 255]));
}

describe('environment lifecycle HTTP routes', () => {
  let home: string;
  let paths: Paths;
  let env: NodeJS.ProcessEnv;
  let assetsDir: string;
  let server: UiServerHandle | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'agentenv-ui-environment-routes-'));
    env = {
      ...process.env,
      AGENTENV_HOME: home,
      HOME: home,
      USERPROFILE: home,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    };
    paths = resolvePaths(env);
    assetsDir = await mkdtemp(join(home, 'assets-'));
    await writeFile(join(assetsDir, 'index.html'), '<h1>environment fixture</h1>');
  });

  afterEach(async () => {
    await server?.close();
    await rm(home, { recursive: true, force: true });
  });

  it('creates and fully clones through the production sync and publication runtime', async () => {
    await ensureStore(paths);
    await seedCloneSource(paths);
    git(paths.store, ['init', '-b', 'main']);
    git(paths.store, ['add', '--', '.']);
    git(paths.store, [
      '-c',
      'user.name=agentenv test',
      '-c',
      'user.email=agentenv@test.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'fixture baseline',
    ]);

    server = await startUiServer({
      assetsDir,
      env,
      installSignalHandlers: false,
      paths,
      runOptions: {
        adapters: [],
        globals: { json: false, offline: true, verbose: false },
      },
    });
    const session = await authenticate(server);

    const createResponse = await fetch(`${server.origin}/api/environments`, {
      method: 'POST',
      headers: mutationHeaders(server, session),
      body: JSON.stringify({
        operation: 'create',
        name: 'journaling',
        description: 'Private daily notes',
      }),
    });

    expect(createResponse.status).toBe(200);
    const createBody = (await createResponse.json()) as {
      data: { operation: string; name: string; publication: string; environment: unknown };
    };
    expect(createBody.data).toMatchObject({
      operation: 'create',
      name: 'journaling',
      publication: 'complete',
      environment: {
        name: 'journaling',
        description: 'Private daily notes',
        counts: { skill: 0, instruction: 0, mcp: 0, agent: 0, command: 0 },
        items: [],
      },
    });
    expect(await readFile(paths.envYaml('journaling'), 'utf8')).toBe(
      scaffoldEnvYaml({ description: 'Private daily notes' }),
    );

    const cloneResponse = await fetch(`${server.origin}/api/environments`, {
      method: 'POST',
      headers: mutationHeaders(server, session),
      body: JSON.stringify({ operation: 'clone', name: 'writing-copy', source: 'writing' }),
    });

    expect(cloneResponse.status).toBe(200);
    const cloneBody = (await cloneResponse.json()) as {
      data: {
        operation: string;
        name: string;
        source: string;
        publication: string;
        environment: { items: readonly { kind: string; name: string; source?: unknown }[] };
      };
    };
    expect(cloneBody.data).toMatchObject({
      operation: 'clone',
      name: 'writing-copy',
      source: 'writing',
      publication: 'complete',
    });
    expect(cloneBody.data.environment.items.map((item) => `${item.kind}:${item.name}`)).toEqual([
      'skill:drafting',
      'instruction:base',
      'mcp:linear',
      'agent:editor',
      'command:publish',
    ]);
    expect(cloneBody.data.environment.items[0]).toMatchObject({
      source: {
        repository: 'owner/writing-tools',
        path: 'skills/drafting',
        ref: 'main',
        shortCommit: 'abcdef1',
      },
    });
    expect(await capturePathIdentity(paths.envDir('writing-copy'))).toEqual(
      await capturePathIdentity(paths.envDir('writing')),
    );
    expect((await stat(join(paths.envDir('writing-copy'), 'skills', 'drafting', 'SKILL.md'))).mode & 0o777)
      .toBe(0o640);

    const cloneCommitPaths = git(paths.store, [
      'show',
      '--format=',
      '--name-only',
      'HEAD',
    ]).trim().split('\n').filter(Boolean);
    expect(cloneCommitPaths.length).toBeGreaterThan(0);
    expect(cloneCommitPaths.every((path) =>
      relative('environments/writing-copy', path) !== '..' &&
      !relative('environments/writing-copy', path).startsWith('../')
    )).toBe(true);
    expect(git(paths.store, ['log', '-2', '--format=%s']).trim().split('\n')).toEqual([
      'agentenv: create env writing-copy (from writing)',
      'agentenv: create env journaling',
    ]);
  });

  it('acknowledges durable publication when its optional inventory projection fails', async () => {
    await ensureStore(paths);
    git(paths.store, ['init', '-b', 'main']);
    git(paths.store, ['add', '--', '.']);
    git(paths.store, [
      '-c',
      'user.name=agentenv test',
      '-c',
      'user.email=agentenv@test.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-m',
      'fixture baseline',
    ]);
    server = await startUiServer({
      assetsDir,
      env,
      installSignalHandlers: false,
      paths,
      runOptions: {
        adapters: [],
        globals: { json: false, offline: true, verbose: false },
      },
      routeDependencies: {
        getEnvironmentInventory: async () => {
          throw new Error(`private projection failure at ${home}`);
        },
      },
    });
    const session = await authenticate(server);

    const response = await fetch(`${server.origin}/api/environments`, {
      method: 'POST',
      headers: mutationHeaders(server, session),
      body: JSON.stringify({ operation: 'create', name: 'published' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        operation: 'create',
        name: 'published',
        publication: 'complete',
      },
    });
    expect(await readFile(paths.envYaml('published'), 'utf8')).toBe(
      scaffoldEnvYaml({ description: '' }),
    );
  });

  it('rejects malformed, unknown, wrong, and oversized JSON at the guarded body boundary', async () => {
    server = await startUiServer({ assetsDir, env, installSignalHandlers: false, paths });
    const session = await authenticate(server);

    for (const body of [
      '{}',
      JSON.stringify({ operation: 'create', name: 'valid', source: 'writing' }),
      JSON.stringify({ operation: 'create', name: 'valid', description: 42 }),
      JSON.stringify({ operation: 'clone', name: 'copy' }),
      JSON.stringify({ operation: 'clone', name: 'copy', source: 'writing', extra: true }),
      JSON.stringify({ operation: 'remove', name: 'valid' }),
    ]) {
      const response = await fetch(`${server.origin}/api/environments`, {
        method: 'POST',
        headers: mutationHeaders(server, session),
        body,
      });
      expect(response.status, body).toBe(400);
      expect(await response.json()).toEqual({
        error: {
          code: 'MALFORMED_REQUEST',
          message: 'The environment request is malformed.',
        },
      });
    }

    const malformed = await fetch(`${server.origin}/api/environments`, {
      method: 'POST',
      headers: mutationHeaders(server, session),
      body: '{',
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      error: { code: 'MALFORMED_REQUEST', message: 'The request body is malformed.' },
    });

    const oversized = await fetch(`${server.origin}/api/environments`, {
      method: 'POST',
      headers: mutationHeaders(server, session),
      body: JSON.stringify({ operation: 'create', name: 'valid', description: 'x'.repeat(33 * 1024) }),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large.' },
    });
    expect(await capturePathIdentity(paths.store)).toEqual({ kind: 'absent' });
  });

  it('maps domain-invalid names and lifecycle refusals to safe typed outcomes', async () => {
    let next: EnvironmentLifecycleResult = {
      status: 'invalid',
      field: 'name',
      message: "invalid environment name '/private/escape'",
    };
    server = await startUiServer({
      assetsDir,
      env,
      installSignalHandlers: false,
      paths,
      routeDependencies: {
        createEnvironment: async () => next,
        cloneEnvironment: async () => next,
      },
    });
    const session = await authenticate(server);

    const cases: readonly {
      result: EnvironmentLifecycleResult;
      request?: Record<string, unknown>;
      status: number;
      code: string;
      detailKind?: string;
    }[] = [
      {
        result: {
          status: 'invalid',
          field: 'name',
          message: "invalid environment name '/Users/private/escape'",
        },
        request: { operation: 'create', name: '../escape' },
        status: 422,
        code: 'VALIDATION_FAILED',
        detailKind: 'validation',
      },
      {
        result: { status: 'exists', name: 'writing' },
        status: 409,
        code: 'COLLISION',
        detailKind: 'conflict',
      },
      {
        result: { status: 'source-not-found', source: 'missing' },
        request: { operation: 'clone', name: 'copy', source: 'missing' },
        status: 404,
        code: 'NOT_FOUND',
      },
      {
        result: {
          status: 'stale',
          field: 'source',
          name: 'writing',
          message: `source changed at ${join(home, 'private-source')}`,
        },
        request: { operation: 'clone', name: 'copy', source: 'writing' },
        status: 409,
        code: 'STALE_REVISION',
        detailKind: 'conflict',
      },
      {
        result: { status: 'pending-recovery', transactionId: 'pending-safe-id' },
        status: 409,
        code: 'PENDING_RECOVERY',
        detailKind: 'pending-recovery',
      },
      {
        result: {
          status: 'git-pending',
          operation: 'create',
          name: 'writing',
          transactionId: 'git-pending-safe-id',
          publication: 'git-pending',
        },
        status: 409,
        code: 'PENDING_RECOVERY',
        detailKind: 'pending-recovery',
      },
      {
        result: { status: 'failure', message: `Git failed in ${join(home, 'private.git')}` },
        status: 500,
        code: 'INTERNAL_ERROR',
      },
    ];

    for (const testCase of cases) {
      next = testCase.result;
      const response = await fetch(`${server.origin}/api/environments`, {
        method: 'POST',
        headers: mutationHeaders(server, session),
        body: JSON.stringify(testCase.request ?? { operation: 'create', name: 'writing' }),
      });
      expect(response.status).toBe(testCase.status);
      const text = await response.text();
      const body = JSON.parse(text) as {
        error: { code: string; details?: { kind: string } };
      };
      expect(body.error.code).toBe(testCase.code);
      if (testCase.detailKind === undefined) expect(body.error.details).toBeUndefined();
      else expect(body.error.details?.kind).toBe(testCase.detailKind);
      expect(text).not.toContain(home);
      expect(text).not.toContain('/Users/private');
      expect(text).not.toContain('private.git');
    }
    expect(await capturePathIdentity(paths.store)).toEqual({ kind: 'absent' });
  });
});
