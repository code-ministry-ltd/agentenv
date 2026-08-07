import { constants } from 'node:fs';
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
  readSkillDocument,
  type SkillDocumentFileSystem,
} from '../src/application/skill-document.js';
import { capturePathIdentity } from '../src/path-identity.js';
import { resolvePaths, type Paths } from '../src/paths.js';
import type { Revision } from '../src/ui/contract.js';
import { startUiServer, type UiServerHandle } from '../src/ui/server.js';

const SOURCE = '# Exact source\n\n<script>alert(1)</script>\n';
const csrfByServer = new WeakMap<UiServerHandle, string>();

async function authenticatedCookie(server: UiServerHandle): Promise<string> {
  const launch = new URL(server.launchUrl);
  const response = await fetch(`${server.origin}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.origin },
    body: JSON.stringify({
      launchToken: new URLSearchParams(launch.hash.slice(1)).get('launch'),
    }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { data: { csrfToken: string } };
  csrfByServer.set(server, body.data.csrfToken);
  return response.headers.get('set-cookie')!;
}

describe('skill document loading', () => {
  let home: string;
  let paths: Paths;
  let server: UiServerHandle | undefined;
  let documentPath: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'agentenv-skill-document-'));
    paths = resolvePaths({ AGENTENV_HOME: home });
    const skill = join(paths.envDir('writing'), 'skills', 'research');
    documentPath = join(skill, 'SKILL.md');
    await mkdir(skill, { recursive: true });
    await writeFile(documentPath, SOURCE, 'utf8');
  });

  afterEach(async () => {
    await server?.close();
    await rm(home, { recursive: true, force: true });
  });

  it('reads only one exact SKILL.md with a deterministic identity-bearing revision', async () => {
    const before = await capturePathIdentity(home);
    const first = await readSkillDocument({ paths, environment: 'writing', skill: 'research' });
    const second = await readSkillDocument({ paths, environment: 'writing', skill: 'research' });

    expect(first).toMatchObject({
      status: 'loaded',
      document: {
        environment: 'writing',
        skill: 'research',
        text: SOURCE,
        revision: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      },
    });
    expect(second).toEqual(first);
    expect(JSON.stringify(first)).not.toContain(home);
    expect(await capturePathIdentity(home)).toEqual(before);

    await chmod(documentPath, 0o600);
    const modeChanged = await readSkillDocument({ paths, environment: 'writing', skill: 'research' });
    expect(modeChanged.status).toBe('loaded');
    if (first.status === 'loaded' && modeChanged.status === 'loaded') {
      expect(modeChanged.document.revision).not.toBe(first.document.revision);
    }
  });

  it('validates runtime types and exact names before constructing or reading a path', async () => {
    const unreadablePaths = {
      ...paths,
      store: 'relative-store',
      environments: 'relative-environments',
    };
    for (const [environment, skill, field] of [
      [42, 'research', 'environment'],
      ['../writing', 'research', 'environment'],
      ['writing', null, 'skill'],
      ['writing', '../research', 'skill'],
      ['writing', 'Research', 'skill'],
    ] as const) {
      await expect(readSkillDocument({
        paths: unreadablePaths,
        environment,
        skill,
      })).resolves.toEqual({ status: 'invalid', field });
    }
  });

  it('returns typed missing and unsafe outcomes without following links or changing targets', async () => {
    await expect(readSkillDocument({ paths, environment: 'writing', skill: 'missing' }))
      .resolves.toEqual({ status: 'not-found' });

    const external = join(home, 'private.md');
    const privateText = 'PRIVATE-CONTENT';
    await writeFile(external, privateText, 'utf8');
    await rm(documentPath);
    await symlink(external, documentPath);
    const beforeExternal = await capturePathIdentity(external);
    const linkedFile = await readSkillDocument({
      paths,
      environment: 'writing',
      skill: 'research',
    });
    expect(linkedFile).toEqual({ status: 'unsafe' });
    expect(JSON.stringify(linkedFile)).not.toContain(external);
    expect(await readFile(external, 'utf8')).toBe(privateText);
    expect(await capturePathIdentity(external)).toEqual(beforeExternal);

    await rm(join(paths.envDir('writing'), 'skills', 'research'), { recursive: true });
    const externalSkill = join(home, 'outside-skill');
    await mkdir(externalSkill);
    await writeFile(join(externalSkill, 'SKILL.md'), privateText, 'utf8');
    await symlink(externalSkill, join(paths.envDir('writing'), 'skills', 'research'));
    await expect(readSkillDocument({ paths, environment: 'writing', skill: 'research' }))
      .resolves.toEqual({ status: 'unsafe' });
    expect(await readFile(join(externalSkill, 'SKILL.md'), 'utf8')).toBe(privateText);
  });

  it('rejects a symlink at every environment-to-document ancestor boundary', async () => {
    for (const boundary of ['environments', 'environment', 'skills', 'skill'] as const) {
      await rm(paths.environments, { recursive: true, force: true });
      const environment = paths.envDir('writing');
      const skills = join(environment, 'skills');
      const skill = join(skills, 'research');
      const skillDocument = join(skill, 'SKILL.md');
      await mkdir(skill, { recursive: true });
      await writeFile(skillDocument, SOURCE, 'utf8');
      const target = boundary === 'environments'
        ? paths.environments
        : boundary === 'environment'
          ? environment
          : boundary === 'skills'
            ? skills
            : skill;
      const external = join(home, `outside-${boundary}`);
      await rename(target, external);
      await symlink(external, target);

      await expect(readSkillDocument({ paths, environment: 'writing', skill: 'research' }))
        .resolves.toEqual({ status: 'unsafe' });
      const externalDocument = boundary === 'environments'
        ? join(external, 'writing', 'skills', 'research', 'SKILL.md')
        : boundary === 'environment'
          ? join(external, 'skills', 'research', 'SKILL.md')
          : boundary === 'skills'
            ? join(external, 'research', 'SKILL.md')
            : join(external, 'SKILL.md');
      expect(await readFile(externalDocument, 'utf8')).toBe(SOURCE);
    }
  });

  it('detects a same-content file entry replacement during its stable read', async () => {
    let documentLstatCount = 0;
    const racedFileSystem: SkillDocumentFileSystem = {
      open,
      async lstat(path, options) {
        if (path === documentPath) {
          documentLstatCount += 1;
          if (documentLstatCount === 1) {
            await rename(documentPath, `${documentPath}.old`);
            await writeFile(documentPath, SOURCE, 'utf8');
          }
        }
        return await lstat(path, options);
      },
    };

    await expect(readSkillDocument(
      { paths, environment: 'writing', skill: 'research' },
      { fileSystem: racedFileSystem },
    )).resolves.toEqual({ status: 'stale' });
    expect(await readFile(documentPath, 'utf8')).toBe(SOURCE);
    expect(await readFile(`${documentPath}.old`, 'utf8')).toBe(SOURCE);
  });

  it('detects a same-content descriptor write race between its two fstat checks', async () => {
    const racedFileSystem: SkillDocumentFileSystem = {
      lstat,
      async open(path, flags) {
        const handle = await open(path, flags);
        let statCount = 0;
        return new Proxy(handle, {
          get(target, property) {
            if (property === 'stat') {
              return async (options: { bigint: true }) => {
                statCount += 1;
                if (statCount === 2) await writeFile(documentPath, SOURCE, 'utf8');
                return await target.stat(options);
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === 'function'
              ? (value as (...arguments_: unknown[]) => unknown).bind(target)
              : value;
          },
        });
      },
    };

    await expect(readSkillDocument(
      { paths, environment: 'writing', skill: 'research' },
      { fileSystem: racedFileSystem },
    )).resolves.toEqual({ status: 'stale' });
    expect(await readFile(documentPath, 'utf8')).toBe(SOURCE);
  });

  it('refuses a directory or unreadable special entry as a document', async () => {
    await rm(documentPath);
    await mkdir(documentPath);
    await expect(readSkillDocument({ paths, environment: 'writing', skill: 'research' }))
      .resolves.toEqual({ status: 'unsafe' });

    await rm(documentPath, { recursive: true });
    await writeFile(documentPath, SOURCE);
    const failingFileSystem: SkillDocumentFileSystem = {
      lstat,
      async open(path, flags) {
        if (path === documentPath && (flags & constants.O_NOFOLLOW) !== 0) {
          const error = new Error('private /filesystem/failure') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        return await open(path, flags);
      },
    };
    const result = await readSkillDocument(
      { paths, environment: 'writing', skill: 'research' },
      { fileSystem: failingFileSystem },
    );
    expect(result).toEqual({ status: 'failure' });
    expect(JSON.stringify(result)).not.toContain('/filesystem/failure');
    expect(await readFile(documentPath, 'utf8')).toBe(SOURCE);
  });

  it('serves the exact document through an authenticated GET contract', async () => {
    server = await startUiServer({ paths, installSignalHandlers: false });
    const unauthenticated = await fetch(
      `${server.origin}/api/environments/writing/skills/research/document`,
    );
    expect(unauthenticated.status).toBe(401);

    const cookie = await authenticatedCookie(server);
    const response = await fetch(
      `${server.origin}/api/environments/writing/skills/research/document`,
      { headers: { cookie } },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      data: {
        environment: 'writing',
        skill: 'research',
        text: SOURCE,
        revision: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      },
    });
  });

  it('enforces exact GET path/query/method rules and redacts every error response', async () => {
    const privatePath = join(home, 'private', 'SKILL.md');
    const privateText = 'PRIVATE-SKILL-TEXT';
    const resultBySkill = new Map<string, Awaited<ReturnType<typeof readSkillDocument>>>([
      ['unsafe', { status: 'unsafe' }],
      ['stale', { status: 'stale' }],
      ['failure', { status: 'failure' }],
      ['missing', { status: 'not-found' }],
    ]);
    server = await startUiServer({
      paths,
      installSignalHandlers: false,
      routeDependencies: {
        readSkillDocument: async (input) => resultBySkill.get(String(input.skill)) ?? {
          status: 'loaded',
          document: {
            environment: input.environment as never,
            skill: input.skill as never,
            revision: 'a'.repeat(43) as Revision,
            text: privateText,
          },
        },
      },
    });
    const cookie = await authenticatedCookie(server);
    const get = async (path: string, method = 'GET'): Promise<Response> => await fetch(
      `${server!.origin}${path}`,
      { method, headers: { cookie } },
    );

    for (const [path, expected, error] of [
      ['/api/environments/writing/skills/missing/document', 404, {
        code: 'NOT_FOUND', message: 'The skill document was not found.',
      }],
      ['/api/environments/writing/skills/unsafe/document', 404, {
        code: 'NOT_FOUND', message: 'The skill document was not found.',
      }],
      ['/api/environments/writing/skills/stale/document', 409, {
        code: 'STALE_REVISION', message: 'The skill document changed while it was loading.',
      }],
      ['/api/environments/writing/skills/failure/document', 500, {
        code: 'INTERNAL_ERROR', message: 'The skill document could not be loaded.',
      }],
      ['/api/environments/WRITING/skills/research/document', 400, {
        code: 'MALFORMED_REQUEST', message: 'The skill document locator is malformed.',
      }],
      ['/api/environments/writing/skills/Research/document', 400, {
        code: 'MALFORMED_REQUEST', message: 'The skill document locator is malformed.',
      }],
      ['/api/environments/writing/skills/research/document?extra=1', 400, {
        code: 'MALFORMED_REQUEST', message: 'The request query is malformed.',
      }],
    ] as const) {
      const response = await get(path);
      expect(response.status, path).toBe(expected);
      const responseBody = await response.json();
      expect(responseBody).toEqual({ error });
      const body = JSON.stringify(responseBody);
      expect(body).not.toContain(home);
      expect(body).not.toContain(privatePath);
      expect(body).not.toContain(privateText);
      expect(body).not.toContain('unsafe');
      expect(body).not.toContain('failure');
    }

    const wrongMethod = await fetch(
      `${server.origin}/api/environments/writing/skills/research/document`,
      {
        method: 'POST',
        headers: {
          cookie,
          origin: server.origin,
          'x-agentenv-csrf': csrfByServer.get(server)!,
        },
      },
    );
    expect(wrongMethod.status).toBe(405);
    expect(JSON.stringify(await wrongMethod.json())).not.toContain(privateText);
  });
});
