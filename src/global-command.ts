import { randomUUID } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  globalDestinationRoots,
  resolveGlobalSurfaceDestination,
  resolveSurfaceDestination,
  userHome,
} from './adapter-v2.js';
import type { Adapter } from './adapter.js';
import { backup, restore, type BackupRef } from './backups.js';
import { createCommandPlan, type CommandPlan, type PlannedOperation } from './command-plan.js';
import {
  executeCommandPlan,
  recoverCommandPlan,
  type CommandEffect,
} from './command-wal.js';
import { recoverState } from './journal.js';
import { withLock } from './lock.js';
import {
  capturePathIdentity,
  identitiesEqual,
  type PathIdentity,
} from './path-identity.js';
import type { Paths } from './paths.js';
import {
  readState,
  writeState,
  type ManifestItem,
  type QuarantineRecord,
  type StateManifest,
} from './state.js';

type GlobalCommandKind = 'global-activation' | 'global-drop';

/** Fault-injection/diagnostic seams; production callers leave these unset. */
export interface GlobalCommandHooks {
  afterPersist?: (plan: CommandPlan) => Promise<void>;
  afterPublish?: (path: string) => Promise<void>;
}

export interface GlobalRenderRequest {
  paths: Paths;
  adapters: readonly Adapter[];
  env: NodeJS.ProcessEnv;
  onWarn: (message: string) => void;
}

export interface ExecuteGlobalCommandRequest<T> extends GlobalRenderRequest {
  kind: GlobalCommandKind;
  render(staged: GlobalRenderRequest): Promise<T>;
  hooks?: GlobalCommandHooks;
}

interface PathPair {
  actual: string;
  staged: string;
}

interface GlobalStateSlice {
  items: ManifestItem[];
  globalProjections: StateManifest['globalProjections'];
  globalStack?: string[];
}

type GlobalUndo =
  | {
      schemaVersion: 1;
      type: 'replace';
      target: string;
      backup: BackupRef;
      preIdentity: PathIdentity;
    }
  | {
      schemaVersion: 1;
      type: 'handoff';
      source: string;
      retained: string;
      sourceBackup: BackupRef;
      sourceIdentity: PathIdentity;
    }
  | {
      schemaVersion: 1;
      type: 'state';
      marker: string;
      before: GlobalStateSlice;
      after: GlobalStateSlice;
    };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function mapUnder(path: string, pairs: readonly PathPair[]): string {
  const match = [...pairs]
    .filter((pair) => isWithin(pair.actual, path))
    .sort((left, right) => right.actual.length - left.actual.length)[0];
  return match ? join(match.staged, relative(match.actual, path)) : path;
}

function mapBack(path: string, pairs: readonly PathPair[]): string {
  const match = [...pairs]
    .filter((pair) => isWithin(pair.staged, path))
    .sort((left, right) => right.staged.length - left.staged.length)[0];
  return match ? join(match.actual, relative(match.staged, path)) : path;
}

function rewriteStrings(value: unknown, map: (path: string) => string): unknown {
  if (typeof value === 'string') return map(value);
  if (Array.isArray(value)) return value.map((entry) => rewriteStrings(entry, map));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, rewriteStrings(entry, map)]),
  );
}

function stateSlice(manifest: StateManifest): GlobalStateSlice {
  const stack = (manifest as { globalStack?: unknown }).globalStack;
  return {
    items: clone(manifest.items),
    globalProjections: clone(manifest.globalProjections),
    ...(Array.isArray(stack)
      ? { globalStack: stack.filter((entry): entry is string => typeof entry === 'string') }
      : {}),
  };
}

function mapSlice(slice: GlobalStateSlice, map: (path: string) => string): GlobalStateSlice {
  return rewriteStrings(slice, map) as GlobalStateSlice;
}

function applySlice(manifest: StateManifest, slice: GlobalStateSlice): void {
  manifest.items = clone(slice.items);
  manifest.globalProjections = clone(slice.globalProjections);
  if (slice.globalStack) (manifest as { globalStack?: string[] }).globalStack = [...slice.globalStack];
  else delete (manifest as { globalStack?: string[] }).globalStack;
  manifest.journal = null;
}

async function patchState(paths: Paths, slice: GlobalStateSlice): Promise<void> {
  await withLock(paths, async () => {
    const manifest = await readState(paths);
    applySlice(manifest, slice);
    await writeState(paths, manifest);
  });
}

async function copyPath(source: string, destination: string): Promise<void> {
  const stats = await lstat(source).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stats) return;
  await mkdir(dirname(destination), { recursive: true });
  if (stats.isSymbolicLink()) {
    await symlink(await readlink(source), destination);
    return;
  }
  await cp(source, destination, {
    recursive: stats.isDirectory(),
    verbatimSymlinks: true,
    preserveTimestamps: true,
  });
}

async function movePath(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  try {
    await rename(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await copyPath(source, destination);
    await rm(source, { recursive: true, force: true });
  }
}

function addPair(pairs: PathPair[], actual: string, staged: string): void {
  const a = resolve(actual);
  const s = resolve(staged);
  const exact = pairs.find((pair) => pair.actual === a);
  if (exact) {
    if (exact.staged !== s) throw new Error(`global staging mapped '${a}' inconsistently`);
    return;
  }
  const parent = pairs.find((pair) => isWithin(pair.actual, a));
  if (parent) {
    const expected = join(parent.staged, relative(parent.actual, a));
    if (expected !== s) throw new Error(`global staging overlap at '${a}'`);
    return;
  }
  for (const child of pairs.filter((pair) => isWithin(a, pair.actual))) {
    const expected = join(s, relative(a, child.actual));
    if (expected !== child.staged) throw new Error(`global staging overlap at '${a}'`);
  }
  const retained = pairs.filter((pair) => !isWithin(a, pair.actual));
  retained.push({ actual: a, staged: s });
  pairs.splice(0, pairs.length, ...retained);
}

function rootsForStaging(
  paths: Paths,
  env: NodeJS.ProcessEnv,
  adapters: readonly Adapter[],
  root: string,
): {
  env: NodeJS.ProcessEnv;
  adapters: Adapter[];
  rootPairs: PathPair[];
} {
  const actualHome = userHome(env);
  const stagedHome = join(root, 'roots', 'home');
  const rootPairs: PathPair[] = [{ actual: resolve(actualHome), staged: resolve(stagedHome) }];
  const mapRoot = (actual: string, label: string): string => {
    const within = rootPairs
      .filter((pair) => isWithin(pair.actual, resolve(actual)))
      .sort((left, right) => right.actual.length - left.actual.length)[0];
    if (within) return join(within.staged, relative(within.actual, resolve(actual)));
    const staged = join(root, 'roots', label);
    rootPairs.push({ actual: resolve(actual), staged: resolve(staged) });
    return staged;
  };
  const actualProject = env.PWD?.trim() || process.cwd();
  const stagedProject = mapRoot(actualProject, 'project');
  const configs = new Map<string, string>();
  const stagedAdapters = adapters.map((adapter, index) => {
    const actual = resolve(adapter.realConfigRoot(env));
    let staged = configs.get(actual);
    if (!staged) {
      staged = mapRoot(actual, `config-${index}`);
      configs.set(actual, staged);
    }
    return { ...adapter, realConfigRoot: () => staged };
  });
  return {
    env: { ...env, HOME: stagedHome, USERPROFILE: stagedHome, PWD: stagedProject },
    adapters: stagedAdapters,
    rootPairs,
  };
}

function surfacePairs(
  adapters: readonly Adapter[],
  stagedAdapters: readonly Adapter[],
  env: NodeJS.ProcessEnv,
  stagedEnv: NodeJS.ProcessEnv,
): PathPair[] {
  const pairs: PathPair[] = [];
  for (const [index, adapter] of adapters.entries()) {
    const stagedAdapter = stagedAdapters[index]!;
    for (const surface of adapter.surfaces) {
      const declared = adapter.definition?.surfaces.find((item) => item.id === surface.id);
      if (!surface.supported || declared?.global.supported === false) continue;
      addPair(
        pairs,
        resolveGlobalSurfaceDestination(adapter, surface, env),
        resolveGlobalSurfaceDestination(stagedAdapter, surface, stagedEnv),
      );
    }
    const actualRoots = globalDestinationRoots(adapter, env);
    const stagedRoots = globalDestinationRoots(stagedAdapter, stagedEnv);
    for (const mapping of adapter.definition?.rawMappings ?? []) {
      if (!mapping.global.supported) continue;
      addPair(
        pairs,
        resolveSurfaceDestination(mapping.global, actualRoots),
        resolveSurfaceDestination(mapping.global, stagedRoots),
      );
    }
  }
  return pairs;
}

function stagePaths(paths: Paths, root: string): Paths {
  const base = join(root, 'machine');
  return {
    base,
    store: paths.store,
    environments: paths.environments,
    storeReadme: paths.storeReadme,
    state: join(base, 'state.json'),
    lock: join(base, 'lock'),
    secrets: paths.secrets,
    backups: paths.backups,
    live: join(base, 'live'),
    shims: paths.shims,
    envDir: paths.envDir,
    envYaml: paths.envYaml,
  };
}

async function rewriteStageSymlinks(path: string, stagedPrefix: string, actualPrefix: string): Promise<void> {
  const stats = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stats) return;
  if (stats.isSymbolicLink()) {
    const target = await readlink(path);
    if (isAbsolute(target) && isWithin(stagedPrefix, target)) {
      await rm(path, { force: true });
      await symlink(join(actualPrefix, relative(stagedPrefix, target)), path);
    }
    return;
  }
  if (!stats.isDirectory()) return;
  const { readdir } = await import('node:fs/promises');
  for (const entry of await readdir(path)) {
    await rewriteStageSymlinks(join(path, entry), stagedPrefix, actualPrefix);
  }
}

function parseUndo(operation: PlannedOperation): GlobalUndo {
  if (!operation.undoRef) throw new Error(`global operation '${operation.id}' lacks undo metadata`);
  const value = JSON.parse(operation.undoRef) as GlobalUndo;
  if (!value || value.schemaVersion !== 1 || !['replace', 'handoff', 'state'].includes(value.type)) {
    throw new Error(`global operation '${operation.id}' has invalid undo metadata`);
  }
  return value;
}

async function retainThirdIdentity(
  paths: Paths,
  plan: CommandPlan,
  operation: PlannedOperation,
  target: string,
  suffix = '',
): Promise<QuarantineRecord> {
  const id = `global-${plan.transactionId}-${operation.id}${suffix}`;
  const retainedPath = join(paths.live, 'quarantine', id, 'content');
  const existing = await capturePathIdentity(retainedPath);
  if (existing.kind === 'absent') {
    await mkdir(dirname(retainedPath), { recursive: true });
    const observed = await capturePathIdentity(target);
    if (observed.kind === 'absent') await writeFile(retainedPath, 'ABSENT third identity\n', 'utf8');
    else await movePath(target, retainedPath);
  }
  return {
    schemaVersion: 2,
    id,
    kind: 'whole-command-third-identity',
    path: target,
    retainedPath,
    reason: `global operation '${operation.id}' observed an unplanned identity during rollback`,
    createdAt: Date.now(),
    resolved: false,
  };
}

async function appendQuarantine(paths: Paths, record: QuarantineRecord): Promise<void> {
  await withLock(paths, async () => {
    const manifest = await readState(paths);
    if (!manifest.quarantine.some((candidate) => candidate.id === record.id)) {
      manifest.quarantine.push(record);
      await writeState(paths, manifest);
    }
  });
}

async function restoreMode(path: string, identity: PathIdentity): Promise<void> {
  if (identity.kind !== 'file' && identity.kind !== 'directory') return;
  const { chmod } = await import('node:fs/promises');
  await chmod(path, identity.mode);
}

function recoveryEffect(paths: Paths, plan: CommandPlan, operation: PlannedOperation): CommandEffect {
  const undo = parseUndo(operation);
  const target = operation.path;
  if (!target) throw new Error(`global operation '${operation.id}' lacks a path`);
  return {
    observeIdentity: () => capturePathIdentity(target),
    apply: async () => {
      throw new Error('global recovery effects cannot run forward');
    },
    rescue: () => retainThirdIdentity(paths, plan, operation, target),
    undo: async () => {
      if (undo.type === 'replace') {
        await restore(paths, undo.backup, undo.target);
        await restoreMode(undo.target, undo.preIdentity);
        return;
      }
      if (undo.type === 'state') {
        await patchState(paths, undo.before);
        await rm(undo.marker, { recursive: true, force: true });
        return;
      }

      const retainedIdentity = await capturePathIdentity(undo.retained);
      const sourceIdentity = await capturePathIdentity(undo.source);
      if (
        retainedIdentity.kind === 'absent' &&
        identitiesEqual(sourceIdentity, undo.sourceIdentity)
      ) {
        // The intent marker landed but the atomic inode handoff did not. Keep
        // the original inode in place so an already-open writer remains valid.
        await rm(target, { recursive: true, force: true });
        return;
      }
      if (sourceIdentity.kind !== 'absent' && !identitiesEqual(sourceIdentity, undo.sourceIdentity)) {
        await appendQuarantine(
          paths,
          await retainThirdIdentity(paths, plan, operation, undo.source, '-source'),
        );
      } else if (sourceIdentity.kind !== 'absent') {
        await rm(undo.source, { recursive: true, force: true });
      }
      if (identitiesEqual(retainedIdentity, undo.sourceIdentity)) {
        await movePath(undo.retained, undo.source);
      } else {
        if (retainedIdentity.kind !== 'absent') {
          await appendQuarantine(
            paths,
            await retainThirdIdentity(paths, plan, operation, undo.retained, '-retained'),
          );
        }
        await restore(paths, undo.sourceBackup, undo.source);
        await restoreMode(undo.source, undo.sourceIdentity);
      }
      await rm(target, { recursive: true, force: true });
    },
  };
}

function recoveryEffects(paths: Paths, plan: CommandPlan): Map<string, CommandEffect> {
  return new Map(
    plan.operations.map((operation) => [operation.id, recoveryEffect(paths, plan, operation)]),
  );
}

/** Recover an interrupted global activation/drop in a fresh process. */
export async function recoverPendingGlobalCommands(paths: Paths): Promise<void> {
  const pending = (await readState(paths)).commands.filter(
    (plan) => plan.kind === 'global-activation' || plan.kind === 'global-drop',
  );
  for (const plan of pending) {
    await recoverCommandPlan({
      paths,
      transactionId: plan.transactionId,
      effects: recoveryEffects(paths, plan),
    });
    await rm(join(paths.live, 'commands', plan.transactionId), { recursive: true, force: true });
  }
}

function itemPaths(slice: GlobalStateSlice): string[] {
  return slice.items.map((item) => item.path);
}

/** Render global state privately, then publish its complete physical/state diff through one WAL. */
export async function executeGlobalCommand<T>(req: ExecuteGlobalCommandRequest<T>): Promise<T> {
  await recoverPendingGlobalCommands(req.paths);
  const unrelated = (await readState(req.paths)).commands[0];
  if (unrelated) {
    throw new Error(`unfinished command '${unrelated.transactionId}' must be resolved first`);
  }
  await withLock(req.paths, () => recoverState(req.paths));

  const transactionId = `${req.kind}-${randomUUID()}`;
  const commandRoot = join(req.paths.live, 'commands', transactionId);
  const simulationRoot = join(commandRoot, 'simulation');
  const stagedPaths = stagePaths(req.paths, simulationRoot);
  const roots = rootsForStaging(req.paths, req.env, req.adapters, simulationRoot);
  const pairs = surfacePairs(req.adapters, roots.adapters, req.env, roots.env);
  const beforeManifest = await readState(req.paths);
  const before = stateSlice(beforeManifest);

  // A manifest-driven drop can touch paths whose adapter is no longer installed.
  for (const [index, path] of itemPaths(before).entries()) {
    if (pairs.some((pair) => isWithin(pair.actual, path))) continue;
    addPair(pairs, path, join(simulationRoot, 'orphan-surfaces', String(index)));
  }
  for (const [index, projection] of before.globalProjections.entries()) {
    if (!projection.surfacePath || pairs.some((pair) => isWithin(pair.actual, projection.surfacePath!))) continue;
    addPair(
      pairs,
      projection.surfacePath,
      join(simulationRoot, 'orphan-projections', String(index)),
    );
  }

  const actualLiveGlobal = join(req.paths.live, 'global');
  const stagedLiveGlobal = join(stagedPaths.live, 'global');
  const livePairs: PathPair[] = [
    ...pairs,
    { actual: actualLiveGlobal, staged: stagedLiveGlobal },
    {
      actual: join(req.paths.live, 'global-projections'),
      staged: join(stagedPaths.live, 'global-projections'),
    },
  ];

  await rm(commandRoot, { recursive: true, force: true });
  await mkdir(commandRoot, { recursive: true });
  for (const pair of pairs) await copyPath(pair.actual, pair.staged);
  await copyPath(actualLiveGlobal, stagedLiveGlobal);
  for (const projection of before.globalProjections) {
    if (!projection.retainedPath) continue;
    await copyPath(
      projection.retainedPath,
      mapUnder(projection.retainedPath, livePairs),
    );
  }

  const stagedManifest = clone(beforeManifest);
  stagedManifest.commands = [];
  stagedManifest.journal = null;
  applySlice(
    stagedManifest,
    mapSlice(before, (path) => mapUnder(path, livePairs)),
  );
  await writeState(stagedPaths, stagedManifest);

  const translate = (message: string): string => {
    let out = message;
    for (const pair of [...livePairs].sort((left, right) => right.staged.length - left.staged.length)) {
      out = out.replaceAll(pair.staged, pair.actual);
    }
    return out;
  };
  let result: T;
  try {
    result = await req.render({
      paths: stagedPaths,
      adapters: roots.adapters,
      env: roots.env,
      onWarn: (message) => req.onWarn(translate(message)),
    });
    result = rewriteStrings(result, translate) as T;
  } catch (error) {
    await rm(commandRoot, { recursive: true, force: true });
    throw error;
  }

  try {
    await rewriteStageSymlinks(stagedLiveGlobal, stagedLiveGlobal, actualLiveGlobal);
    for (const pair of pairs) {
      await rewriteStageSymlinks(pair.staged, stagedLiveGlobal, actualLiveGlobal);
    }

  const stagedAfterManifest = await readState(stagedPaths);
  const after = mapSlice(stateSlice(stagedAfterManifest), (path) => mapBack(path, livePairs));
  const postByProjection = new Map(after.globalProjections.map((projection) => [projection.id, projection]));
  const handoffs = before.globalProjections.filter((projection) => {
    const post = postByProjection.get(projection.id);
    return projection.phase === 'active' && post?.phase === 'retired' && post.retainedPath;
  });
  const handedSources = new Set(handoffs.map((projection) => resolve(projection.surfacePath!)));

  const publishPaths = new Set([...itemPaths(before), ...itemPaths(after)]);
  const liveBefore = await capturePathIdentity(actualLiveGlobal);
  const liveAfter = await capturePathIdentity(stagedLiveGlobal);
  if (!identitiesEqual(liveBefore, liveAfter)) publishPaths.add(actualLiveGlobal);

  const operations: PlannedOperation[] = [];
  const effects = new Map<string, CommandEffect>();
  const markerSeeds = join(commandRoot, 'seeds');
  await mkdir(markerSeeds, { recursive: true });

  for (const [index, projection] of handoffs.entries()) {
    const post = postByProjection.get(projection.id)!;
    const source = projection.surfacePath!;
    const retained = post.retainedPath!;
    const sourceIdentity = await capturePathIdentity(source);
    const retainedIdentity = await capturePathIdentity(retained);
    if (retainedIdentity.kind !== 'absent') {
      throw new Error(`retained handoff target already exists: ${retained}`);
    }
    const sourceBackup = await backup(req.paths, source);
    const seed = join(markerSeeds, `handoff-${index}`);
    const marker = join(commandRoot, 'markers', `handoff-${index}`);
    await writeFile(seed, `${projection.id}\n`, 'utf8');
    const postIdentity = await capturePathIdentity(seed);
    const operation: PlannedOperation = {
      id: `handoff-${index}`,
      kind: 'global-cow-handoff',
      path: marker,
      preIdentity: { kind: 'absent' },
      postIdentity,
      undoRef: JSON.stringify({
        schemaVersion: 1,
        type: 'handoff',
        source,
        retained,
        sourceBackup,
        sourceIdentity,
      } satisfies GlobalUndo),
      state: 'pending',
    };
    operations.push(operation);
    const base = recoveryEffect(req.paths, { transactionId } as CommandPlan, operation);
    effects.set(operation.id, {
      ...base,
      apply: async () => {
        if (!identitiesEqual(await capturePathIdentity(source), sourceIdentity)) {
          throw new Error(`global handoff source changed before apply: ${source}`);
        }
        if ((await capturePathIdentity(retained)).kind !== 'absent') {
          throw new Error(`global handoff target changed before apply: ${retained}`);
        }
        await movePath(seed, marker);
        await movePath(source, retained);
        await req.hooks?.afterPublish?.(source);
      },
    });
  }

  const publishList = [...publishPaths]
    .map((path) => resolve(path))
    .filter((path, index, all) => all.indexOf(path) === index)
    .filter((path) => ![...publishPaths].some((parent) => resolve(parent) !== path && isWithin(resolve(parent), path)));
  for (const [index, target] of publishList.entries()) {
    const staged = target === actualLiveGlobal ? stagedLiveGlobal : mapUnder(target, pairs);
    if (staged === target) throw new Error(`global publish target was not staged: ${target}`);
    const postIdentity = await capturePathIdentity(staged);
    const preIdentity = handedSources.has(target)
      ? ({ kind: 'absent' } as const)
      : await capturePathIdentity(target);
    if (!handedSources.has(target) && identitiesEqual(preIdentity, postIdentity)) continue;
    const undoBackup: BackupRef = handedSources.has(target)
      ? { kind: 'absent' }
      : await backup(req.paths, target);
    const operation: PlannedOperation = {
      id: `surface-${index}`,
      kind: 'global-replace-path',
      path: target,
      preIdentity,
      postIdentity,
      undoRef: JSON.stringify({
        schemaVersion: 1,
        type: 'replace',
        target,
        backup: undoBackup,
        preIdentity,
      } satisfies GlobalUndo),
      state: 'pending',
    };
    operations.push(operation);
    const base = recoveryEffect(req.paths, { transactionId } as CommandPlan, operation);
    effects.set(operation.id, {
      ...base,
      apply: async () => {
        if (!identitiesEqual(await capturePathIdentity(target), preIdentity)) {
          throw new Error(`global surface changed before apply: ${target}`);
        }
        if (!identitiesEqual(await capturePathIdentity(staged), postIdentity)) {
          throw new Error(`staged global surface changed before apply: ${staged}`);
        }
        await rm(target, { recursive: true, force: true });
        if (postIdentity.kind !== 'absent') await movePath(staged, target);
        await req.hooks?.afterPublish?.(target);
      },
    });
  }

  const stateSeed = join(markerSeeds, 'state');
  const stateMarker = join(commandRoot, 'markers', 'state');
  await writeFile(stateSeed, 'global state applied\n', 'utf8');
  const statePostIdentity = await capturePathIdentity(stateSeed);
  const stateOperation: PlannedOperation = {
    id: 'global-state',
    kind: 'global-state-commit',
    path: stateMarker,
    preIdentity: { kind: 'absent' },
    postIdentity: statePostIdentity,
    undoRef: JSON.stringify({
      schemaVersion: 1,
      type: 'state',
      marker: stateMarker,
      before,
      after,
    } satisfies GlobalUndo),
    state: 'pending',
  };
  operations.push(stateOperation);
  const stateBase = recoveryEffect(req.paths, { transactionId } as CommandPlan, stateOperation);
  effects.set(stateOperation.id, {
    ...stateBase,
    apply: async () => {
      await movePath(stateSeed, stateMarker);
      await patchState(req.paths, after);
      await req.hooks?.afterPublish?.(req.paths.state);
    },
  });

    const plan = createCommandPlan({ transactionId, kind: req.kind, operations });
    // Rebuild effects with the complete plan so deterministic rescue records name it correctly.
    for (const operation of plan.operations) {
      const forward = effects.get(operation.id)!;
      effects.set(operation.id, { ...recoveryEffect(req.paths, plan, operation), apply: forward.apply });
    }
    await executeCommandPlan({
      paths: req.paths,
      plan,
      effects,
      ...(req.hooks?.afterPersist ? { afterPersist: req.hooks.afterPersist } : {}),
    });
    return result;
  } finally {
    if (!(await readState(req.paths)).commands.some((candidate) => candidate.transactionId === transactionId)) {
      await rm(commandRoot, { recursive: true, force: true });
    }
  }
}
