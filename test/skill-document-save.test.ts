import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSkillDocument, saveSkillDocument } from '../src/application/skill-document.js';
import {
  createContentTransferRuntime,
  type ContentTransferPublicationRequest,
} from '../src/application/content-transfer-runtime.js';
import { capturePathIdentity } from '../src/path-identity.js';
import { resolvePaths, type Paths } from '../src/paths.js';
import { readState } from '../src/state.js';
import { recoverPendingStagedCommands } from '../src/staged-command.js';
import { defaultGitRunner, ensureStoreRepo, type GitRunner } from '../src/git.js';
import { ensureStore } from '../src/store.js';
import type { Revision } from '../src/ui/contract.js';
import { handleUiRoute } from '../src/ui/routes.js';
import { startUiServer, type UiServerHandle } from '../src/ui/server.js';
import { createUiSkillDocumentRuntime } from '../src/ui/skill-document-runtime.js';

const ORIGINAL = '---\nname: research\ndescription: Original\n---\n\n# Original\n';
const EDITED = '---\nname: research\ndescription: Edited\n---\n\n# Edited\n';

describe('skill document save', () => {
  let home: string;
  let paths: Paths;
  let documentPath: string;
  let siblingPath: string;
  let server: UiServerHandle | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'agentenv-skill-document-save-'));
    paths = resolvePaths({ AGENTENV_HOME: home });
    documentPath = join(paths.envDir('writing'), 'skills', 'research', 'SKILL.md');
    siblingPath = join(documentPath, '..', 'reference.bin');
    await mkdir(join(documentPath, '..'), { recursive: true });
    await writeFile(paths.envYaml('writing'), 'version: "1.0"\ndescription: Writing\n');
    await writeFile(documentPath, ORIGINAL);
    await chmod(documentPath, 0o640);
    await writeFile(siblingPath, Buffer.from([0, 1, 2, 255]));
    await chmod(siblingPath, 0o751);
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    await rm(home, { recursive: true, force: true });
  });

  it('validates and saves the selected skill document against its revision', async () => {
    const loaded = await readSkillDocument({ paths, environment: 'writing', skill: 'research' });
    expect(loaded.status).toBe('loaded');
    if (loaded.status !== 'loaded') return;

    let publication: ContentTransferPublicationRequest | undefined;
    const baseRuntime = createContentTransferRuntime({ paths });
    const result = await saveSkillDocument({
      paths,
      environment: 'writing',
      skill: 'research',
      text: EDITED,
      expectedRevision: loaded.document.revision,
      runtime: {
        open: baseRuntime.open,
        close: baseRuntime.close,
        publish: async (request) => {
          publication = request;
          return await baseRuntime.publish(request);
        },
      },
    });

    expect(result.status, JSON.stringify(result)).toBe('saved');
    expect(await readFile(documentPath, 'utf8')).toBe(EDITED);
    expect((await lstat(documentPath)).mode & 0o777).toBe(0o640);
    expect(await readFile(siblingPath)).toEqual(Buffer.from([0, 1, 2, 255]));
    expect((await lstat(siblingPath)).mode & 0o777).toBe(0o751);
    expect(publication?.entries).toEqual([
      expect.objectContaining({ id: 'skill-document', target: documentPath }),
    ]);
    expect(publication?.gitSteps).toEqual([{
      id: 'save-skill-document',
      message: 'agentenv: edit skill research in writing',
      paths: [documentPath],
    }]);
    expect(JSON.stringify(result)).not.toContain(home);
  });

  it('validates runtime values and edited frontmatter without opening or mutating the store', async () => {
    const runtime = {
      open: vi.fn(async () => ({ status: 'ready' as const })),
      close: vi.fn(async () => {}),
      publish: vi.fn(async () => ({ status: 'complete' as const })),
    };
    const before = await capturePathIdentity(join(documentPath, '..'));
    for (const [field, override] of [
      ['environment', { environment: 42 }],
      ['skill', { skill: '../research' }],
      ['text', { text: null }],
      ['expectedRevision', { expectedRevision: 'not-a-revision' }],
    ] as const) {
      await expect(saveSkillDocument({
        paths,
        environment: 'writing',
        skill: 'research',
        text: EDITED,
        expectedRevision: 'r'.repeat(43),
        runtime,
        ...override,
      })).resolves.toEqual({ status: 'invalid', field });
    }
    expect(runtime.open).not.toHaveBeenCalled();

    const loaded = await readSkillDocument({ paths, environment: 'writing', skill: 'research' });
    expect(loaded.status).toBe('loaded');
    if (loaded.status !== 'loaded') return;
    for (const text of [
      '# missing frontmatter\n',
      '---\ndescription: missing name\n---\n\n# invalid\n',
      '---\nname: other\n---\n\n# invalid\n',
      '---\nname: [broken\n---\n\n# invalid\n',
    ]) {
      const result = await saveSkillDocument({
        paths,
        environment: 'writing',
        skill: 'research',
        text,
        expectedRevision: loaded.document.revision,
        runtime,
      });
      expect(result.status, JSON.stringify(result)).toBe('validation');
      expect(JSON.stringify(result)).not.toContain(home);
    }
    expect(runtime.open).not.toHaveBeenCalled();
    expect(await capturePathIdentity(join(documentPath, '..'))).toEqual(before);
    expect(await readFile(documentPath, 'utf8')).toBe(ORIGINAL);
  });

  it('refuses external edits and same-content entry replacement as stale', async () => {
    const loaded = await readSkillDocument({ paths, environment: 'writing', skill: 'research' });
    expect(loaded.status).toBe('loaded');
    if (loaded.status !== 'loaded') return;
    await writeFile(documentPath, `${ORIGINAL}\nexternal\n`);
    await expect(saveSkillDocument({
      paths,
      environment: 'writing',
      skill: 'research',
      text: EDITED,
      expectedRevision: loaded.document.revision,
      runtime: createContentTransferRuntime({ paths }),
    })).resolves.toEqual({ status: 'stale' });
    expect(await readFile(documentPath, 'utf8')).toBe(`${ORIGINAL}\nexternal\n`);

    const current = await readSkillDocument({ paths, environment: 'writing', skill: 'research' });
    expect(current.status).toBe('loaded');
    if (current.status !== 'loaded') return;
    await rename(documentPath, `${documentPath}.old`);
    await writeFile(documentPath, current.document.text);
    await chmod(documentPath, 0o640);
    await expect(saveSkillDocument({
      paths,
      environment: 'writing',
      skill: 'research',
      text: EDITED,
      expectedRevision: current.document.revision,
      runtime: createContentTransferRuntime({ paths }),
    })).resolves.toEqual({ status: 'stale' });
    expect(await readFile(documentPath, 'utf8')).toBe(current.document.text);
  });

  it('maps missing, unsafe, pending-open, and mutation-boundary replacement without publication', async () => {
    const loaded = await readSkillDocument({ paths, environment: 'writing', skill: 'research' });
    expect(loaded.status).toBe('loaded');
    if (loaded.status !== 'loaded') return;
    const pendingRuntime = {
      open: vi.fn(async () => ({ status: 'pending-recovery' as const, transactionId: 'pending-safe' })),
      close: vi.fn(async () => {}),
      publish: vi.fn(async () => ({ status: 'complete' as const })),
    };
    await expect(saveSkillDocument({
      paths,
      environment: 'writing',
      skill: 'research',
      text: EDITED,
      expectedRevision: loaded.document.revision,
      runtime: pendingRuntime,
    })).resolves.toEqual({ status: 'pending-recovery', transactionId: 'pending-safe' });
    expect(pendingRuntime.publish).not.toHaveBeenCalled();

    const external = `${ORIGINAL}\nmutation boundary external\n`;
    const raced = await saveSkillDocument({
      paths,
      environment: 'writing',
      skill: 'research',
      text: EDITED,
      expectedRevision: loaded.document.revision,
      runtime: createContentTransferRuntime({ paths }),
      faults: { afterStage: async () => { await writeFile(documentPath, external); } },
    });
    expect(raced).toEqual({ status: 'stale' });
    expect(await readFile(documentPath, 'utf8')).toBe(external);

    await rm(documentPath);
    await expect(saveSkillDocument({
      paths,
      environment: 'writing',
      skill: 'research',
      text: EDITED,
      expectedRevision: loaded.document.revision,
      runtime: createContentTransferRuntime({ paths }),
    })).resolves.toEqual({ status: 'not-found' });
    const privateFile = join(home, 'private-skill.md');
    await writeFile(privateFile, ORIGINAL);
    await symlink(privateFile, documentPath);
    await expect(saveSkillDocument({
      paths,
      environment: 'writing',
      skill: 'research',
      text: EDITED,
      expectedRevision: loaded.document.revision,
      runtime: createContentTransferRuntime({ paths }),
    })).resolves.toEqual({ status: 'unsafe' });
    expect(await readFile(privateFile, 'utf8')).toBe(ORIGINAL);
  });

  it('rolls back a failure before commit and reports durable post-commit Git recovery truth', async () => {
    const loaded = await readSkillDocument({ paths, environment: 'writing', skill: 'research' });
    expect(loaded.status).toBe('loaded');
    if (loaded.status !== 'loaded') return;
    const beforeApplyFailure = await saveSkillDocument({
      paths,
      environment: 'writing',
      skill: 'research',
      text: EDITED,
      expectedRevision: loaded.document.revision,
      runtime: createContentTransferRuntime({ paths }),
      faults: { afterApply: async () => { throw new Error('injected private failure'); } },
    });
    expect(beforeApplyFailure).toEqual({ status: 'failure' });
    expect(await readFile(documentPath, 'utf8')).toBe(ORIGINAL);
    expect((await readState(paths)).commands).toEqual([]);

    const afterRollback = await readSkillDocument({
      paths,
      environment: 'writing',
      skill: 'research',
    });
    expect(afterRollback.status).toBe('loaded');
    if (afterRollback.status !== 'loaded') return;

    const pending = await saveSkillDocument({
      paths,
      environment: 'writing',
      skill: 'research',
      text: EDITED,
      expectedRevision: afterRollback.document.revision,
      runtime: createContentTransferRuntime({
        paths,
        gitBookkeeping: async () => { throw new Error('injected git failure'); },
      }),
    });
    expect(pending).toMatchObject({
      status: 'git-pending',
      publication: 'git-pending',
      refreshRequired: false,
    });
    expect(await readFile(documentPath, 'utf8')).toBe(EDITED);
    expect((await readState(paths)).commands).toHaveLength(1);
    await recoverPendingStagedCommands(paths, async () => {});
    expect((await readState(paths)).commands).toEqual([]);
    expect(await readFile(documentPath, 'utf8')).toBe(EDITED);
  });

  it('does not turn a completed WAL publication into a false failure', async () => {
    const loaded = await readSkillDocument({ paths, environment: 'writing', skill: 'research' });
    expect(loaded.status).toBe('loaded');
    if (loaded.status !== 'loaded') return;
    const result = await saveSkillDocument({
      paths,
      environment: 'writing',
      skill: 'research',
      text: EDITED,
      expectedRevision: loaded.document.revision,
      runtime: createContentTransferRuntime({ paths }),
      faults: {
        afterPersist: async (plan) => {
          if (plan.phase === 'complete') throw new Error('injected cleanup failure');
        },
      },
    });
    expect(result).toMatchObject({ status: 'saved', publication: 'complete' });
    expect(await readFile(documentPath, 'utf8')).toBe(EDITED);
    expect((await readState(paths)).commands).toEqual([]);
  });

  it('uses one exact local Git commit and never invokes push', async () => {
    await ensureStore(paths);
    const gitCalls: string[][] = [];
    const gitRun: GitRunner = async (arguments_, options) => {
      gitCalls.push([...arguments_]);
      return await defaultGitRunner(arguments_, options);
    };
    const environment = { AGENTENV_HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
    await ensureStoreRepo(paths, environment, gitRun);
    gitCalls.length = 0;
    const loaded = await readSkillDocument({ paths, environment: 'writing', skill: 'research' });
    expect(loaded.status).toBe('loaded');
    if (loaded.status !== 'loaded') return;

    const result = await saveSkillDocument({
      paths,
      environment: 'writing',
      skill: 'research',
      text: EDITED,
      expectedRevision: loaded.document.revision,
      runtime: createUiSkillDocumentRuntime({
        paths,
        env: environment,
        runOptions: { gitRun },
      }),
    });

    expect(result.status, JSON.stringify(result)).toBe('saved');
    expect(gitCalls.some((arguments_) => arguments_.includes('push'))).toBe(false);
    const commit = gitCalls.find((arguments_) => arguments_.includes('commit'));
    expect(commit).toEqual(expect.arrayContaining([
      'commit',
      '--only',
      '-m',
      'agentenv: edit skill research in writing',
      'environments/writing/skills/research/SKILL.md',
    ]));
    expect(commit?.slice(commit.lastIndexOf('--') + 1)).toEqual([
      'environments/writing/skills/research/SKILL.md',
    ]);
  });

  it('uses the listener runtime seams for an authenticated save', async () => {
    const runtimeEnv: NodeJS.ProcessEnv = {
      ...process.env,
      AGENTENV_HOME: home,
      HOME: home,
      USERPROFILE: home,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      TASK17_RUNTIME_ENV: 'listener-injected',
    };
    await ensureStore(paths);
    await ensureStoreRepo(paths, runtimeEnv);
    const loaded = await readSkillDocument({ paths, environment: 'writing', skill: 'research' });
    expect(loaded.status).toBe('loaded');
    if (loaded.status !== 'loaded') return;

    const gitCalls: string[][] = [];
    const seenRuntimeEnvs: NodeJS.ProcessEnv[] = [];
    const gitRun: GitRunner = async (arguments_, options) => {
      gitCalls.push([...arguments_]);
      seenRuntimeEnvs.push(options.env);
      if (
        arguments_.includes('commit') &&
        arguments_.includes('agentenv: edit skill research in writing')
      ) {
        throw new Error('injected listener commit failure');
      }
      return await defaultGitRunner(arguments_, options);
    };
    server = await startUiServer({
      paths,
      env: runtimeEnv,
      installSignalHandlers: false,
      runOptions: {
        adapters: [],
        gitRun,
        globals: { json: false, offline: true, verbose: false },
      },
    });
    const launch = new URL(server.launchUrl);
    const sessionResponse = await fetch(`${server.origin}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.origin },
      body: JSON.stringify({
        launchToken: new URLSearchParams(launch.hash.slice(1)).get('launch'),
      }),
    });
    const cookie = sessionResponse.headers.get('set-cookie')!;
    const session = await sessionResponse.json() as { data: { csrfToken: string } };

    const response = await fetch(
      `${server.origin}/api/environments/writing/skills/research/document`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          cookie,
          origin: server.origin,
          'x-agentenv-csrf': session.data.csrfToken,
        },
        body: JSON.stringify({
          environment: 'writing',
          skill: 'research',
          text: EDITED,
          expectedRevision: loaded.document.revision,
        }),
      },
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { publication: 'git-pending', refreshRequired: false },
    });
    expect(gitCalls.some((arguments_) => arguments_.includes('commit'))).toBe(true);
    expect(seenRuntimeEnvs.length).toBeGreaterThan(0);
    expect(seenRuntimeEnvs.every((env) => env.TASK17_RUNTIME_ENV === 'listener-injected')).toBe(true);
    expect(gitCalls.some((arguments_) =>
      arguments_.some((argument) => ['fetch', 'pull', 'push', 'ls-remote'].includes(argument)),
    )).toBe(false);
    expect(await readFile(documentPath, 'utf8')).toBe(EDITED);
    expect((await readState(paths)).commands).toEqual([
      expect.objectContaining({ kind: 'skill-document-save', phase: 'git-pending' }),
    ]);
  });

  it('serves one strict PUT contract and preserves committed truth without a readback', async () => {
    const loaded = await readSkillDocument({ paths, environment: 'writing', skill: 'research' });
    expect(loaded.status).toBe('loaded');
    if (loaded.status !== 'loaded') return;
    const save = vi.fn(async () => ({
      status: 'saved' as const,
      publication: 'complete' as const,
      transactionId: 'save-skill-safe',
      refreshRequired: true,
    }));
    const body = {
      environment: 'writing',
      skill: 'research',
      text: EDITED,
      expectedRevision: loaded.document.revision,
    };
    const request = { method: 'PUT' } as IncomingMessage;
    const url = new URL('http://localhost/api/environments/writing/skills/research/document');
    const result = await handleUiRoute(request, url, paths, {
      saveSkillDocument: save,
      createSkillDocumentRuntime: () => createContentTransferRuntime({ paths }),
    }, body);
    expect(result).toEqual({
      status: 200,
      body: {
        data: {
          environment: 'writing',
          skill: 'research',
          publication: 'complete',
          refreshRequired: true,
        },
      },
    });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      environment: 'writing',
      skill: 'research',
      text: EDITED,
      expectedRevision: loaded.document.revision,
    }));

    for (const [method, requestBody, routeUrl, status] of [
      ['POST', body, url.href, 405],
      ['PUT', { ...body, extra: true }, url.href, 400],
      ['PUT', { ...body, expectedRevision: 'bad' }, url.href, 400],
      ['PUT', { ...body, environment: 'other' }, url.href, 400],
      ['PUT', body, `${url.href}?private=/secret`, 400],
    ] as const) {
      const refused = await handleUiRoute(
        { method } as IncomingMessage,
        new URL(routeUrl),
        paths,
        { saveSkillDocument: save },
        requestBody,
      );
      expect(refused?.status).toBe(status);
      expect(JSON.stringify(refused)).not.toContain(home);
      expect(JSON.stringify(refused)).not.toContain('/secret');
    }
  });

  it('maps authoritative validation, stale, pending, and failure results safely', async () => {
    const revision = 'r'.repeat(43) as Revision;
    const body = {
      environment: 'writing', skill: 'research', text: EDITED, expectedRevision: revision,
    };
    const expected = [
      [{ status: 'validation', issues: [{
        field: 'name', code: 'name-mismatch', message: 'Safe issue.', line: 2,
      }] }, 422, 'VALIDATION_FAILED'],
      [{ status: 'stale' }, 409, 'STALE_REVISION'],
      [{ status: 'pending-recovery', transactionId: 'safe-command' }, 409, 'PENDING_RECOVERY'],
      [{ status: 'failure' }, 500, 'INTERNAL_ERROR'],
    ] as const;
    for (const [applicationResult, status, code] of expected) {
      const result = await handleUiRoute(
        { method: 'PUT' } as IncomingMessage,
        new URL('http://localhost/api/environments/writing/skills/research/document'),
        paths,
        { saveSkillDocument: vi.fn(async () => applicationResult) as never },
        body,
      );
      expect(result).toMatchObject({ status, body: { error: { code } } });
      expect(JSON.stringify(result)).not.toContain(home);
    }
    const gitPending = await handleUiRoute(
      { method: 'PUT' } as IncomingMessage,
      new URL('http://localhost/api/environments/writing/skills/research/document'),
      paths,
      {
        saveSkillDocument: vi.fn(async () => ({
          status: 'git-pending' as const,
          publication: 'git-pending' as const,
          transactionId: 'save-skill-safe',
          refreshRequired: false,
        })),
      },
      body,
    );
    expect(gitPending).toEqual({
      status: 200,
      body: { data: {
        environment: 'writing',
        skill: 'research',
        publication: 'git-pending',
        refreshRequired: false,
      } },
    });
  });

  it('requires the authenticated session and CSRF header for the save mutation', async () => {
    const revision = 'r'.repeat(43) as Revision;
    const save = vi.fn(async () => ({
      status: 'saved' as const,
      publication: 'complete' as const,
      transactionId: 'save-skill-safe',
      refreshRequired: false,
      document: {
        environment: 'writing' as never,
        skill: 'research' as never,
        text: EDITED,
        revision,
      },
    }));
    server = await startUiServer({
      paths,
      installSignalHandlers: false,
      routeDependencies: { saveSkillDocument: save },
    });
    const endpoint = `${server.origin}/api/environments/writing/skills/research/document`;
    const requestBody = JSON.stringify({
      environment: 'writing', skill: 'research', text: EDITED, expectedRevision: revision,
    });
    const unauthenticated = await fetch(endpoint, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: server.origin },
      body: requestBody,
    });
    expect(unauthenticated.status).toBe(401);

    const launch = new URL(server.launchUrl);
    const sessionResponse = await fetch(`${server.origin}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.origin },
      body: JSON.stringify({
        launchToken: new URLSearchParams(launch.hash.slice(1)).get('launch'),
      }),
    });
    const cookie = sessionResponse.headers.get('set-cookie')!;
    const session = await sessionResponse.json() as { data: { csrfToken: string } };
    const noCsrf = await fetch(endpoint, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie, origin: server.origin },
      body: requestBody,
    });
    expect(noCsrf.status).toBe(403);
    const saved = await fetch(endpoint, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: server.origin,
        'x-agentenv-csrf': session.data.csrfToken,
      },
      body: requestBody,
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect(save).toHaveBeenCalledOnce();
  });
});
