import { isAbsolute, relative } from 'node:path';
import {
  resolveSurfaceDestination,
  validateAdapterV2,
  type AdapterV2,
  type DestinationRoots,
  type LogicalSurfaceV2,
  type ModeSurface,
  type RawMappingV2,
  type SurfaceWriter,
} from './adapter-v2.js';
import type { StoreKind, SurfaceMechanism } from './adapter.js';

export type PhysicalMechanism = SurfaceMechanism | 'raw';

export interface SurfaceConsumer {
  adapterId: string;
  surfaceId: string;
  storeKind: StoreKind;
  logical: LogicalSurfaceV2 | RawMappingV2;
}

export interface PhysicalSurfaceNode {
  path: string;
  ownerId: string;
  mechanism: PhysicalMechanism;
  writer: SurfaceWriter;
  consumers: SurfaceConsumer[];
}

export interface UnsupportedSurface {
  adapterId: string;
  surfaceId: string;
  reason: string;
}

export interface SurfaceGraph {
  mode: 'session' | 'global';
  nodes: PhysicalSurfaceNode[];
  unsupported: UnsupportedSurface[];
}

export interface BuildSurfaceGraphRequest {
  adapters: readonly AdapterV2[];
  mode: 'session' | 'global';
  rootsFor(adapter: AdapterV2): DestinationRoots;
}

function overlaps(left: string, right: string): boolean {
  const rel = relative(left, right);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function compatible(
  existing: PhysicalSurfaceNode,
  mechanism: PhysicalMechanism,
  writer: SurfaceWriter,
  logical: LogicalSurfaceV2 | RawMappingV2,
): boolean {
  if (existing.mechanism !== mechanism || existing.writer !== writer || mechanism === 'raw') return false;
  if (mechanism !== 'config-keys') return true;
  const prior = existing.consumers[0]!.logical;
  return (
    'composition' in prior &&
    'composition' in logical &&
    prior.composition.mechanism === 'config-keys' &&
    logical.composition.mechanism === 'config-keys' &&
    prior.composition.format === logical.composition.format
  );
}

function ownerId(adapter: AdapterV2, mode: ModeSurface, path: string): string {
  if (mode.supported && mode.destination.root === 'agents-standard') {
    return '@physical:agents-standard';
  }
  return `@physical:${adapter.id}:${path}`;
}

/** Build and validate the complete physical graph without performing effects. */
export function buildSurfaceGraph(req: BuildSurfaceGraphRequest): SurfaceGraph {
  const graph: SurfaceGraph = { mode: req.mode, nodes: [], unsupported: [] };

  const add = (
    adapter: AdapterV2,
    logical: LogicalSurfaceV2 | RawMappingV2,
    mode: ModeSurface,
    mechanism: PhysicalMechanism,
    storeKind: StoreKind,
  ): void => {
    if (!mode.supported) {
      graph.unsupported.push({ adapterId: adapter.id, surfaceId: logical.id, reason: mode.reason });
      return;
    }
    const path = resolveSurfaceDestination(mode, req.rootsFor(adapter));
    const exact = graph.nodes.find((node) => node.path === path);
    if (exact) {
      if (!compatible(exact, mechanism, mode.writer, logical)) {
        throw new Error(`physical surface conflict at '${path}'`);
      }
      exact.consumers.push({ adapterId: adapter.id, surfaceId: logical.id, storeKind, logical });
      return;
    }
    const nested = graph.nodes.find((node) => overlaps(node.path, path) || overlaps(path, node.path));
    if (nested) {
      throw new Error(`physical ownership overlap between '${nested.path}' and '${path}'`);
    }
    graph.nodes.push({
      path,
      ownerId: ownerId(adapter, mode, path),
      mechanism,
      writer: mode.writer,
      consumers: [{ adapterId: adapter.id, surfaceId: logical.id, storeKind, logical }],
    });
  };

  for (const adapter of req.adapters) {
    const invalid = validateAdapterV2(adapter);
    if (invalid) throw new Error(invalid);
    for (const surface of adapter.surfaces) {
      add(adapter, surface, surface[req.mode], surface.composition.mechanism, surface.storeKind);
    }
    for (const mapping of adapter.rawMappings) {
      add(adapter, mapping, mapping[req.mode], 'raw', 'files');
    }
  }
  graph.nodes.sort((left, right) => left.path.localeCompare(right.path));
  return graph;
}
