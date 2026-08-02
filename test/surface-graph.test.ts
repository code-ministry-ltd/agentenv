import { describe, expect, it } from 'vitest';
import type { AdapterV2, LogicalSurfaceV2 } from '../src/adapter-v2.js';
import { buildSurfaceGraph } from '../src/surface-graph.js';

const roots = {
  view: '/live/view',
  config: '/home/.harness',
  home: '/home',
  agentsStandard: '/home/.agents/skills',
  project: '/project',
};

function adapter(id: string, surface: LogicalSurfaceV2): AdapterV2 {
  return {
    version: 2,
    id,
    binaryName: id,
    session: { supported: true, launch: {} },
    surfaces: [surface],
    rawMappings: [],
  };
}

function sharedSkills(id = 'skills'): LogicalSurfaceV2 {
  return {
    id,
    storeKind: 'skills',
    composition: { mechanism: 'dir-merge', mode: 'symlink' },
    session: {
      supported: true,
      destination: { root: 'view', relativePath: 'skills' },
      writer: 'direct',
    },
    global: {
      supported: true,
      destination: { root: 'agents-standard', relativePath: '' },
      writer: 'projection',
    },
  };
}

describe('central physical surface graph', () => {
  it('compiles shared global skills once with multiple harness consumers', () => {
    const graph = buildSurfaceGraph({
      adapters: [adapter('codex', sharedSkills()), adapter('opencode', sharedSkills())],
      mode: 'global',
      rootsFor: () => roots,
    });
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]).toMatchObject({
      path: '/home/.agents/skills',
      ownerId: '@physical:agents-standard',
      mechanism: 'dir-merge',
      writer: 'projection',
    });
    expect(graph.nodes[0]?.consumers.map((consumer) => consumer.adapterId).sort()).toEqual([
      'codex',
      'opencode',
    ]);
  });

  it('groups compatible config-key contributions targeting one physical file', () => {
    const first = sharedSkills('mcp');
    first.storeKind = 'mcp';
    first.composition = { mechanism: 'config-keys', format: 'json', style: 'keyed', keyPath: ['mcp'] };
    first.global = {
      supported: true,
      destination: { root: 'config', relativePath: 'settings.json' },
      writer: 'projection',
    };
    const second = structuredClone(first);
    second.id = 'instructions';
    second.storeKind = 'instructions';
    second.composition = {
      mechanism: 'config-keys',
      format: 'json',
      style: 'array-element',
      keyPath: ['instructions'],
    };
    const graph = buildSurfaceGraph({
      adapters: [{ ...adapter('opencode', first), surfaces: [first, second] }],
      mode: 'global',
      rootsFor: () => roots,
    });
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]?.consumers).toHaveLength(2);
  });

  it('rejects incompatible writers for the same path before returning a graph', () => {
    const file = sharedSkills('instructions');
    file.composition = { mechanism: 'file-block', layering: 'inline' };
    expect(() =>
      buildSurfaceGraph({
        adapters: [adapter('one', sharedSkills()), adapter('two', file)],
        mode: 'global',
        rootsFor: () => roots,
      }),
    ).toThrow(/physical surface conflict.*\.agents\/skills/i);
  });

  it('rejects nested raw and managed providers as an ownership overlap', () => {
    const value = adapter('codex', sharedSkills());
    value.rawMappings = [
      {
        id: 'agents',
        storeRelativePath: 'agents',
        session: { supported: false, reason: 'global fixture' },
        global: {
          supported: true,
          destination: { root: 'agents-standard', relativePath: 'custom' },
          writer: 'projection',
        },
      },
    ];
    expect(() =>
      buildSurfaceGraph({ adapters: [value], mode: 'global', rootsFor: () => roots }),
    ).toThrow(/ownership overlap/i);
  });
});
