import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { makeTempHome, type TempHome } from './helpers.js';

const homes: TempHome[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) home.cleanup();
});

describe('global activation across the complete adapter registry', () => {
  it('reports intentionally unsupported surfaces without aborting supported adapters', async () => {
    const home = makeTempHome();
    homes.push(home);
    home.env.HOME = `${home.home}/user-home`;
    home.env.USERPROFILE = home.env.HOME;

    expect((await run(['init'], { env: home.env })).code).toBe(0);
    expect((await run(['create', 'work'], { env: home.env })).code).toBe(0);
    expect((await run(['add', 'mcp', 'work', 'fixture'], { env: home.env })).code).toBe(0);

    const activated = await run(['use', 'work', '--global'], { env: home.env });
    expect(activated.code).toBe(0);
    expect(activated.stderr).toContain('[pi/mcp] unsupported');
    expect(activated.stdout).toContain('Global stack: [work]');
  });
});
