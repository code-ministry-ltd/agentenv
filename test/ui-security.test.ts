import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GitCandidateStore,
  type GitCandidateService,
} from '../src/application/git-candidates.js';
import type { GitSkillDiscovery } from '../src/application/git-skill-discovery.js';
import { resolveSkillSource } from '../src/skill-source.js';
import { startUiServer, type UiServerHandle } from '../src/ui/server.js';
import { makeTempHome, type TempHome } from './helpers.js';

interface Session {
  cookie: string;
  csrf: string;
  launchToken: string;
}

async function authenticate(server: UiServerHandle): Promise<Session> {
  const launchToken = new URLSearchParams(new URL(server.launchUrl).hash.slice(1)).get('launch')!;
  const response = await fetch(`${server.origin}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.origin },
    body: JSON.stringify({ launchToken }),
  });
  const body = await response.json() as { data: { csrfToken: string } };
  return {
    cookie: response.headers.get('set-cookie')!,
    csrf: body.data.csrfToken,
    launchToken,
  };
}

async function statusWithHost(url: string, host: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const outgoing = request(url, { headers: { host } }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    outgoing.once('error', reject);
    outgoing.end();
  });
}

describe('local UI adversarial boundary', () => {
  let assetsDir: string;
  let home: TempHome;
  let server: UiServerHandle | undefined;

  beforeEach(async () => {
    assetsDir = await mkdtemp(join(tmpdir(), 'agentenv-ui-security-'));
    await writeFile(join(assetsDir, 'index.html'), '<h1>security fixture</h1>');
    home = makeTempHome();
  });

  afterEach(async () => {
    await server?.close();
    await rm(assetsDir, { recursive: true, force: true });
    home.cleanup();
  });

  it('binds session mutation to the exact loopback host, origin, and one-time launch token', async () => {
    server = await startUiServer({
      assetsDir,
      env: { ...process.env, ...home.env },
      installSignalHandlers: false,
    });

    expect(await statusWithHost(`${server.origin}/api/session`, 'attacker.invalid')).toBe(403);
    const foreign = await fetch(`${server.origin}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://attacker.invalid' },
      body: JSON.stringify({ launchToken: 'x'.repeat(43) }),
    });
    expect(foreign.status).toBe(403);

    const session = await authenticate(server);
    const replay = await fetch(`${server.origin}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.origin },
      body: JSON.stringify({ launchToken: session.launchToken }),
    });
    expect(replay.status).toBe(401);
    expect(await replay.text()).not.toContain(session.launchToken);

    for (const headers of [
      { cookie: session.cookie, origin: server.origin },
      {
        cookie: session.cookie,
        origin: 'https://attacker.invalid',
        'x-agentenv-csrf': session.csrf,
      },
    ]) {
      const response = await fetch(`${server.origin}/api/git/candidates`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'owner/repo' }),
      });
      expect(response.status).toBe(403);
    }
  });

  it('rejects browser-supplied paths and candidate identity substitution before application code', async () => {
    const take = vi.fn<GitCandidateService['take']>(() => ({ status: 'invalid-selection' }));
    const candidates: GitCandidateService = {
      start: () => { throw new Error('not used'); },
      poll: () => undefined,
      discard: async () => false,
      take,
      shutdown: async () => undefined,
    };
    server = await startUiServer({
      assetsDir,
      env: { ...process.env, ...home.env },
      installSignalHandlers: false,
      routeDependencies: { gitCandidates: candidates },
    });
    const session = await authenticate(server);
    const headers = {
      cookie: session.cookie,
      origin: server.origin,
      'content-type': 'application/json',
      'x-agentenv-csrf': session.csrf,
    };

    const traversal = await fetch(`${server.origin}/assets/%252e%252e%252findex.html`);
    expect(traversal.status).toBe(404);
    const absolutePath = '/private/agentenv-skill-clone-secret/skills/alpha';
    const nominatedPath = await fetch(`${server.origin}/api/git/import`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        candidateSetId: 'A'.repeat(32),
        environment: 'writing',
        selections: [{ candidateId: 'B'.repeat(32), collision: 'skip', sourceDirectory: absolutePath }],
      }),
    });
    expect(nominatedPath.status).toBe(400);
    expect(await nominatedPath.text()).not.toContain(absolutePath);
    expect(take).not.toHaveBeenCalled();

    const substituted = await fetch(`${server.origin}/api/git/import`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        candidateSetId: 'A'.repeat(32),
        environment: 'writing',
        selections: [{ candidateId: 'B'.repeat(32), collision: 'overwrite' }],
      }),
    });
    expect(substituted.status).toBe(400);
    expect(take).toHaveBeenCalledOnce();
  });

  it('normalises repository locators and rejects option-like Git refs', async () => {
    await expect(resolveSkillSource('-c/core.sshCommand=evil')).resolves.toMatchObject({
      repo: '-c/core.sshCommand=evil',
      cloneUrl: 'https://github.com/-c/core.sshCommand=evil.git',
    });
    await expect(resolveSkillSource('owner/repo@--upload-pack=evil')).resolves.toEqual({
      error: "invalid source ref in 'owner/repo@--upload-pack=evil'",
    });
    await expect(
      resolveSkillSource('https://github.com/owner/repo/tree/--upload-pack=evil/skills'),
    ).resolves.toEqual({
      error: "invalid source ref in 'https://github.com/owner/repo/tree/--upload-pack=evil/skills'",
    });
  });

  it('releases server-owned private Git candidates during shutdown', async () => {
    const release = vi.fn(async () => undefined);
    const candidate = {
      name: 'alpha',
      description: 'Alpha.',
      repoPath: 'skills/alpha',
      validation: { status: 'valid' as const },
      contentHash: 'b'.repeat(64),
    };
    const discovery = {
      source: { repo: 'owner/repo', ref: 'main', commit: 'a'.repeat(40) },
      candidates: [candidate],
      rootCandidate: undefined,
      candidateDirectory: () => '/private/agentenv-skill-clone-secret/skills/alpha',
      release,
    } as unknown as GitSkillDiscovery;
    const store = new GitCandidateStore({
      cwd: process.cwd(),
      env: { ...process.env, ...home.env },
      offline: true,
      discover: async () => ({ status: 'ready', discovery }),
    });
    const pending = store.start('owner/repo');
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (store.poll(pending.candidateSetId, 1, 100)?.status === 'READY') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    server = await startUiServer({
      assetsDir,
      env: { ...process.env, ...home.env },
      installSignalHandlers: false,
      routeDependencies: { gitCandidates: store },
    });
    await server.close();
    expect(release).toHaveBeenCalledOnce();
  });
});
