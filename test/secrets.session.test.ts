import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePaths } from '../src/paths.js';
import { writeSecrets } from '../src/secrets.js';
import { composeView } from '../src/session/composer.js';
import { makeFixtureAdapter } from './fixtures/fixture-adapter.js';
import { makeTempHome, type TempHome } from './helpers.js';

/**
 * Task 2.4: the substitute rung (D6) also runs on the SESSION composition path.
 * The private view under `live/` is derived and never synced, so a resolved
 * literal here reaches only the ephemeral view; the store is never touched.
 */

const homes: TempHome[] = [];
function home(): TempHome {
  const h = makeTempHome();
  homes.push(h);
  return h;
}
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
});

function writeServers(envDir: string, yaml: string): void {
  mkdirSync(join(envDir, 'mcp'), { recursive: true });
  writeFileSync(join(envDir, 'mcp', 'servers.yaml'), yaml);
}

describe('secrets session: substitute rung composes literals into the private view', () => {
  it('resolves ${VAR} from secrets.env into the view config, keeping it out of the store', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    await writeSecrets(paths, new Map([['SESSION_TOKEN', 'sess-secret-123']]));
    writeServers(
      paths.envDir('writing'),
      'gh:\n  command: server\n  env:\n    TOKEN: ${SESSION_TOKEN}\n',
    );

    const res = await composeView({
      paths,
      adapter: makeFixtureAdapter({ substituteMcp: true }),
      envs: ['writing'],
      session: 'sess-sub',
      realConfigRoot: join(th.home, 'no-real-root'),
      env: {} as NodeJS.ProcessEnv,
      onWarn: () => {},
    });

    const cfg = JSON.parse(readFileSync(join(res.viewRoot, 'config.json'), 'utf8'));
    expect(cfg.mcpServers.gh.env.TOKEN).toBe('sess-secret-123');
    // The store def is untouched — it still holds the placeholder.
    expect(readFileSync(join(paths.envDir('writing'), 'mcp', 'servers.yaml'), 'utf8')).toContain(
      '${SESSION_TOKEN}',
    );
  });

  it('resolves from the shell env when secrets.env has no entry', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    writeServers(paths.envDir('writing'), 'gh:\n  env:\n    TOKEN: ${SHELL_TOKEN}\n');

    const res = await composeView({
      paths,
      adapter: makeFixtureAdapter({ substituteMcp: true }),
      envs: ['writing'],
      session: 'sess-env',
      realConfigRoot: join(th.home, 'no-real-root'),
      env: { SHELL_TOKEN: 'from-shell' } as NodeJS.ProcessEnv,
      onWarn: () => {},
    });

    const cfg = JSON.parse(readFileSync(join(res.viewRoot, 'config.json'), 'utf8'));
    expect(cfg.mcpServers.gh.env.TOKEN).toBe('from-shell');
  });

  it('invalidates a reused view when a relevant resolved secret changes without persisting it', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    writeServers(paths.envDir('writing'), 'gh:\n  env:\n    TOKEN: ${SESSION_TOKEN}\n');
    await writeSecrets(paths, new Map([['SESSION_TOKEN', 'first-private-value']]));
    const request = {
      paths,
      adapter: makeFixtureAdapter({ substituteMcp: true }),
      envs: ['writing'],
      session: 'sess-secret-stale',
      realConfigRoot: join(th.home, 'no-real-root'),
      env: {} as NodeJS.ProcessEnv,
      onWarn: () => {},
    };

    const first = await composeView(request);
    expect(first.rebuilt).toBe(true);
    await writeSecrets(paths, new Map([['SESSION_TOKEN', 'second-private-value']]));
    const second = await composeView(request);

    expect(second.rebuilt).toBe(true);
    expect(second.generation).toBe(2);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    const cfg = JSON.parse(readFileSync(join(second.viewRoot, 'config.json'), 'utf8'));
    expect(cfg.mcpServers.gh.env.TOKEN).toBe('second-private-value');
    const meta = readFileSync(
      join(paths.live, request.session, `${request.adapter.id}.meta.json`),
      'utf8',
    );
    expect(meta).not.toContain('first-private-value');
    expect(meta).not.toContain('second-private-value');
  });

  it('a passthrough surface keeps the ${VAR} in the view (no substitution)', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    await writeSecrets(paths, new Map([['SESSION_TOKEN', 'sess-secret-123']]));
    writeServers(paths.envDir('writing'), 'gh:\n  env:\n    TOKEN: ${SESSION_TOKEN}\n');

    const res = await composeView({
      paths,
      adapter: makeFixtureAdapter(), // default: passthrough
      envs: ['writing'],
      session: 'sess-pass',
      realConfigRoot: join(th.home, 'no-real-root'),
      env: {} as NodeJS.ProcessEnv,
      onWarn: () => {},
    });

    const cfg = JSON.parse(readFileSync(join(res.viewRoot, 'config.json'), 'utf8'));
    expect(cfg.mcpServers.gh.env.TOKEN).toBe('${SESSION_TOKEN}');
  });

  it('an unresolved ${VAR} skips only that server and warns (fail closed per server)', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    writeServers(
      paths.envDir('writing'),
      ['needs-secret:', '  env:', '    TOKEN: ${MISSING}', 'plain:', '  command: ok', ''].join('\n'),
    );

    const warnings: string[] = [];
    const res = await composeView({
      paths,
      adapter: makeFixtureAdapter({ substituteMcp: true }),
      envs: ['writing'],
      session: 'sess-miss',
      realConfigRoot: join(th.home, 'no-real-root'),
      env: {} as NodeJS.ProcessEnv,
      onWarn: (m) => warnings.push(m),
    });

    const cfg = JSON.parse(readFileSync(join(res.viewRoot, 'config.json'), 'utf8'));
    expect(cfg.mcpServers.plain).toBeDefined();
    expect(cfg.mcpServers['needs-secret']).toBeUndefined();
    expect(warnings.join('\n')).toContain('MISSING');
    expect(res.skipped.some((s) => s.reason === 'secret-unresolved')).toBe(true);
  });
});
