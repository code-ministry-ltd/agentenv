import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  listEnvironmentSummaries,
  type EnvironmentCatalogPage,
} from '../src/application/catalog.js';
import { scaffoldEnvYaml } from '../src/env-config.js';
import { capturePathIdentity } from '../src/path-identity.js';
import { resolvePaths, type Paths } from '../src/paths.js';
import { setBinding } from '../src/session/registry.js';
import { emptyManifest, writeState } from '../src/state.js';
import { startUiServer, type UiServerHandle } from '../src/ui/server.js';

async function seedEnvironment(
  paths: Paths,
  name: string,
  description: string,
  content: {
    skills?: readonly string[];
    instructions?: readonly string[];
    mcp?: readonly string[];
    agents?: readonly string[];
    commands?: readonly string[];
  } = {},
): Promise<void> {
  const environment = paths.envDir(name);
  await mkdir(environment, { recursive: true });
  await writeFile(paths.envYaml(name), scaffoldEnvYaml({ description }), 'utf8');

  for (const skill of content.skills ?? []) {
    await mkdir(join(environment, 'skills', skill), { recursive: true });
    await writeFile(join(environment, 'skills', skill, 'SKILL.md'), `# ${skill}\n`, 'utf8');
  }
  for (const [kind, names] of [
    ['instructions', content.instructions ?? []],
    ['agents', content.agents ?? []],
    ['commands', content.commands ?? []],
  ] as const) {
    for (const name of names) {
      await mkdir(join(environment, kind), { recursive: true });
      await writeFile(join(environment, kind, `${name}.md`), `# ${name}\n`, 'utf8');
    }
  }
  if ((content.mcp?.length ?? 0) > 0) {
    await mkdir(join(environment, 'mcp'), { recursive: true });
    await writeFile(
      join(environment, 'mcp', 'servers.yaml'),
      content.mcp!.map((name) => `${name}:\n  transport: stdio\n  command: ${name}`).join('\n'),
      'utf8',
    );
  }
}

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

describe('read-only environment catalog', () => {
  let home: string;
  let paths: Paths;
  let server: UiServerHandle | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'agentenv-ui-catalog-'));
    paths = resolvePaths({ AGENTENV_HOME: home });
  });

  afterEach(async () => {
    await server?.close();
    await rm(home, { recursive: true, force: true });
  });

  it('lists every environment once in stable pages with accurate summaries', async () => {
    await seedEnvironment(paths, 'zeta', 'Last and inactive.');
    await seedEnvironment(paths, 'alpha', 'First and session-active.', {
      skills: ['drafting', 'research'],
      instructions: ['base'],
      mcp: ['linear', 'notion'],
      agents: ['reviewer'],
      commands: ['publish'],
    });
    await seedEnvironment(paths, 'gamma', 'Active through retained ownership.');
    await seedEnvironment(paths, 'beta', 'Active in the global stack.');

    const manifest = emptyManifest();
    manifest.globalStack = ['beta'];
    manifest.items.push({
      action: 'symlink',
      surface: 'dir-merge',
      path: join(home, 'temporary-surface'),
      ownerEnv: 'gamma',
    });
    await writeState(paths, manifest);
    await setBinding(paths, {
      session: 'catalog-test',
      projectRoot: join(home, 'project'),
      envs: ['alpha'],
    });

    const first = await listEnvironmentSummaries({ paths, page: 1, pageSize: 2 });
    const second = await listEnvironmentSummaries({ paths, page: 2, pageSize: 2 });

    expect([...first.items, ...second.items].map((item) => item.name)).toEqual([
      'alpha',
      'beta',
      'gamma',
      'zeta',
    ]);
    expect(first.page).toEqual({ page: 1, pageSize: 2, totalItems: 4, totalPages: 2 });
    expect(first.items[0]).toMatchObject({
      name: 'alpha',
      description: 'First and session-active.',
      active: true,
      counts: { skill: 2, instruction: 1, mcp: 2, agent: 1, command: 1 },
    });
    expect(second.items).toMatchObject([
      { name: 'gamma', active: true },
      { name: 'zeta', active: false },
    ]);
    for (const item of [...first.items, ...second.items]) {
      expect(item.revision).toMatch(/^[A-Za-z0-9_-]{32,}$/);
      expect(item.revision).not.toContain(home);
    }

    const priorRevision = first.items[0]!.revision;
    await writeFile(join(paths.envDir('alpha'), 'instructions', 'base.md'), '# changed\n');
    const changed = await listEnvironmentSummaries({ paths, page: 1, pageSize: 2 });
    expect(changed.items[0]!.revision).not.toBe(priorRevision);
  });

  it('returns an empty first page without creating a store', async () => {
    expect(await capturePathIdentity(paths.store)).toEqual({ kind: 'absent' });

    const page = await listEnvironmentSummaries({ paths, page: 1, pageSize: 25 });

    expect(page).toEqual({
      items: [],
      page: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 },
    });
    expect(await capturePathIdentity(paths.store)).toEqual({ kind: 'absent' });
  });

  it('serves authenticated pagination and rejects malformed query bounds safely', async () => {
    await seedEnvironment(paths, 'beta', 'Second.');
    await seedEnvironment(paths, 'alpha', 'First.');
    const assetsDir = await mkdtemp(join(home, 'assets-'));
    await writeFile(join(assetsDir, 'index.html'), '<h1>catalog fixture</h1>', 'utf8');
    server = await startUiServer({ assetsDir, installSignalHandlers: false, paths });
    const cookie = await authenticatedCookie(server);
    const beforeBrowse = await capturePathIdentity(home);

    const success = await fetch(`${server.origin}/api/environments?page=2&pageSize=1`, {
      headers: { cookie },
    });
    expect(success.status).toBe(200);
    const body = (await success.json()) as { data: EnvironmentCatalogPage };
    expect(body.data).toMatchObject({
      items: [{ name: 'beta', description: 'Second.', active: false }],
      page: { page: 2, pageSize: 1, totalItems: 2, totalPages: 2 },
    });
    expect(JSON.stringify(body)).not.toContain(home);
    expect(await capturePathIdentity(home)).toEqual(beforeBrowse);

    for (const query of [
      'page=0',
      'page=1.5',
      'page=10001',
      'page=1&page=2',
      'pageSize=0',
      'pageSize=101',
      'pageSize=ten',
      'sort=%2Fprivate%2Fpath',
    ]) {
      const response = await fetch(`${server.origin}/api/environments?${query}`, {
        headers: { cookie },
      });
      expect(response.status, query).toBe(400);
      const text = await response.text();
      expect(text).toContain('MALFORMED_REQUEST');
      expect(text).not.toContain(home);
      expect(text).not.toContain('/private/path');
    }
  });
});
