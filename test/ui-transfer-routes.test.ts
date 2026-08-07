import type { IncomingMessage } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  copyContent as copyContentApplication,
  type CopyContentResult,
  type MoveContentResult,
} from '../src/application/content-transfer.js';
import { createContentTransferRuntime } from '../src/application/content-transfer-runtime.js';
import { getEnvironmentInventory as getInventory } from '../src/application/catalog.js';
import { scaffoldEnvYaml } from '../src/env-config.js';
import type { ContentItem, EnvironmentInventory } from '../src/ui/contract.js';
import { resolvePaths } from '../src/paths.js';
import { capturePathIdentity } from '../src/path-identity.js';
import { readState } from '../src/state.js';
import { ensureStore } from '../src/store.js';
import { handleUiRoute, type UiRouteDependencyOverrides } from '../src/ui/routes.js';
import { startUiServer } from '../src/ui/server.js';

const SOURCE_REVISION = 's'.repeat(43);
const SOURCE_ENVIRONMENT_REVISION = 'e'.repeat(43);
const DESTINATION_ENVIRONMENT_REVISION = 'd'.repeat(43);
const CONTAINER_REVISION = 'c'.repeat(43);
const DESTINATION_REVISION = 'i'.repeat(43);

function item(kind: ContentItem['kind'], revision: string): ContentItem {
  const shared = { name: 'drafting', revision } as const;
  switch (kind) {
    case 'skill': return { ...shared, kind, description: 'Draft safely.' } as ContentItem;
    case 'instruction': return { ...shared, kind, scope: 'harness', harness: 'drafting' } as ContentItem;
    case 'mcp': return { ...shared, kind, transport: 'stdio' } as ContentItem;
    case 'agent': return { ...shared, kind } as ContentItem;
    case 'command': return { ...shared, kind } as ContentItem;
  }
}

function inventory(
  name: string,
  environmentRevision: string,
  kind: EnvironmentInventory['items'][number]['kind'],
  itemRevision?: string,
): EnvironmentInventory {
  return {
    name: name as EnvironmentInventory['name'],
    description: '',
    active: false,
    counts: { skill: 0, instruction: 0, mcp: 0, agent: 0, command: 0 },
    revision: environmentRevision as EnvironmentInventory['revision'],
    containerRevision: CONTAINER_REVISION as EnvironmentInventory['containerRevision'],
    items: itemRevision === undefined ? [] : [item(kind, itemRevision)],
  };
}

function body(kind: EnvironmentInventory['items'][number]['kind']) {
  return {
    operation: 'copy',
    kind,
    name: 'drafting',
    sourceEnvironment: 'source',
    destinationEnvironment: 'destination',
    collision: 'fail',
    sourceItemRevision: SOURCE_REVISION,
    sourceEnvironmentRevision: SOURCE_ENVIRONMENT_REVISION,
    sourceEnvironmentContainerRevision: CONTAINER_REVISION,
    destinationEnvironmentRevision: DESTINATION_ENVIRONMENT_REVISION,
    destinationEnvironmentContainerRevision: CONTAINER_REVISION,
    destinationItemRevision: null,
  };
}

function observedBody(
  source: EnvironmentInventory,
  destination: EnvironmentInventory,
  kind: ContentItem['kind'],
  name: string,
  operation: 'copy' | 'move' = 'copy',
) {
  const sourceItem = source.items.find((candidate) =>
    candidate.kind === kind && candidate.name === name)!;
  const destinationItem = destination.items.find((candidate) =>
    candidate.kind === kind && candidate.name === name);
  return {
    operation,
    kind,
    name,
    sourceEnvironment: source.name,
    destinationEnvironment: destination.name,
    collision: 'fail',
    sourceItemRevision: sourceItem.revision,
    sourceEnvironmentRevision: source.revision,
    sourceEnvironmentContainerRevision: source.containerRevision,
    destinationEnvironmentRevision: destination.revision,
    destinationEnvironmentContainerRevision: destination.containerRevision,
    destinationItemRevision: destinationItem?.revision ?? null,
  };
}

async function route(
  requestBody: Record<string, unknown> | undefined,
  overrides: UiRouteDependencyOverrides = {},
  method = 'POST',
  url = 'http://localhost/api/content/transfer',
) {
  const kind = (requestBody?.kind ?? 'skill') as EnvironmentInventory['items'][number]['kind'];
  const copyContent = vi.fn(async (): Promise<CopyContentResult> => ({
    status: 'copied',
    operation: 'copy',
    kind,
    name: 'drafting',
    transactionId: 'copy-safe-id',
    publication: 'complete',
  }));
  const moveContent = vi.fn(async (): Promise<MoveContentResult> => ({
    status: 'moved',
    operation: 'move',
    kind,
    name: 'drafting',
    transactionId: 'move-safe-id',
    publication: 'complete',
  }));
  const getEnvironmentInventory = vi.fn(async ({ name }: { name: string }) =>
    name === 'source'
      ? inventory(name, SOURCE_ENVIRONMENT_REVISION, kind, SOURCE_REVISION)
      : inventory(name, DESTINATION_ENVIRONMENT_REVISION, kind));
  const dependencies = {
    copyContent,
    moveContent,
    createContentTransferRuntime: () => ({
      open: async () => ({ status: 'ready' }),
      close: async () => {},
      publish: async () => ({ status: 'complete' }),
    }),
    getEnvironmentInventory,
    ...overrides,
  } as UiRouteDependencyOverrides & { moveContent: typeof moveContent };
  const result = await handleUiRoute(
    { method } as IncomingMessage,
    new URL(url),
    resolvePaths({ AGENTENV_HOME: '/tmp/agentenv-ui-transfer-route' }),
    dependencies,
    requestBody,
  );
  return { result, copyContent, moveContent, getEnvironmentInventory };
}

describe('content transfer HTTP route', () => {
  it('rejects a copy request that omits the required opaque revisions', async () => {
    const { result } = await route({
      operation: 'copy',
      kind: 'skill',
      sourceEnvironment: 'source',
      destinationEnvironment: 'destination',
      name: 'drafting',
      collision: 'fail',
    });
    expect(result).toEqual({
      status: 400,
      body: { error: { code: 'MALFORMED_REQUEST', message: 'The content transfer request is malformed.' } },
    });
  });

  it.each(['skill', 'instruction', 'mcp', 'agent', 'command'] as const)(
    'copies %s through the one application boundary',
    async (kind) => {
      const { result, copyContent } = await route(body(kind));
      expect(result).toMatchObject({
        status: 200,
        body: {
          data: {
            operation: 'copy',
            source: { environment: 'source', kind, name: 'drafting' },
            destination: { environment: 'destination', kind, name: 'drafting' },
            publication: 'complete',
            refreshRequired: false,
          },
        },
      });
      expect(copyContent).toHaveBeenCalledOnce();
      expect(copyContent).toHaveBeenCalledWith(expect.objectContaining({
        source: { environment: 'source', kind, name: 'drafting' },
        destination: { environment: 'destination', kind, name: 'drafting' },
        collision: 'fail',
        observedRevisions: {
          sourceItem: SOURCE_REVISION,
          sourceEnvironment: SOURCE_ENVIRONMENT_REVISION,
          sourceEnvironmentContainer: CONTAINER_REVISION,
          destinationEnvironment: DESTINATION_ENVIRONMENT_REVISION,
          destinationEnvironmentContainer: CONTAINER_REVISION,
          destinationItem: null,
        },
      }));
    },
  );

  it.each(['skill', 'instruction', 'mcp', 'agent', 'command'] as const)(
    'moves %s through the one application boundary',
    async (kind) => {
      const { result, copyContent, moveContent } = await route({ ...body(kind), operation: 'move' });
      expect(result).toMatchObject({
        status: 200,
        body: {
          data: {
            operation: 'move',
            source: { environment: 'source', kind, name: 'drafting' },
            destination: { environment: 'destination', kind, name: 'drafting' },
            publication: 'complete',
            refreshRequired: false,
          },
        },
      });
      expect(copyContent).not.toHaveBeenCalled();
      expect(moveContent).toHaveBeenCalledOnce();
      expect(moveContent).toHaveBeenCalledWith(expect.objectContaining({
        source: { environment: 'source', kind, name: 'drafting' },
        destination: { environment: 'destination', kind, name: 'drafting' },
        collision: 'fail',
        observedRevisions: {
          sourceItem: SOURCE_REVISION,
          sourceEnvironment: SOURCE_ENVIRONMENT_REVISION,
          sourceEnvironmentContainer: CONTAINER_REVISION,
          destinationEnvironment: DESTINATION_ENVIRONMENT_REVISION,
          destinationEnvironmentContainer: CONTAINER_REVISION,
          destinationItem: null,
        },
      }));
    },
  );

  it('rejects unsupported methods, unknown keys, hostile names, and stale observed revisions', async () => {
    expect((await route(undefined, {}, 'GET')).result).toMatchObject({ status: 405 });
    expect((await route(body('skill'), {}, 'POST', 'http://localhost/api/content/transfer?x=1')).result)
      .toMatchObject({ status: 400 });
    expect((await route({ ...body('skill'), extra: true })).result).toMatchObject({ status: 400 });
    expect((await route({ ...body('skill'), name: '../../secret' })).result).toMatchObject({ status: 422 });
    expect((await route({
      ...body('skill'), destinationEnvironment: 'source',
    })).result).toMatchObject({ status: 422 });
    expect((await route({
      ...body('skill'), sourceItemRevision: 'short',
    })).result).toMatchObject({ status: 400 });
    expect((await route({ ...body('skill'), sourceItemRevision: 'x'.repeat(43) })).result)
      .toMatchObject({ status: 409, body: { error: { code: 'STALE_REVISION' } } });
  });

  it('enforces authenticated same-origin CSRF before parsing a production POST', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentenv-ui-transfer-security-'));
    const assetsDir = join(home, 'assets');
    await mkdir(assetsDir);
    await writeFile(join(assetsDir, 'index.html'), 'fixture');
    const server = await startUiServer({
      assetsDir,
      env: { ...process.env, AGENTENV_HOME: home, HOME: home },
      installSignalHandlers: false,
    });
    try {
      const launch = new URL(server.launchUrl);
      const launchToken = new URLSearchParams(launch.hash.slice(1)).get('launch');
      const sessionResponse = await fetch(`${server.origin}/api/session`, {
        method: 'POST',
        headers: { origin: server.origin, 'content-type': 'application/json' },
        body: JSON.stringify({ launchToken }),
      });
      const cookie = sessionResponse.headers.get('set-cookie')!;
      const session = await sessionResponse.json() as { data: { csrfToken: string } };
      const missingCsrf = await fetch(`${server.origin}/api/content/transfer`, {
        method: 'POST',
        headers: { cookie, origin: server.origin, 'content-type': 'application/json' },
        body: JSON.stringify(body('skill')),
      });
      expect(missingCsrf.status).toBe(403);
      const malformed = await fetch(`${server.origin}/api/content/transfer`, {
        method: 'POST',
        headers: {
          cookie,
          origin: server.origin,
          'content-type': 'application/json',
          'x-agentenv-csrf': session.data.csrfToken,
        },
        body: '{}',
      });
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toMatchObject({
        error: { code: 'MALFORMED_REQUEST' },
      });
    } finally {
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it.each([
    'sourceItemRevision',
    'sourceEnvironmentRevision',
    'sourceEnvironmentContainerRevision',
    'destinationEnvironmentRevision',
    'destinationEnvironmentContainerRevision',
    'destinationItemRevision',
  ] as const)('rejects a stale %s before delegation', async (field) => {
    const { result, copyContent } = await route({
      ...body('skill'),
      [field]: 'x'.repeat(43),
    });
    expect(result).toMatchObject({
      status: 409,
      body: { error: { code: 'STALE_REVISION' } },
    });
    expect(copyContent).not.toHaveBeenCalled();
  });

  it('returns a current collision and requires its exact revision for explicit overwrite', async () => {
    const destination = inventory(
      'destination',
      DESTINATION_ENVIRONMENT_REVISION,
      'skill',
      DESTINATION_REVISION,
    );
    const getEnvironmentInventory = vi.fn(async ({ name }: { name: string }) =>
      name === 'source'
        ? inventory(name, SOURCE_ENVIRONMENT_REVISION, 'skill', SOURCE_REVISION)
        : destination);
    const refused = await route(body('skill'), { getEnvironmentInventory });
    expect(refused.result).toMatchObject({
      status: 409,
      body: { error: { code: 'COLLISION', details: {
        kind: 'transfer-collision',
        destinationItemRevision: DESTINATION_REVISION,
      } } },
    });
    expect(refused.copyContent).not.toHaveBeenCalled();
    expect((await route({
      ...body('skill'), destinationItemRevision: 'x'.repeat(43),
    }, { getEnvironmentInventory })).result).toMatchObject({
      status: 409,
      body: { error: { code: 'STALE_REVISION' } },
    });

    const overwrite = {
      ...body('skill'),
      collision: 'overwrite',
      destinationItemRevision: DESTINATION_REVISION,
    };
    const published = await route(overwrite, { getEnvironmentInventory });
    expect(published.result).toMatchObject({ status: 200 });
    expect(published.copyContent).toHaveBeenCalledWith(expect.objectContaining({ collision: 'overwrite' }));
    expect((await route({ ...overwrite, destinationItemRevision: 'x'.repeat(43) }, {
      getEnvironmentInventory,
    })).result).toMatchObject({ status: 409, body: { error: { code: 'STALE_REVISION' } } });
  });

  it('binds move overwrite consent to the currently observed source and destination revisions', async () => {
    const destination = inventory(
      'destination',
      DESTINATION_ENVIRONMENT_REVISION,
      'skill',
      DESTINATION_REVISION,
    );
    const getEnvironmentInventory = vi.fn(async ({ name }: { name: string }) =>
      name === 'source'
        ? inventory(name, SOURCE_ENVIRONMENT_REVISION, 'skill', SOURCE_REVISION)
        : destination);
    const request = { ...body('skill'), operation: 'move' };
    const refused = await route(request, { getEnvironmentInventory });
    expect(refused.result).toMatchObject({
      status: 409,
      body: { error: { code: 'COLLISION', details: {
        destinationItemRevision: DESTINATION_REVISION,
      } } },
    });
    expect(refused.moveContent).not.toHaveBeenCalled();

    const overwrite = await route({
      ...request,
      collision: 'overwrite',
      destinationItemRevision: DESTINATION_REVISION,
    }, { getEnvironmentInventory });
    expect(overwrite.result).toMatchObject({
      status: 200,
      body: { data: { operation: 'move', publication: 'complete' } },
    });
    expect(overwrite.moveContent).toHaveBeenCalledOnce();
    expect(overwrite.moveContent).toHaveBeenCalledWith(expect.objectContaining({
      collision: 'overwrite',
      observedRevisions: expect.objectContaining({ destinationItem: DESTINATION_REVISION }),
    }));

    const stale = await route({
      ...request,
      collision: 'overwrite',
      destinationItemRevision: 'x'.repeat(43),
    }, { getEnvironmentInventory });
    expect(stale.result).toMatchObject({
      status: 409,
      body: { error: { code: 'STALE_REVISION' } },
    });
    expect(stale.moveContent).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 'not-found', field: 'source' }, 404, 'NOT_FOUND'],
    [{ status: 'stale', field: 'source', message: '/private/path' }, 409, 'STALE_REVISION'],
    [{ status: 'pending-recovery', transactionId: '/private/id' }, 409, 'PENDING_RECOVERY'],
    [{ status: 'failure', message: 'secret /private/path' }, 500, 'INTERNAL_ERROR'],
  ] as const)('maps %s safely', async (outcome, status, code) => {
    const copyContent = vi.fn(async () => outcome as CopyContentResult);
    const { result } = await route(body('skill'), { copyContent });
    expect(result).toMatchObject({ status, body: { error: { code } } });
    expect(JSON.stringify(result)).not.toContain('/private');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it.each([
    [{ status: 'invalid', field: 'source', message: '/private/input' }, 422, 'VALIDATION_FAILED'],
    [{ status: 'not-found', field: 'source' }, 404, 'NOT_FOUND'],
    [{ status: 'stale', field: 'destination', message: '/private/stale' }, 409, 'STALE_REVISION'],
    [{ status: 'pending-recovery', transactionId: '/private/id' }, 409, 'PENDING_RECOVERY'],
    [{ status: 'failure', message: 'secret /private/path' }, 500, 'INTERNAL_ERROR'],
  ] as const)('maps move outcome %s safely', async (outcome, status, code) => {
    const moveContent = vi.fn(async () => outcome as MoveContentResult);
    const { result } = await route({ ...body('skill'), operation: 'move' }, { moveContent });
    expect(result).toMatchObject({ status, body: { error: { code } } });
    expect(JSON.stringify(result)).not.toContain('/private');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('redacts a thrown application or runtime failure', async () => {
    const copyContent = vi.fn(async () => {
      throw new Error('secret /private/domain/error');
    });
    const { result } = await route(body('skill'), { copyContent });
    expect(result).toEqual({
      status: 500,
      body: { error: { code: 'INTERNAL_ERROR', message: 'The content could not be copied.' } },
    });
  });

  it('redacts a thrown move application or runtime failure', async () => {
    const moveContent = vi.fn(async (): Promise<MoveContentResult> => {
      throw new Error('secret /private/domain/move-error');
    });
    const { result } = await route({ ...body('skill'), operation: 'move' }, { moveContent });
    expect(result).toEqual({
      status: 500,
      body: { error: { code: 'INTERNAL_ERROR', message: 'The content could not be moved.' } },
    });
  });

  it('keeps committed and git-pending publication truthful when projection fails', async () => {
    for (const publication of ['complete', 'git-pending'] as const) {
      let reads = 0;
      const getEnvironmentInventory = vi.fn(async ({ name }: { name: string }) => {
        reads += 1;
        if (reads > 2) throw new Error('/private projection failure');
        return name === 'source'
          ? inventory(name, SOURCE_ENVIRONMENT_REVISION, 'skill', SOURCE_REVISION)
          : inventory(name, DESTINATION_ENVIRONMENT_REVISION, 'skill');
      });
      const copyContent = vi.fn(async (): Promise<CopyContentResult> => publication === 'complete'
        ? {
            status: 'copied', operation: 'copy', kind: 'skill', name: 'drafting',
            transactionId: 'safe-id', publication,
          }
        : {
            status: 'git-pending', operation: 'copy', kind: 'skill', name: 'drafting',
            transactionId: 'safe-id', publication,
          });
      const { result } = await route(body('skill'), { copyContent, getEnvironmentInventory });
      expect(result).toMatchObject({
        status: 200,
        body: { data: { publication, refreshRequired: true } },
      });
      expect(JSON.stringify(result)).not.toContain('/private');
    }
  });

  it('keeps moved and move git-pending publication truthful when either projection fails', async () => {
    for (const publication of ['complete', 'git-pending'] as const) {
      let reads = 0;
      const getEnvironmentInventory = vi.fn(async ({ name }: { name: string }) => {
        reads += 1;
        if (reads > 2) throw new Error('/private move projection failure');
        return name === 'source'
          ? inventory(name, SOURCE_ENVIRONMENT_REVISION, 'skill', SOURCE_REVISION)
          : inventory(name, DESTINATION_ENVIRONMENT_REVISION, 'skill');
      });
      const moveContent = vi.fn(async (): Promise<MoveContentResult> => publication === 'complete'
        ? {
            status: 'moved', operation: 'move', kind: 'skill', name: 'drafting',
            transactionId: 'safe-move-id', publication,
          }
        : {
            status: 'git-pending', operation: 'move', kind: 'skill', name: 'drafting',
            transactionId: 'safe-move-id', publication,
          });
      const { result } = await route(
        { ...body('skill'), operation: 'move' },
        { moveContent, getEnvironmentInventory },
      );
      expect(result).toMatchObject({
        status: 200,
        body: { data: { operation: 'move', publication, refreshRequired: true } },
      });
      expect(moveContent).toHaveBeenCalledOnce();
      expect(JSON.stringify(result)).not.toContain('/private');
    }
  });

  it.each([
    { status: 'moved', operation: 'move', publication: 'git-pending' },
    { status: 'moved', operation: 'copy', publication: 'complete' },
    { status: 'git-pending', operation: 'move', publication: 'complete' },
  ])('rejects a non-authoritative move success shape %#', async (outcome) => {
    const moveContent = vi.fn(async () => outcome as unknown as MoveContentResult);
    const { result, getEnvironmentInventory } = await route(
      { ...body('skill'), operation: 'move' },
      { moveContent },
    );
    expect(result).toEqual({
      status: 500,
      body: { error: { code: 'INTERNAL_ERROR', message: 'The content could not be moved.' } },
    });
    expect(getEnvironmentInventory).toHaveBeenCalledTimes(2);
  });

  it('copies all five real inventory kinds through the production application boundary', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentenv-ui-transfer-real-'));
    const paths = resolvePaths({ AGENTENV_HOME: home, HOME: home });
    try {
      await ensureStore(paths);
      for (const name of ['source', 'destination']) {
        await mkdir(paths.envDir(name), { recursive: true });
        await writeFile(paths.envYaml(name), scaffoldEnvYaml({ description: '' }));
      }
      await mkdir(join(paths.envDir('source'), 'skills', 'drafting'), { recursive: true });
      await writeFile(
        join(paths.envDir('source'), 'skills', 'drafting', 'SKILL.md'),
        '---\nname: drafting\ndescription: Route fixture.\n---\n\n# drafting\n',
      );
      await mkdir(join(paths.envDir('source'), 'commands'), { recursive: true });
      await writeFile(join(paths.envDir('source'), 'commands', 'publish.md'), '# publish\n');
      await mkdir(join(paths.envDir('source'), 'instructions'), { recursive: true });
      await writeFile(join(paths.envDir('source'), 'instructions', 'base.md'), '# instructions\n');
      await mkdir(join(paths.envDir('source'), 'agents'), { recursive: true });
      await writeFile(join(paths.envDir('source'), 'agents', 'editor.md'), '# editor\n');
      await mkdir(join(paths.envDir('source'), 'mcp'), { recursive: true });
      await writeFile(
        join(paths.envDir('source'), 'mcp', 'servers.yaml'),
        'linear:\n  transport: stdio\n  command: linear\n',
      );

      for (const [kind, name] of [
        ['command', 'publish'],
        ['skill', 'drafting'],
        ['mcp', 'linear'],
        ['instruction', 'base'],
        ['agent', 'editor'],
      ] as const) {
        const source = await getInventory({ paths, name: 'source' });
        const destination = await getInventory({ paths, name: 'destination' });
        const result = await handleUiRoute(
          { method: 'POST' } as IncomingMessage,
          new URL('http://localhost/api/content/transfer'),
          paths,
          {
            createContentTransferRuntime: () => createContentTransferRuntime({ paths }),
          },
          observedBody(source, destination, kind, name),
        );
        expect(result).toMatchObject({
          status: 200,
          body: { data: {
            publication: 'complete',
            refreshRequired: false,
            sourceEnvironment: {
              items: expect.arrayContaining([expect.objectContaining({ kind, name })]),
            },
            destinationEnvironment: {
              items: expect.arrayContaining([expect.objectContaining({ kind, name })]),
            },
          } },
        });
      }
      expect(await readFile(
        join(paths.envDir('destination'), 'skills', 'drafting', 'SKILL.md'),
        'utf8',
      )).toContain('# drafting');
      expect(await readFile(
        join(paths.envDir('destination'), 'commands', 'publish.md'),
        'utf8',
      )).toBe('# publish\n');
      expect(await readFile(
        join(paths.envDir('destination'), 'mcp', 'servers.yaml'),
        'utf8',
      )).toContain('linear:');
      expect(await readFile(
        join(paths.envDir('destination'), 'instructions', 'base.md'),
        'utf8',
      )).toBe('# instructions\n');
      expect(await readFile(
        join(paths.envDir('destination'), 'agents', 'editor.md'),
        'utf8',
      )).toBe('# editor\n');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('moves all five real inventory kinds through Task 14 and projects both affected inventories', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentenv-ui-transfer-real-move-'));
    const paths = resolvePaths({ AGENTENV_HOME: home, HOME: home });
    try {
      await ensureStore(paths);
      for (const name of ['source', 'destination']) {
        await mkdir(paths.envDir(name), { recursive: true });
        await writeFile(paths.envYaml(name), scaffoldEnvYaml({ description: '' }));
      }
      await mkdir(join(paths.envDir('source'), 'skills', 'drafting'), { recursive: true });
      await writeFile(
        join(paths.envDir('source'), 'skills', 'drafting', 'SKILL.md'),
        '---\nname: drafting\ndescription: Move route fixture.\n---\n\n# drafting\n',
      );
      await mkdir(join(paths.envDir('source'), 'commands'), { recursive: true });
      await writeFile(join(paths.envDir('source'), 'commands', 'publish.md'), '# publish\n');
      await mkdir(join(paths.envDir('source'), 'instructions'), { recursive: true });
      await writeFile(join(paths.envDir('source'), 'instructions', 'base.md'), '# instructions\n');
      await mkdir(join(paths.envDir('source'), 'agents'), { recursive: true });
      await writeFile(join(paths.envDir('source'), 'agents', 'editor.md'), '# editor\n');
      await mkdir(join(paths.envDir('source'), 'mcp'), { recursive: true });
      await writeFile(
        join(paths.envDir('source'), 'mcp', 'servers.yaml'),
        'linear:\n  transport: stdio\n  command: linear\n',
      );

      for (const [kind, name] of [
        ['command', 'publish'],
        ['skill', 'drafting'],
        ['mcp', 'linear'],
        ['instruction', 'base'],
        ['agent', 'editor'],
      ] as const) {
        const source = await getInventory({ paths, name: 'source' });
        const destination = await getInventory({ paths, name: 'destination' });
        const result = await handleUiRoute(
          { method: 'POST' } as IncomingMessage,
          new URL('http://localhost/api/content/transfer'),
          paths,
          {
            createContentTransferRuntime: () => createContentTransferRuntime({ paths }),
          },
          observedBody(source, destination, kind, name, 'move'),
        );
        expect(result).toMatchObject({
          status: 200,
          body: { data: {
            operation: 'move',
            publication: 'complete',
            refreshRequired: false,
            sourceEnvironment: {
              items: expect.not.arrayContaining([expect.objectContaining({ kind, name })]),
            },
            destinationEnvironment: {
              items: expect.arrayContaining([expect.objectContaining({ kind, name })]),
            },
          } },
        });
      }
      const source = await getInventory({ paths, name: 'source' });
      const destination = await getInventory({ paths, name: 'destination' });
      expect(source.items).toEqual([]);
      expect(destination.items).toHaveLength(5);
      expect(await readFile(
        join(paths.envDir('destination'), 'skills', 'drafting', 'SKILL.md'),
        'utf8',
      )).toContain('# drafting');
      expect(await readFile(
        join(paths.envDir('destination'), 'commands', 'publish.md'),
        'utf8',
      )).toBe('# publish\n');
      expect(await readFile(
        join(paths.envDir('destination'), 'mcp', 'servers.yaml'),
        'utf8',
      )).toContain('linear:');
      expect(await readFile(
        join(paths.envDir('destination'), 'instructions', 'base.md'),
        'utf8',
      )).toBe('# instructions\n');
      expect(await readFile(
        join(paths.envDir('destination'), 'agents', 'editor.md'),
        'utf8',
      )).toBe('# editor\n');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('rejects reuse of real overwrite consent after a preflight-to-copy destination replacement', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentenv-ui-transfer-race-'));
    const paths = resolvePaths({ AGENTENV_HOME: home, HOME: home });
    try {
      await ensureStore(paths);
      for (const name of ['source', 'destination']) {
        await mkdir(paths.envDir(name), { recursive: true });
        await writeFile(paths.envYaml(name), scaffoldEnvYaml({ description: '' }));
      }
      await mkdir(join(paths.envDir('source'), 'commands'), { recursive: true });
      await writeFile(join(paths.envDir('source'), 'commands', 'race.md'), '# source\n');
      await mkdir(join(paths.envDir('destination'), 'commands'), { recursive: true });
      await writeFile(
        join(paths.envDir('destination'), 'commands', 'race.md'),
        '# observed destination\n',
      );
      const source = await getInventory({ paths, name: 'source' });
      const destination = await getInventory({ paths, name: 'destination' });
      const destinationPath = join(paths.envDir('destination'), 'commands', 'race.md');
      const copyAfterReplacement: typeof copyContentApplication = async (input) => {
        await mkdir(join(paths.envDir('destination'), 'commands'), { recursive: true });
        await writeFile(destinationPath, '# concurrent destination\n');
        return await copyContentApplication(input);
      };
      const request = observedBody(source, destination, 'command', 'race');
      const result = await handleUiRoute(
        { method: 'POST' } as IncomingMessage,
        new URL('http://localhost/api/content/transfer'),
        paths,
        {
          copyContent: copyAfterReplacement,
          createContentTransferRuntime: () => createContentTransferRuntime({ paths }),
        },
        { ...request, collision: 'overwrite' },
      );
      expect(result).toMatchObject({
        status: 409,
        body: { error: { code: 'STALE_REVISION' } },
      });
      expect(await readFile(destinationPath, 'utf8')).toBe('# concurrent destination\n');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('keeps the browser-observed full source environment authoritative through publication', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentenv-ui-transfer-source-race-'));
    const paths = resolvePaths({ AGENTENV_HOME: home, HOME: home });
    try {
      await ensureStore(paths);
      for (const name of ['source', 'destination']) {
        await mkdir(paths.envDir(name), { recursive: true });
        await writeFile(paths.envYaml(name), scaffoldEnvYaml({ description: '' }));
      }
      await mkdir(join(paths.envDir('source'), 'commands'), { recursive: true });
      await writeFile(join(paths.envDir('source'), 'commands', 'copy-me.md'), '# copy me\n');
      await mkdir(join(paths.envDir('source'), 'instructions'), { recursive: true });
      const unrelatedSource = join(paths.envDir('source'), 'instructions', 'unrelated.md');
      await writeFile(unrelatedSource, '# initially observed\n');
      const source = await getInventory({ paths, name: 'source' });
      const destination = await getInventory({ paths, name: 'destination' });
      const destinationBefore = await capturePathIdentity(paths.envDir('destination'));
      const copyAfterUnrelatedMutation: typeof copyContentApplication = async (input) =>
        await copyContentApplication({
          ...input,
          faults: {
            afterStage: async () => {
              await writeFile(unrelatedSource, '# changed after public capture\n');
            },
          },
        });

      const result = await handleUiRoute(
        { method: 'POST' } as IncomingMessage,
        new URL('http://localhost/api/content/transfer'),
        paths,
        {
          copyContent: copyAfterUnrelatedMutation,
          createContentTransferRuntime: () => createContentTransferRuntime({ paths }),
        },
        observedBody(source, destination, 'command', 'copy-me'),
      );

      expect(result).toMatchObject({
        status: 409,
        body: { error: { code: 'STALE_REVISION' } },
      });
      expect(await capturePathIdentity(paths.envDir('destination'))).toEqual(destinationBefore);
      expect((await readState(paths)).commands).toEqual([]);
      expect(await readdir(join(paths.live, 'commands')).catch(() => [])).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
