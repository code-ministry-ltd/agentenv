import { isAbsolute, join } from 'node:path';
import type { ConfigFormat, ConfigKeysStyle, StoreKind } from './adapter.js';

export type DestinationRoot = 'view' | 'config' | 'home' | 'agents-standard' | 'project';
export type SurfaceWriter = 'direct' | 'projection';

export interface SurfaceDestination {
  root: DestinationRoot;
  relativePath: string;
}

export type ModeSurface =
  | {
      supported: true;
      destination: SurfaceDestination;
      writer: SurfaceWriter;
      hotReload?: boolean;
      adopt?: boolean;
    }
  | { supported: false; reason: string };

export type SurfaceComposition =
  | { mechanism: 'dir-merge'; mode?: 'symlink' | 'copy' }
  | { mechanism: 'file-block'; layering: 'import' | 'inline' }
  | {
      mechanism: 'config-keys';
      format: ConfigFormat;
      style: ConfigKeysStyle;
      keyPath: readonly (string | number)[];
      substitutePlaceholders?: boolean;
    };

export interface LogicalSurfaceV2 {
  id: string;
  storeKind: StoreKind;
  composition: SurfaceComposition;
  session: ModeSurface;
  global: ModeSurface;
}

export interface RawMappingV2 {
  id: string;
  storeRelativePath: string;
  session: ModeSurface;
  global: ModeSurface;
}

export interface SessionLaunchV2 {
  arguments?: readonly string[];
  environment?: Readonly<Record<string, string>>;
  rootOverride?: { variable: string; value?: string };
}

export interface AdapterV2 {
  version: 2;
  id: string;
  binaryName: string;
  aliases?: readonly string[];
  session:
    | { supported: true; launch: SessionLaunchV2 }
    | { supported: false; reason: string };
  surfaces: LogicalSurfaceV2[];
  rawMappings: RawMappingV2[];
}

export interface DestinationRoots {
  view: string;
  config: string;
  home: string;
  agentsStandard: string;
  project: string;
}

function replaceView(value: string, viewRoot: string): string {
  return value.replaceAll('{view}', viewRoot);
}

export function renderSessionLaunch(
  adapter: AdapterV2,
  viewRoot: string,
  userArgs: readonly string[],
): { args: string[]; env: Record<string, string> } {
  if (!adapter.session.supported) throw new Error(`adapter session is unsupported: ${adapter.session.reason}`);
  const launch = adapter.session.launch;
  const env = Object.fromEntries(
    Object.entries(launch.environment ?? {}).map(([key, value]) => [key, replaceView(value, viewRoot)]),
  );
  if (launch.rootOverride) {
    env[launch.rootOverride.variable] = replaceView(launch.rootOverride.value ?? '{view}', viewRoot);
  }
  return {
    args: [...(launch.arguments ?? []).map((arg) => replaceView(arg, viewRoot)), ...userArgs],
    env,
  };
}

export function resolveSurfaceDestination(mode: ModeSurface, roots: DestinationRoots): string {
  if (!mode.supported) throw new Error(`surface mode is unsupported: ${mode.reason}`);
  const base =
    mode.destination.root === 'agents-standard'
      ? roots.agentsStandard
      : roots[mode.destination.root];
  return join(base, mode.destination.relativePath);
}

function safeRelative(value: string, allowEmpty: boolean): boolean {
  if ((!allowEmpty && value === '') || isAbsolute(value)) return false;
  return !value.split(/[\\/]/).some((segment) => segment === '..');
}

function validateMode(mode: ModeSurface, label: string): string | null {
  if (!mode.supported) return mode.reason.trim() ? null : `${label} unsupported mode requires a reason`;
  return safeRelative(mode.destination.relativePath, true)
    ? null
    : `${label} has an unsafe destination relativePath`;
}

export function validateAdapterV2(adapter: AdapterV2): string | null {
  if (adapter.version !== 2) return `adapter '${adapter.id}' must declare version 2`;
  if (!adapter.id || !adapter.binaryName) return 'adapter id and binaryName are required';
  if (!adapter.session.supported && !adapter.session.reason.trim()) {
    return `adapter '${adapter.id}' unsupported session requires a reason`;
  }
  if (adapter.session.supported && adapter.session.launch.rootOverride?.variable.trim() === '') {
    return `adapter '${adapter.id}' root override variable is required`;
  }
  const ids = new Set<string>();
  for (const surface of adapter.surfaces) {
    if (!surface.id || ids.has(surface.id)) return `adapter '${adapter.id}' has a missing or duplicate surface id`;
    ids.add(surface.id);
    const session = validateMode(surface.session, `surface '${surface.id}' session`);
    if (session) return session;
    const global = validateMode(surface.global, `surface '${surface.id}' global`);
    if (global) return global;
  }
  for (const mapping of adapter.rawMappings) {
    if (!safeRelative(mapping.storeRelativePath, false)) {
      return `raw mapping '${mapping.id}' has an unsafe storeRelativePath`;
    }
    const session = validateMode(mapping.session, `raw mapping '${mapping.id}' session`);
    if (session) return session;
    const global = validateMode(mapping.global, `raw mapping '${mapping.id}' global`);
    if (global) return global;
  }
  return null;
}
