import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeAdapter } from '../src/adapters/claude.js';
import { resolvePaths } from '../src/paths.js';
import { composeView } from '../src/session/composer.js';
import { makeTempHome, type TempHome } from './helpers.js';

const homes: TempHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.cleanup();
});

describe('Claude Adapter v2 session composition', () => {
  it('builds an additional-directory view and leaves the real auth/static layer out', async () => {
    const th = makeTempHome();
    homes.push(th);
    const paths = resolvePaths(th.env);
    const realRoot = join(th.home, '.claude');
    mkdirSync(join(realRoot, 'skills', 'user-skill'), { recursive: true });
    writeFileSync(join(realRoot, 'skills', 'user-skill', 'SKILL.md'), '# user\n');
    writeFileSync(join(realRoot, '.credentials.json'), '{"oauth":"real"}\n');

    const envRoot = paths.envDir('writing');
    mkdirSync(join(envRoot, 'skills', 'env-skill'), { recursive: true });
    writeFileSync(join(envRoot, 'skills', 'env-skill', 'SKILL.md'), '# env\n');
    mkdirSync(join(envRoot, 'agents'), { recursive: true });
    writeFileSync(join(envRoot, 'agents', 'reviewer.md'), '# reviewer\n');
    mkdirSync(join(envRoot, 'commands'), { recursive: true });
    writeFileSync(join(envRoot, 'commands', 'ship.md'), '# ship\n');
    mkdirSync(join(envRoot, 'instructions'), { recursive: true });
    writeFileSync(join(envRoot, 'instructions', 'base.md'), '# environment instructions\n');
    mkdirSync(join(envRoot, 'mcp'), { recursive: true });
    writeFileSync(
      join(envRoot, 'mcp', 'servers.yaml'),
      'linear:\n  transport: http\n  url: https://mcp.linear.invalid/mcp\n',
    );

    const result = await composeView({
      paths,
      adapter: claudeAdapter,
      envs: ['writing'],
      session: 'claude-v2',
      realConfigRoot: realRoot,
      projectRoot: '/project',
      env: th.env,
    });

    expect(existsSync(join(result.viewRoot, '.claude', 'skills', 'env-skill'))).toBe(true);
    expect(existsSync(join(result.viewRoot, '.claude', 'agents', 'reviewer.md'))).toBe(true);
    expect(existsSync(join(result.viewRoot, '.claude', 'commands', 'ship.md'))).toBe(true);
    expect(readFileSync(join(result.viewRoot, 'CLAUDE.md'), 'utf8')).toContain(
      'environment instructions',
    );
    const mcp = JSON.parse(readFileSync(join(result.viewRoot, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.linear.url).toBe('https://mcp.linear.invalid/mcp');

    expect(existsSync(join(result.viewRoot, '.credentials.json'))).toBe(false);
    expect(existsSync(join(result.viewRoot, '.claude', 'skills', 'user-skill'))).toBe(false);
    expect(existsSync(join(result.viewRoot, '.claude.json'))).toBe(false);
  });
});
