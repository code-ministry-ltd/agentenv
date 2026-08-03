import { describe, expect, it } from 'vitest';
import {
  globalAdapterTargets,
  renderSessionLaunch,
  resolveGlobalSurfaceDestination,
  resolveSurfaceDestination,
  validateAdapterV2,
  type AdapterV2,
} from '../src/adapter-v2.js';

function claudeLike(): AdapterV2 {
  return {
    version: 2,
    id: 'claude-code',
    binaryName: 'claude',
    session: {
      supported: true,
      launch: {
        arguments: ['--add-dir={view}', '--mcp-config={view}/.mcp.json'],
        environment: { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1' },
      },
    },
    surfaces: [
      {
        id: 'skills',
        storeKind: 'skills',
        composition: { mechanism: 'dir-merge', mode: 'symlink' },
        session: {
          supported: true,
          destination: { root: 'view', relativePath: '.claude/skills' },
          writer: 'direct',
        },
        global: {
          supported: true,
          destination: { root: 'agents-standard', relativePath: '' },
          writer: 'projection',
        },
      },
    ],
    rawMappings: [],
  };
}

describe('Adapter v2 contract', () => {
  it('renders adapter-owned launch arguments before user arguments without a root override', () => {
    const adapter = claudeLike();
    expect(validateAdapterV2(adapter)).toBeNull();
    expect(renderSessionLaunch(adapter, '/private/view', ['--model', 'sonnet'])).toEqual({
      args: [
        '--add-dir=/private/view',
        '--mcp-config=/private/view/.mcp.json',
        '--model',
        'sonnet',
      ],
      env: { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1' },
    });
  });

  it('renders a parent-view placeholder for XDG-style config roots', () => {
    const adapter = claudeLike();
    adapter.session = {
      supported: true,
      launch: {
        environment: { XDG_CONFIG_HOME: '{viewParent}' },
        rootOverride: { variable: 'OPENCODE_CONFIG_DIR' },
      },
    };
    expect(renderSessionLaunch(adapter, '/private/generation/opencode', [])).toEqual({
      args: [],
      env: {
        XDG_CONFIG_HOME: '/private/generation',
        OPENCODE_CONFIG_DIR: '/private/generation/opencode',
      },
    });
  });

  it('resolves independent session and global destinations from explicit roots', () => {
    const surface = claudeLike().surfaces[0]!;
    expect(
      resolveSurfaceDestination(surface.session, {
        view: '/view',
        config: '/home/.claude',
        home: '/home',
        agentsStandard: '/home/.agents/skills',
        project: '/project',
      }),
    ).toBe('/view/.claude/skills');
    expect(
      resolveSurfaceDestination(surface.global, {
        view: '/view',
        config: '/home/.claude',
        home: '/home',
        agentsStandard: '/home/.agents/skills',
        project: '/project',
      }),
    ).toBe('/home/.agents/skills');
  });

  it('resolves home-relative global files and includes them in scoped-drop targets', () => {
    const definition = claudeLike();
    definition.surfaces[0] = {
      ...definition.surfaces[0]!,
      global: {
        supported: true,
        destination: { root: 'home', relativePath: '.claude.json' },
        writer: 'projection',
      },
    };
    const adapter = {
      definition,
      realConfigRoot: () => '/users/jim/.claude',
    };
    const surface = { id: 'skills', rootRelativePath: '.claude.json' };

    expect(resolveGlobalSurfaceDestination(adapter, surface, { HOME: '/fixture/home' })).toBe(
      '/fixture/home/.claude.json',
    );
    expect(globalAdapterTargets(adapter, { HOME: '/fixture/home' })).toEqual([
      '/users/jim/.claude',
      '/fixture/home/.claude.json',
    ]);
  });

  it('requires every unsupported mode to say why', () => {
    const adapter = claudeLike();
    adapter.surfaces[0] = {
      ...adapter.surfaces[0]!,
      session: { supported: false, reason: '' },
    };
    expect(validateAdapterV2(adapter)).toMatch(/unsupported.*reason/i);
  });

  it('rejects traversal in destinations and raw mappings', () => {
    const adapter = claudeLike();
    adapter.rawMappings = [
      {
        id: 'escape',
        storeRelativePath: '../outside',
        session: { supported: false, reason: 'not available' },
        global: { supported: false, reason: 'not available' },
      },
    ];
    expect(validateAdapterV2(adapter)).toMatch(/unsafe.*storeRelativePath/i);
  });
});
