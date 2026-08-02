import { describe, expect, it } from 'vitest';
import {
  renderSessionLaunch,
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
