import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GitCandidateStore,
  type GitCandidateDiscoveryFunction,
} from '../src/application/git-candidates.js';
import type { GitSkillDiscovery } from '../src/application/git-skill-discovery.js';
import { startUiServer, type UiServerHandle } from '../src/ui/server.js';
import { makeFixtureRepo, makeTempHome, type FixtureRepo } from './helpers.js';

async function waitUntilReady(store: GitCandidateStore, id: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = store.poll(id, 1, 100);
    if (state?.status !== 'PENDING') return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('candidate discovery did not settle');
}

describe('server-owned Git candidate sets', () => {
  const repos: FixtureRepo[] = [];
  const stores: GitCandidateStore[] = [];

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.shutdown()));
    for (const repo of repos.splice(0)) repo.cleanup();
  });

  it('starts immediately and publishes bounded, opaque, exact candidate metadata', async () => {
    const repo = makeFixtureRepo();
    repos.push(repo);
    repo.writeSkill('skills/alpha', { description: 'Alpha does A.' });
    repo.writeSkill('skills/beta', { description: 'Beta does B.' });
    repo.writeSkill('skills/wrong-folder', { name: 'different-name' });
    const commit = repo.commit('candidate set');
    const store = new GitCandidateStore({
      cwd: process.cwd(),
      env: process.env,
      offline: true,
    });
    stores.push(store);

    const pending = store.start(repo.fileUrl('skills'));
    expect(pending).toMatchObject({ status: 'PENDING', phase: 'resolving' });
    expect(pending.candidateSetId).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    const first = await waitUntilReady(store, pending.candidateSetId);
    expect(first?.status).toBe('READY');
    if (first?.status !== 'READY') return;
    expect(first.page).toEqual({ page: 1, pageSize: 100, totalItems: 2, totalPages: 1 });
    expect(first.candidates.map((candidate) => ({
      name: candidate.name,
      description: candidate.description,
      path: candidate.repositoryPath,
      repository: candidate.repository,
      ref: candidate.ref,
      commit: candidate.commit,
    }))).toEqual([
      {
        name: 'alpha',
        description: 'Alpha does A.',
        path: 'skills/alpha',
        repository: repo.fileUrl(),
        ref: 'main',
        commit,
      },
      {
        name: 'beta',
        description: 'Beta does B.',
        path: 'skills/beta',
        repository: repo.fileUrl(),
        ref: 'main',
        commit,
      },
    ]);
    expect(first.candidates.every((candidate) =>
      /^[A-Za-z0-9_-]{20,}$/.test(candidate.candidateId))).toBe(true);
    expect(new Set(first.candidates.map((candidate) => candidate.candidateId)).size).toBe(2);
    expect(JSON.stringify(first)).not.toContain('agentenv-skill-clone-');

    await expect(store.discard(pending.candidateSetId)).resolves.toBe(true);
    expect(store.poll(pending.candidateSetId, 1, 100)).toBeUndefined();
  });

  it('does not block while discovery is pending and releases idle candidate sets', async () => {
    let resolveDiscovery!: (result: Awaited<ReturnType<GitCandidateDiscoveryFunction>>) => void;
    const release = vi.fn(async () => undefined);
    const discovery = {
      source: { repo: 'owner/repo', ref: 'main', commit: 'a'.repeat(40) },
      candidates: [{
        name: 'alpha',
        description: 'Alpha.',
        repoPath: 'skills/alpha',
        validation: { status: 'valid' as const },
      }],
      rootCandidate: undefined,
      candidateDirectory: () => '/private/not-for-browser',
      release,
    } as unknown as GitSkillDiscovery;
    const discover: GitCandidateDiscoveryFunction = () =>
      new Promise((resolve) => { resolveDiscovery = resolve; });
    let now = 1_000;
    const store = new GitCandidateStore({
      cwd: '/work',
      env: {},
      offline: false,
      idleMs: 100,
      now: () => now,
      discover,
    });
    stores.push(store);

    const pending = store.start('owner/repo');
    expect(store.poll(pending.candidateSetId, 1, 10)).toMatchObject({ status: 'PENDING' });
    resolveDiscovery({ status: 'ready', discovery });
    const ready = await waitUntilReady(store, pending.candidateSetId);
    expect(ready?.status).toBe('READY');

    now += 101;
    await store.sweepExpired();
    expect(store.poll(pending.candidateSetId, 1, 10)).toBeUndefined();
    expect(release).toHaveBeenCalledOnce();
  });

  it('turns discovery failures into safe terminal state', async () => {
    const discover: GitCandidateDiscoveryFunction = async () => ({
      status: 'failure',
      kind: 'fetch-failed',
      message: 'secret https://user:password@example.com /private/temp/path',
    });
    const store = new GitCandidateStore({
      cwd: '/work',
      env: {},
      offline: false,
      discover,
    });
    stores.push(store);

    const pending = store.start('owner/repo');
    const failed = await waitUntilReady(store, pending.candidateSetId);
    expect(failed).toMatchObject({
      status: 'FAILED',
      error: {
        code: 'INTERNAL_ERROR',
        message: 'The Git skill source could not be fetched.',
      },
    });
    expect(JSON.stringify(failed)).not.toContain('password');
    expect(JSON.stringify(failed)).not.toContain('/private');
  });
});

describe('Git candidate HTTP routes', () => {
  let server: UiServerHandle | undefined;
  let assetsDir: string | undefined;
  const repos: FixtureRepo[] = [];

  afterEach(async () => {
    await server?.close();
    if (assetsDir !== undefined) await rm(assetsDir, { recursive: true, force: true });
    for (const repo of repos.splice(0)) repo.cleanup();
  });

  it('starts, polls, paginates, and discards an authenticated candidate set', async () => {
    const repo = makeFixtureRepo();
    repos.push(repo);
    repo.writeSkill('skills/alpha');
    repo.writeSkill('skills/beta');
    repo.commit('route candidates');
    const home = makeTempHome();
    assetsDir = await mkdtemp(join(tmpdir(), 'agentenv-git-assets-'));
    await writeFile(join(assetsDir, 'index.html'), '<h1>git candidates</h1>');
    server = await startUiServer({
      assetsDir,
      cwd: process.cwd(),
      env: { ...process.env, ...home.env },
      installSignalHandlers: false,
      runOptions: {
        globals: { json: false, offline: true, verbose: false },
      },
    });

    try {
      const launch = new URL(server.launchUrl);
      const launchToken = new URLSearchParams(launch.hash.slice(1)).get('launch');
      const exchange = await fetch(`${server.origin}/api/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: server.origin },
        body: JSON.stringify({ launchToken }),
      });
      const session = (await exchange.json()) as { data: { csrfToken: string } };
      const cookie = exchange.headers.get('set-cookie')!;
      const mutationHeaders = {
        cookie,
        origin: server.origin,
        'content-type': 'application/json',
        'x-agentenv-csrf': session.data.csrfToken,
      };

      const started = await fetch(`${server.origin}/api/git/candidates`, {
        method: 'POST',
        headers: mutationHeaders,
        body: JSON.stringify({ source: repo.fileUrl('skills') }),
      });
      expect(started.status).toBe(202);
      const pending = (await started.json()) as {
        data: { candidateSetId: string; status: 'PENDING' };
      };
      expect(pending.data.status).toBe('PENDING');

      let terminal: { status: string; page?: { totalItems: number } } | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const response = await fetch(
          `${server.origin}/api/git/candidates/${pending.data.candidateSetId}?page=1&pageSize=1`,
          { headers: { cookie } },
        );
        expect(response.status).toBe(200);
        terminal = ((await response.json()) as { data: typeof terminal }).data;
        if (terminal?.status !== 'PENDING') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(terminal).toMatchObject({ status: 'READY', page: { totalItems: 2 } });

      const second = await fetch(
        `${server.origin}/api/git/candidates/${pending.data.candidateSetId}?page=2&pageSize=1`,
        { headers: { cookie } },
      );
      expect(second.status).toBe(200);
      expect(await second.json()).toMatchObject({
        data: {
          status: 'READY',
          candidates: [{ name: 'beta', repositoryPath: 'skills/beta' }],
        },
      });

      const discarded = await fetch(
        `${server.origin}/api/git/candidates/${pending.data.candidateSetId}`,
        { method: 'DELETE', headers: mutationHeaders },
      );
      expect(discarded.status).toBe(200);
      const missing = await fetch(
        `${server.origin}/api/git/candidates/${pending.data.candidateSetId}`,
        { headers: { cookie } },
      );
      expect(missing.status).toBe(404);
    } finally {
      home.cleanup();
    }
  });
});
