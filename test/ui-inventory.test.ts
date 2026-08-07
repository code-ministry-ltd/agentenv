import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CatalogMcpSourceError,
  CatalogStaleRevisionError,
  getEnvironmentInventory,
  listEnvironmentSummaries,
} from '../src/application/catalog.js';
import { capturePathIdentity } from '../src/path-identity.js';
import { resolvePaths, type Paths } from '../src/paths.js';
import type { EnvironmentInventory } from '../src/ui/contract.js';
import { startUiServer, type UiServerHandle } from '../src/ui/server.js';

async function authenticatedCookie(server: UiServerHandle): Promise<string> {
  const launchUrl = new URL(server.launchUrl);
  const launchToken = new URLSearchParams(launchUrl.hash.slice(1)).get('launch');
  const response = await fetch(`${server.origin}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.origin },
    body: JSON.stringify({ launchToken }),
  });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!;
}

async function seedInventory(paths: Paths, privatePath: string): Promise<void> {
  const environment = paths.envDir('writing');
  await Promise.all([
    mkdir(join(environment, 'skills', 'research'), { recursive: true }),
    mkdir(join(environment, 'skills', 'plain'), { recursive: true }),
    mkdir(join(environment, 'instructions'), { recursive: true }),
    mkdir(join(environment, 'mcp'), { recursive: true }),
    mkdir(join(environment, 'agents'), { recursive: true }),
    mkdir(join(environment, 'commands'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      paths.envYaml('writing'),
      [
        'version: "1.0"',
        'description: Daily writing tools.',
        'sources:',
        '  research:',
        '    repo: https://reader:super-secret@example.com/org/private.git?token=hidden',
        '    path: skills/research',
        '    ref: main',
        '    commit: abcdef1234567890abcdef1234567890abcdef12',
        '    hash: content-hash-sensitive',
        '  plain:',
        `    repo: file://${privatePath}`,
        '    path: skills/plain',
        '    ref: local',
        '    commit: 1234567890abcdef1234567890abcdef12345678',
        '    hash: another-private-hash',
        '',
      ].join('\n'),
      'utf8',
    ),
    writeFile(
      join(environment, 'skills', 'research', 'SKILL.md'),
      '---\nname: research\ndescription: Gather trustworthy sources.\n---\n\n# Research\n',
      'utf8',
    ),
    writeFile(join(environment, 'skills', 'plain', 'SKILL.md'), '# Plain\n', 'utf8'),
    writeFile(join(environment, 'instructions', 'base.md'), '# Base\n', 'utf8'),
    writeFile(join(environment, 'instructions', 'codex.md'), '# Codex\n', 'utf8'),
    writeFile(
      join(environment, 'mcp', 'servers.yaml'),
      [
        'browser:',
        '  transport: sse',
        '  url: https://example.invalid/sse',
        'linear:',
        '  transport: stdio',
        '  command: linear',
        'mystery:',
        '  transport: websocket',
        '',
      ].join('\n'),
      'utf8',
    ),
    writeFile(join(environment, 'agents', 'editor.md'), '# Editor\n', 'utf8'),
    writeFile(join(environment, 'commands', 'publish.md'), '# Publish\n', 'utf8'),
  ]);
}

describe('read-only environment inventory', () => {
  let home: string;
  let paths: Paths;
  let server: UiServerHandle | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'agentenv-ui-inventory-'));
    paths = resolvePaths({ AGENTENV_HOME: home });
    await seedInventory(paths, join(home, 'private-repository'));
  });

  afterEach(async () => {
    await server?.close();
    await rm(home, { recursive: true, force: true });
  });

  it('reports every content item with safe metadata and stable opaque revisions', async () => {
    const beforeStore = await capturePathIdentity(paths.store);
    const beforeState = await capturePathIdentity(paths.state);

    const inventory = await getEnvironmentInventory({ paths, name: 'writing' });

    expect(inventory).toMatchObject({
      name: 'writing',
      description: 'Daily writing tools.',
      active: false,
      counts: { skill: 2, instruction: 2, mcp: 3, agent: 1, command: 1 },
    });
    expect(inventory.items.map((item) => `${item.kind}:${item.name}`)).toEqual([
      'skill:plain',
      'skill:research',
      'instruction:base',
      'instruction:codex',
      'mcp:browser',
      'mcp:linear',
      'mcp:mystery',
      'agent:editor',
      'command:publish',
    ]);
    expect(inventory.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'skill',
        name: 'research',
        description: 'Gather trustworthy sources.',
        source: {
          repository: 'https://example.com/org/private.git',
          path: 'skills/research',
          ref: 'main',
          shortCommit: 'abcdef1',
        },
      }),
      expect.objectContaining({
        kind: 'skill',
        name: 'plain',
        source: {
          repository: 'Local repository',
          path: 'skills/plain',
          ref: 'local',
          shortCommit: '1234567',
        },
      }),
      expect.objectContaining({ kind: 'instruction', name: 'base', scope: 'base' }),
      expect.objectContaining({
        kind: 'instruction',
        name: 'codex',
        scope: 'harness',
        harness: 'codex',
      }),
      expect.objectContaining({ kind: 'mcp', name: 'browser', transport: 'sse' }),
      expect.objectContaining({ kind: 'mcp', name: 'linear', transport: 'stdio' }),
      expect.objectContaining({ kind: 'mcp', name: 'mystery', transport: 'unknown' }),
    ]));
    expect(inventory.revision).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    for (const item of inventory.items) {
      expect(item.revision).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    }
    const serialized = JSON.stringify(inventory);
    expect(serialized).not.toContain(home);
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('token=hidden');
    expect(serialized).not.toContain('content-hash-sensitive');
    expect(serialized).not.toContain('abcdef1234567890abcdef1234567890abcdef12');
    expect(await capturePathIdentity(paths.store)).toEqual(beforeStore);
    expect(await capturePathIdentity(paths.state)).toEqual(beforeState);
  });

  it('redacts hostile repository paths while preserving exact owner/repo shorthand', async () => {
    const configPath = paths.envYaml('writing');
    const original = await readFile(configPath, 'utf8');
    const localRepository = `file://${join(home, 'private-repository')}`;

    for (const [repository, expected] of [
      ['code-ministry/toolbox', 'code-ministry/toolbox'],
      ['../../Users/name/private', 'Remote repository'],
      ['Users/name/repo', 'Remote repository'],
    ] as const) {
      await writeFile(configPath, original.replace(localRepository, repository), 'utf8');

      const inventory = await getEnvironmentInventory({ paths, name: 'writing' });
      const plain = inventory.items.find((item) => item.kind === 'skill' && item.name === 'plain');

      expect(plain).toMatchObject({ source: { repository: expected } });
      if (expected === 'Remote repository') {
        expect(JSON.stringify(inventory)).not.toContain(repository);
      }
    }
  });

  it('invalidates MCP item revisions for canonical byte and mode-only changes', async () => {
    const canonical = join(paths.envDir('writing'), 'mcp', 'servers.yaml');
    await chmod(canonical, 0o640);
    const original = await readFile(canonical, 'utf8');
    const initial = await getEnvironmentInventory({ paths, name: 'writing' });
    const initialMcp = initial.items.filter((item) => item.kind === 'mcp');
    expect(new Set(initialMcp.map((item) => item.revision)).size).toBe(3);

    await writeFile(canonical, `# formatting-only change\n${original}`, { mode: 0o640 });
    const reformatted = await getEnvironmentInventory({ paths, name: 'writing' });
    const reformattedMcp = reformatted.items.filter((item) => item.kind === 'mcp');
    expect(reformattedMcp.map((item) => item.revision)).not.toEqual(
      initialMcp.map((item) => item.revision),
    );
    expect(reformattedMcp.map((item) => item.name)).toEqual(initialMcp.map((item) => item.name));

    await chmod(canonical, 0o600);
    const modeChanged = await getEnvironmentInventory({ paths, name: 'writing' });
    const modeChangedMcp = modeChanged.items.filter((item) => item.kind === 'mcp');
    expect(modeChangedMcp.map((item) => item.revision)).not.toEqual(
      reformattedMcp.map((item) => item.revision),
    );
  });

  it('refuses a symlinked MCP catalogue without exposing or changing its external target', async () => {
    const canonical = join(paths.envDir('writing'), 'mcp', 'servers.yaml');
    const external = join(home, 'private-mcp.yaml');
    const privateServer = 'private-filesystem-server';
    const privateContent = `${privateServer}:\n  transport: stdio\n  command: /Users/name/private/bin\n`;
    await writeFile(external, privateContent, 'utf8');
    await rm(canonical);
    await symlink(external, canonical);
    const beforeExternal = await capturePathIdentity(external);

    for (const readCatalogue of [
      () => getEnvironmentInventory({ paths, name: 'writing' }),
      () => listEnvironmentSummaries({ paths, page: 1, pageSize: 100 }),
    ]) {
      let failure: unknown;
      try {
        await readCatalogue();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(CatalogMcpSourceError);
      const message = String(failure);
      expect(message).not.toContain(external);
      expect(message).not.toContain(privateServer);
      expect(message).not.toContain('/Users/name/private');
    }
    expect(await capturePathIdentity(external)).toEqual(beforeExternal);
    expect(await readFile(external, 'utf8')).toBe(privateContent);
  });

  it('returns only a safe authenticated HTTP error for a symlinked MCP catalogue', async () => {
    const canonical = join(paths.envDir('writing'), 'mcp', 'servers.yaml');
    const external = join(home, 'private-http-mcp.yaml');
    const privateServer = 'private-http-server';
    const privateContent = `${privateServer}:\n  transport: stdio\n  command: /Users/name/private/http-bin\n`;
    await writeFile(external, privateContent, 'utf8');
    await rm(canonical);
    await symlink(external, canonical);
    const beforeExternal = await capturePathIdentity(external);
    const assetsDir = await mkdtemp(join(home, 'assets-'));
    await writeFile(join(assetsDir, 'index.html'), '<h1>inventory fixture</h1>', 'utf8');
    server = await startUiServer({ assetsDir, installSignalHandlers: false, paths });
    const cookie = await authenticatedCookie(server);

    for (const pathname of ['/api/environments/writing', '/api/environments']) {
      const response = await fetch(`${server.origin}${pathname}`, { headers: { cookie } });
      expect(response.status).toBe(500);
      const body = await response.text();
      expect(body).toContain('INTERNAL_ERROR');
      expect(body).not.toContain(external);
      expect(body).not.toContain(privateServer);
      expect(body).not.toContain('/Users/name/private');
    }
    expect(await capturePathIdentity(external)).toEqual(beforeExternal);
    expect(await readFile(external, 'utf8')).toBe(privateContent);
  });

  it('rejects a pathname swapped after the MCP descriptor read without opening its target', async () => {
    const canonical = join(paths.envDir('writing'), 'mcp', 'servers.yaml');
    const displaced = join(paths.envDir('writing'), 'mcp', 'servers.before-swap.yaml');
    const external = join(home, 'private-post-check-mcp.yaml');
    const privateServer = 'private-post-check-server';
    const privateContent = `${privateServer}:\n  transport: stdio\n  command: /Users/name/private/post-check-bin\n`;
    await writeFile(external, privateContent, 'utf8');
    const beforeExternal = await capturePathIdentity(external);
    let openCalls = 0;
    let resolvePostCheckReached: (() => void) | undefined;
    let releasePostCheck: (() => void) | undefined;
    const postCheckReached = new Promise<void>((resolve) => {
      resolvePostCheckReached = resolve;
    });
    const postCheckReleased = new Promise<void>((resolve) => {
      releasePostCheck = resolve;
    });
    const pending = getEnvironmentInventory(
      { paths, name: 'writing' },
      {
        capturePathIdentity,
        mcpFileSystem: {
          open: async (path, flags) => {
            openCalls += 1;
            return await open(path, flags);
          },
          lstat: async (path, options) => {
            resolvePostCheckReached!();
            await postCheckReleased;
            return await lstat(path, options);
          },
        },
      },
    );

    await postCheckReached;
    await rename(canonical, displaced);
    await symlink(external, canonical);
    releasePostCheck!();

    let failure: unknown;
    try {
      await pending;
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(CatalogStaleRevisionError);
    expect(String(failure)).not.toContain(external);
    expect(String(failure)).not.toContain(privateServer);
    expect(String(failure)).not.toContain('/Users/name/private');
    expect(openCalls).toBe(1);
    expect(await capturePathIdentity(external)).toEqual(beforeExternal);
    expect(await readFile(external, 'utf8')).toBe(privateContent);
  });

  it('rejects an inventory assembled across environment revisions', async () => {
    const environment = paths.envDir('writing');
    let environmentCaptures = 0;
    let resolvePostCaptureReached: (() => void) | undefined;
    let releasePostCapture: (() => void) | undefined;
    const postCaptureReached = new Promise<void>((resolve) => {
      resolvePostCaptureReached = resolve;
    });
    const postCaptureReleased = new Promise<void>((resolve) => {
      releasePostCapture = resolve;
    });
    const pending = getEnvironmentInventory(
      { paths, name: 'writing' },
      {
        capturePathIdentity: async (path) => {
          if (path === environment) {
            environmentCaptures += 1;
            if (environmentCaptures === 2) {
              resolvePostCaptureReached!();
              await postCaptureReleased;
            }
          }
          return await capturePathIdentity(path);
        },
      },
    );

    await postCaptureReached;
    await writeFile(join(environment, 'instructions', 'base.md'), '# Changed mid-request\n');
    releasePostCapture!();

    await expect(pending).rejects.toBeInstanceOf(CatalogStaleRevisionError);
    expect(environmentCaptures).toBe(2);
  });

  it('maps typed inventory staleness to a safe conflict through the HTTP route', async () => {
    const assetsDir = await mkdtemp(join(home, 'assets-'));
    await writeFile(join(assetsDir, 'index.html'), '<h1>inventory fixture</h1>', 'utf8');
    server = await startUiServer({
      assetsDir,
      installSignalHandlers: false,
      paths,
      routeDependencies: {
        getEnvironmentInventory: async () => {
          throw new CatalogStaleRevisionError();
        },
      },
    });
    const cookie = await authenticatedCookie(server);

    const response = await fetch(`${server.origin}/api/environments/writing`, {
      headers: { cookie },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: 'STALE_REVISION',
        message: 'The environment changed while its content was loading.',
      },
    });
  });

  it('serves authenticated inventory refreshes without writes and rejects unsafe names', async () => {
    const assetsDir = await mkdtemp(join(home, 'assets-'));
    await writeFile(join(assetsDir, 'index.html'), '<h1>inventory fixture</h1>', 'utf8');
    server = await startUiServer({ assetsDir, installSignalHandlers: false, paths });
    const cookie = await authenticatedCookie(server);
    const beforeStore = await capturePathIdentity(paths.store);
    const beforeState = await capturePathIdentity(paths.state);

    for (let refresh = 0; refresh < 2; refresh += 1) {
      const response = await fetch(`${server.origin}/api/environments/writing`, {
        headers: { cookie },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { data: EnvironmentInventory };
      expect(body.data.items).toHaveLength(9);
      expect(JSON.stringify(body)).not.toContain(home);
    }
    expect(await capturePathIdentity(paths.store)).toEqual(beforeStore);
    expect(await capturePathIdentity(paths.state)).toEqual(beforeState);

    const missing = await fetch(`${server.origin}/api/environments/missing`, {
      headers: { cookie },
    });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('NOT_FOUND');

    const unsafe = await fetch(`${server.origin}/api/environments/Bad%20Name`, {
      headers: { cookie },
    });
    expect(unsafe.status).toBe(400);
    const unsafeBody = await unsafe.text();
    expect(unsafeBody).toContain('MALFORMED_REQUEST');
    expect(unsafeBody).not.toContain('Bad Name');
  });
});
