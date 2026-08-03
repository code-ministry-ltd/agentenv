import { describe, expect, it } from 'vitest';
import { importLegacyState, parseLegacyState } from '../src/legacy-state.js';
import { resolvePaths } from '../src/paths.js';

describe('pinned v1 compatibility readers', () => {
  it('recognises and imports the CM v1 items manifest without changing ownership fields', () => {
    const paths = resolvePaths({ AGENTENV_HOME: '/tmp/agentenv-cm-v1' });
    const source = parseLegacyState(
      JSON.stringify({
        version: '1.0',
        items: [
          {
            surface: 'dir-merge',
            action: 'symlink',
            path: '/tmp/home/.agents/skills/review',
            target: `${paths.store}/environments/work/skills/review`,
            ownerEnv: 'work',
            backupRef: { kind: 'absent' },
          },
        ],
        globalStack: ['work'],
      }),
      paths.state,
    );

    expect(source.format).toBe('cm-v1');
    const imported = importLegacyState(source, paths, 'migration-cm');
    expect(imported.items).toEqual(source.raw.items);
    expect(imported.globalStack).toEqual(['work']);
    expect(imported.version).toBe('2.0');
    expect(imported.migration).toMatchObject({
      id: 'migration-cm',
      sourceFormat: 'cm-v1',
      phase: 'importing',
      gate: 'closed',
    });
  });

  it('recognises JJ v1 and translates every owned surface plus adoptions and activations', () => {
    const paths = resolvePaths({ AGENTENV_HOME: '/tmp/agentenv-jj-v1' });
    const source = parseLegacyState(
      JSON.stringify({
        version: '1.0',
        journal: [],
        ownership: [
          {
            env: 'work',
            hash: 'hash',
            kind: 'symlink',
            path: '/tmp/home/.agents/skills/review',
            source: `${paths.store}/environments/work/skills/review`,
            surface: 'codex.skills',
          },
        ],
        blocks: [
          {
            closeMarker: '<!-- close -->',
            env: 'work',
            mode: 'inline',
            openMarker: '<!-- open -->',
            separator: '\n',
            sourceHash: 'block-hash',
            sourceId: 'base',
            sourcePath: `${paths.store}/environments/work/instructions/base.md`,
            surface: 'codex.instructions',
            target: '/tmp/home/AGENTS.md',
            targetExisted: true,
          },
        ],
        configKeys: [
          {
            createdParents: [['mcp_servers']],
            env: 'work',
            format: 'toml',
            hash: 'config-hash',
            id: 'linear',
            marker: 'work:codex.mcp:linear',
            mode: 'keyed',
            path: ['mcp_servers', 'linear'],
            surface: 'codex.mcp',
            target: '/tmp/home/.codex/config.toml',
            targetExisted: true,
            targetHash: 'target-hash',
            value: { command: 'linear-mcp' },
          },
        ],
        globalActivations: [{ adapterId: 'codex', environments: ['work'] }],
        adoptions: [
          {
            environmentSubpath: 'skills',
            env: 'work',
            id: 'adopt-1',
            name: 'review',
            origin: 'global',
            originalPath: '/tmp/home/.agents/skills/review',
            storePath: `${paths.store}/environments/work/skills/review`,
          },
        ],
        approvedProjects: ['/tmp/project'],
        inventories: [],
        shadowing: [],
      }),
      paths.state,
    );

    expect(source.format).toBe('jj-v1');
    const imported = importLegacyState(source, paths, 'migration-jj');
    expect(imported.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          surface: 'dir-merge',
          action: 'symlink',
          target: `${paths.store}/environments/work/skills/review`,
          adopted: true,
          origin: 'global',
        }),
        expect.objectContaining({
          surface: 'file-block',
          action: 'file-block',
          ownerEnv: 'work',
          subBlocks: [
            expect.objectContaining({
              source: 'base',
              storePath: `${paths.store}/environments/work/instructions/base.md`,
            }),
          ],
        }),
        expect.objectContaining({
          surface: 'config-keys',
          action: 'config-key',
          format: 'toml',
          keyPath: ['mcp_servers', 'linear'],
          createdParents: 1,
        }),
      ]),
    );
    expect(imported.globalStack).toEqual(['work']);
    expect((imported.legacy as { approvedProjects: string[] }).approvedProjects).toEqual(['/tmp/project']);
  });

  it('refuses an unfinished v1 journal instead of invoking legacy recovery', () => {
    expect(() =>
      parseLegacyState(
        JSON.stringify({
          version: '1.0',
          items: [],
          journal: [
            {
              op: 'add',
              item: {},
              undo: { path: '/tmp/x', backupRef: { kind: 'absent' } },
            },
          ],
        }),
        '/tmp/state.json',
      ),
    ).toThrow(/unfinished CM v1 journal/i);

    expect(() =>
      parseLegacyState(
        JSON.stringify({
          version: '1.0',
          journal: [{ id: 'pending' }],
          ownership: [],
        }),
        '/tmp/state.json',
      ),
    ).toThrow(/unfinished JJ v1 journal/i);
  });

  it('rejects mixed, malformed, and newer legacy manifests', () => {
    expect(() =>
      parseLegacyState(
        JSON.stringify({ version: '1.0', items: [], ownership: [], journal: [] }),
        '/tmp/state.json',
      ),
    ).toThrow(/mixes CM and JJ/i);
    expect(() =>
      parseLegacyState(JSON.stringify({ version: '1.0', ownership: [{}], journal: [] }), '/tmp/state.json'),
    ).toThrow(/ownership\[0\]/i);
    expect(() =>
      parseLegacyState(JSON.stringify({ version: '2.0', items: [] }), '/tmp/state.json'),
    ).toThrow(/not a pinned v1 state/i);
  });
});
