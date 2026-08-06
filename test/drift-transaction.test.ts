import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { defaultGitRunner, type GitRunner } from '../src/git.js';
import { resolvePaths } from '../src/paths.js';
import { readState } from '../src/state.js';
import { FIXTURE_CONFIG_ENV, makeFixtureAdapter } from './fixtures/fixture-adapter.js';
import { makeTempHome, type TempHome } from './helpers.js';

const homes: TempHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.cleanup();
});

describe('whole-sweep drift transaction', () => {
  it('publishes store, surface, and state drift together and retains failed Git work', async () => {
    const home = makeTempHome({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' });
    homes.push(home);
    const paths = resolvePaths(home.env);
    const realRoot = join(home.home, 'real');
    mkdirSync(realRoot, { recursive: true });
    writeFileSync(join(realRoot, 'INSTRUCTIONS.md'), '# user\n');
    writeFileSync(join(realRoot, 'config.json'), '{}\n');
    const env = { ...home.env, [FIXTURE_CONFIG_ENV]: realRoot };
    const adapters = [makeFixtureAdapter()];
    await run(['init'], { env, adapters });
    await run(['create', 'writing'], { env, adapters });
    mkdirSync(join(paths.envDir('writing'), 'instructions'), { recursive: true });
    writeFileSync(join(paths.envDir('writing'), 'instructions', 'base.md'), 'ORIGINAL body\n');
    mkdirSync(join(paths.envDir('writing'), 'mcp'), { recursive: true });
    const canonical =
      'linear:\n  url: https://original\n  env:\n    TOKEN: "${GH_TOKEN}"\n';
    const servers = join(paths.envDir('writing'), 'mcp', 'servers.yaml');
    writeFileSync(servers, canonical);
    execFileSync('git', ['add', '-A'], { cwd: paths.store, env });
    execFileSync('git', [
      '-c', 'user.name=test', '-c', 'user.email=test@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture content',
    ], { cwd: paths.store, env });
    await run(['use', 'writing', '--global'], { env, adapters });

    const instructions = join(realRoot, 'INSTRUCTIONS.md');
    writeFileSync(instructions, readFileSync(instructions, 'utf8').replace('ORIGINAL body', 'EDITED body'));
    const config = JSON.parse(readFileSync(join(realRoot, 'config.json'), 'utf8'));
    config.mcpServers.linear.url = 'https://edited';
    config.mcpServers.linear.env.TOKEN = 'ghp_DO_NOT_PERSIST_LITERAL_123456789';
    writeFileSync(join(realRoot, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
    const failDriftCommit: GitRunner = (args, opts) =>
      args.includes('commit') && args.includes('agentenv: sync drift')
        ? Promise.resolve({ code: 1, stdout: '', stderr: 'drift commit failed', timedOut: false })
        : defaultGitRunner(args, opts);

    const blocked = await run(['list'], { env, adapters, gitRun: failDriftCommit });
    expect(blocked.code).toBe(2);
    expect(readFileSync(join(paths.envDir('writing'), 'instructions', 'base.md'), 'utf8'))
      .toContain('EDITED body');
    expect(readFileSync(servers, 'utf8')).toBe(canonical);
    const sanitised = readFileSync(join(realRoot, 'config.json'), 'utf8');
    expect(sanitised).toContain('${GH_TOKEN}');
    expect(sanitised).not.toContain('DO_NOT_PERSIST');
    expect((await readState(paths)).commands[0]).toMatchObject({
      kind: 'drift-sweep',
      phase: 'git-pending',
      commitPoint: true,
    });

    const recovered = await run(['shell-init'], { env, adapters });
    expect(recovered.code).toBe(0);
    expect((await readState(paths)).commands).toEqual([]);
    expect(execFileSync('git', ['log', '-1', '--format=%s'], {
      cwd: paths.store,
      env,
      encoding: 'utf8',
    }).trim()).toBe('agentenv: sync drift');
  });
});
