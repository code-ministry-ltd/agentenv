import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function launchUrlFrom(child: ChildProcess): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let output = '';
    const fail = (error: Error): void => {
      clearTimeout(timeout);
      reject(error);
    };
    const timeout = setTimeout(() => fail(new Error('UI test server did not start')), 10_000);
    child.once('error', fail);
    child.once('exit', (code) => fail(new Error(`UI test server exited early (${code})`)));
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const match = /agentenv UI: (http:\/\/127\.0\.0\.1:\d+\/#launch=[A-Za-z0-9_-]+)/.exec(
        output,
      );
      if (match?.[1] !== undefined) {
        clearTimeout(timeout);
        resolve(match[1]);
      } else if (output.length > 4_096) {
        fail(new Error('UI test server returned an invalid launch response'));
      }
    });
  });
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const server = await startUiTestServer({ fixture: 'authentication', port: 41739 });
  process.env.AGENTENV_UI_TEST_LAUNCH_URL = server.launchUrl;

  return async () => {
    delete process.env.AGENTENV_UI_TEST_LAUNCH_URL;
    await server.close();
  };
}

export interface UiTestServer {
  launchUrl: string;
  close(): Promise<void>;
}

type UiTestHomeFixture = 'authentication' | 'catalog' | 'empty' | 'error';

interface StartUiTestServerOptions {
  fixture: UiTestHomeFixture;
  port?: number;
}

async function seedDetailedEnvironments(home: string): Promise<void> {
  const environments = join(home, 'store', 'environments');
  const writing = join(environments, 'writing');
  const research = join(environments, 'research');
  await mkdir(join(writing, 'skills', 'drafting'), { recursive: true });
  await mkdir(join(writing, 'skills', 'reviewing'), { recursive: true });
  await mkdir(join(writing, 'instructions'), { recursive: true });
  await mkdir(join(writing, 'mcp'), { recursive: true });
  await mkdir(join(writing, 'agents'), { recursive: true });
  await mkdir(join(writing, 'commands'), { recursive: true });
  await mkdir(research, { recursive: true });
  await writeFile(join(writing, 'env.yaml'), 'version: "1.0"\ndescription: Daily writing tools.\n');
  await writeFile(join(research, 'env.yaml'), 'version: "1.0"\ndescription: Source gathering.\n');
  await writeFile(join(writing, 'skills', 'drafting', 'SKILL.md'), '# drafting\n');
  await writeFile(join(writing, 'skills', 'reviewing', 'SKILL.md'), '# reviewing\n');
  await writeFile(join(writing, 'instructions', 'base.md'), '# instructions\n');
  await writeFile(
    join(writing, 'mcp', 'servers.yaml'),
    'linear:\n  transport: stdio\n  command: linear\nnotion:\n  transport: http\n  url: https://example.invalid\n',
  );
  await writeFile(join(writing, 'agents', 'editor.md'), '# editor\n');
  await writeFile(join(writing, 'commands', 'publish.md'), '# publish\n');
  await writeFile(
    join(home, 'sessions.json'),
    `${JSON.stringify({
      version: '1.0',
      bindings: [{
        session: 'browser-test',
        projectRoot: join(home, 'project'),
        envs: ['writing'],
        createdAt: 1,
      }],
    }, null, 2)}\n`,
  );
}

async function seedCatalogBoundary(home: string): Promise<void> {
  await seedDetailedEnvironments(home);
  const environments = join(home, 'store', 'environments');
  await Promise.all(
    Array.from({ length: 99 }, (_, index) => 98 - index).map(async (index) => {
      const environment = join(environments, `catalog-${String(index).padStart(3, '0')}`);
      await mkdir(environment, { recursive: true });
      await writeFile(
        join(environment, 'env.yaml'),
        `version: "1.0"\ndescription: Catalogue fixture ${index}.\n`,
      );
    }),
  );
}

async function seedRequestError(home: string): Promise<void> {
  const environment = join(home, 'store', 'environments', 'broken');
  await mkdir(environment, { recursive: true });
  await writeFile(join(environment, 'env.yaml'), 'version: [\n');
}

async function seedFixture(home: string, fixture: UiTestHomeFixture): Promise<void> {
  if (fixture === 'authentication') await seedDetailedEnvironments(home);
  if (fixture === 'catalog') await seedCatalogBoundary(home);
  if (fixture === 'error') await seedRequestError(home);
}

export async function startUiTestServer(
  options: StartUiTestServerOptions,
): Promise<UiTestServer> {
  const home = await mkdtemp(join(tmpdir(), `agentenv-ui-${options.fixture}-e2e-`));
  await seedFixture(home, options.fixture);
  const child = spawn(
    process.execPath,
    [
      'dist/bin.js',
      'ui',
      '--no-open',
      ...(options.port === undefined ? [] : ['--port', String(options.port)]),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AGENTENV_HOME: home,
        HOME: home,
        USERPROFILE: home,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  try {
    const launchUrl = await launchUrlFrom(child);
    let closePromise: Promise<void> | undefined;
    return {
      launchUrl,
      close: () => {
        closePromise ??= (async () => {
          if (child.exitCode === null) {
            const exited = once(child, 'exit');
            child.kill('SIGTERM');
            await exited;
          }
          await rm(home, { recursive: true, force: true });
        })();
        return closePromise;
      },
    };
  } catch (error) {
    child.kill('SIGKILL');
    await rm(home, { recursive: true, force: true });
    throw error;
  }
}
