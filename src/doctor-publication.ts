import { randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdir, readlink, readdir, rm, symlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { restore, type BackupRef } from './backups.js';
import { diagnose, repair, type DoctorProblem, type RepairResult } from './doctor.js';
import { recoverState } from './journal.js';
import { withLock } from './lock.js';
import { capturePathIdentity, identitiesEqual } from './path-identity.js';
import type { Paths } from './paths.js';
import {
  readState,
  writeState,
  type QuarantineRecord,
  type StateManifest,
} from './state.js';
import type { StagedCommandEntry } from './staged-command.js';
import { publishStagedCommand } from './staged-command.js';

const RESERVED_STATE_KEYS = new Set(['version', 'journal', 'commands']);

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}

async function copyPath(source: string, destination: string): Promise<void> {
  if ((await capturePathIdentity(source)).kind === 'absent') return;
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, verbatimSymlinks: true });
}

async function copyShadowPath(
  source: string,
  destination: string,
  mapping: ShadowMapping,
): Promise<void> {
  const identity = await capturePathIdentity(source);
  if (identity.kind === 'absent') return;
  await mkdir(dirname(destination), { recursive: true });
  if (identity.kind === 'symlink') {
    const link = await readlink(source);
    const absolute = isAbsolute(link) ? link : resolve(dirname(source), link);
    await symlink(mapping.toShadow(absolute), destination);
    return;
  }
  await cp(source, destination, { recursive: true, verbatimSymlinks: true });
}

function backupEntryName(ref: BackupRef | null | undefined): string | null {
  if (!ref) return null;
  if (ref.kind === 'content') return ref.hash;
  if (ref.kind === 'directory') return ref.id;
  return null;
}

function itemFilesystemPaths(manifest: StateManifest): string[] {
  const paths: string[] = [];
  for (const item of manifest.items) {
    paths.push(item.path);
    const target = (item as { target?: unknown }).target;
    if (typeof target === 'string' && isAbsolute(target)) paths.push(target);
    const subBlocks = (item as { subBlocks?: unknown }).subBlocks;
    if (Array.isArray(subBlocks)) {
      for (const block of subBlocks) {
        const storePath = (block as { storePath?: unknown }).storePath;
        if (typeof storePath === 'string' && isAbsolute(storePath)) paths.push(storePath);
      }
    }
  }
  return [...new Set(paths)];
}

interface ShadowMapping {
  shadowPaths: Paths;
  externalRoots: string[];
  toShadow(path: string): string;
  toActual(path: string): string;
}

function createShadowMapping(
  paths: Paths,
  stagingRoot: string,
  externalPaths: readonly string[],
): ShadowMapping {
  const shadowBase = join(stagingRoot, 'shadow');
  const roots = [...new Set(externalPaths.map((path) => resolve(path)))]
    .filter((path) => !contained(resolve(paths.base), path))
    .sort((a, b) => a.length - b.length)
    .filter((path, index, all) => !all.slice(0, index).some((root) => contained(root, path)));
  const mappedRoots = new Map(
    roots.map((root, index) => [root, join(shadowBase, 'external', String(index), basename(root))]),
  );
  const toShadow = (path: string): string => {
    const absolute = resolve(path);
    if (contained(resolve(paths.base), absolute)) {
      return join(shadowBase, 'base', relative(resolve(paths.base), absolute));
    }
    const root = roots.find((candidate) => contained(candidate, absolute));
    if (!root) return path;
    return join(mappedRoots.get(root)!, relative(root, absolute));
  };
  const toActual = (path: string): string => {
    const shadowActualBase = join(shadowBase, 'base');
    if (contained(shadowActualBase, resolve(path))) {
      return join(paths.base, relative(shadowActualBase, resolve(path)));
    }
    for (const [actual, mapped] of mappedRoots) {
      if (contained(mapped, resolve(path))) return join(actual, relative(mapped, resolve(path)));
    }
    return path;
  };
  const base = join(shadowBase, 'base');
  const store = join(base, 'store');
  const environments = join(store, 'environments');
  return {
    externalRoots: roots,
    toShadow,
    toActual,
    shadowPaths: {
      base,
      store,
      environments,
      storeReadme: join(store, 'README.md'),
      state: join(base, 'state.json'),
      lock: join(base, 'lock'),
      secrets: join(base, 'secrets.env'),
      backups: join(base, 'backups'),
      live: join(base, 'live'),
      shims: join(base, 'shims'),
      envDir: (name) => join(environments, name),
      envYaml: (name) => join(environments, name, 'env.yaml'),
    },
  };
}

function rewritePaths<T>(value: T, rewrite: (path: string) => string): T {
  if (typeof value === 'string') return (isAbsolute(value) ? rewrite(value) : value) as T;
  if (Array.isArray(value)) return value.map((entry) => rewritePaths(entry, rewrite)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        rewritePaths(entry, rewrite),
      ]),
    ) as T;
  }
  return value;
}

function translateText(text: string, mapping: ShadowMapping): string {
  let translated = text;
  const pairs: [string, string][] = [
    [mapping.shadowPaths.base, mapping.toActual(mapping.shadowPaths.base)],
    ...mapping.externalRoots.map((root): [string, string] => [mapping.toShadow(root), root]),
  ];
  for (const [shadow, actual] of pairs.sort((a, b) => b[0].length - a[0].length)) {
    translated = translated.split(shadow).join(actual);
  }
  return translated;
}

function translateProblem(problem: DoctorProblem, mapping: ShadowMapping): DoctorProblem {
  return {
    ...problem,
    where: translateText(problem.where, mapping),
    what: translateText(problem.what, mapping),
    repair: translateText(problem.repair, mapping),
  };
}

function statePatch(before: StateManifest, after: StateManifest): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (RESERVED_STATE_KEYS.has(key)) continue;
    if (!identitiesJsonEqual(before[key], after[key])) patch[key] = structuredClone(after[key]);
  }
  return patch;
}

function identitiesJsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export interface PlannedDoctorRepair extends RepairResult {
  publication: 'no-change' | 'complete';
}

/** Compute doctor repairs in a fully rewritten shadow installation, then publish
 * only the changed owned paths and state domains through one command WAL. */
export async function publishDoctorRepair(paths: Paths): Promise<PlannedDoctorRepair> {
  const recovery = await withLock(paths, () => recoverState(paths));
  const before = await readState(paths);
  if (before.commands.length > 0) {
    return { actions: [], remaining: await diagnose(paths), publication: 'no-change' };
  }
  const transactionId = `doctor-repair-${randomUUID()}`;
  const stagingRoot = join(paths.live, 'commands', transactionId);
  const filesystemPaths = itemFilesystemPaths(before);
  const mapping = createShadowMapping(paths, stagingRoot, filesystemPaths);

  for (const path of filesystemPaths) {
    await copyShadowPath(path, mapping.toShadow(path), mapping);
  }
  for (const name of await readdir(paths.backups).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    })) {
    await copyPath(join(paths.backups, name), join(mapping.shadowPaths.backups, name));
  }
  await mkdir(dirname(mapping.shadowPaths.state), { recursive: true });
  await writeState(mapping.shadowPaths, rewritePaths(before, mapping.toShadow));

  let repairError: unknown;
  let shadowResult: RepairResult = { actions: [], remaining: [] };
  try {
    shadowResult = await repair(mapping.shadowPaths);
  } catch (error) {
    // Some bounded-repair failures deliberately retain current bytes and then
    // refuse to guess. Publish that rescue record/content before preserving the
    // existing command failure contract.
    repairError = error;
  }
  const shadowManifest = await readState(mapping.shadowPaths);
  const after = rewritePaths(shadowManifest, mapping.toActual);
  const candidatePaths = new Set(filesystemPaths);
  for (const name of await readdir(paths.backups).catch(() => [])) {
    candidatePaths.add(join(paths.backups, name));
  }
  for (const rescue of after.quarantine) candidatePaths.add(rescue.retainedPath);

  const entries: StagedCommandEntry[] = [];
  for (const target of candidatePaths) {
    let staged = mapping.toShadow(target);
    const [pre, post] = await Promise.all([
      capturePathIdentity(target),
      capturePathIdentity(staged),
    ]);
    if (identitiesEqual(pre, post)) continue;
    if (post.kind === 'symlink') {
      const shadowLink = await readlink(staged);
      const resolvedLink = isAbsolute(shadowLink)
        ? mapping.toActual(shadowLink)
        : mapping.toActual(resolve(dirname(staged), shadowLink));
      const rewritten = join(stagingRoot, 'published-links', String(entries.length));
      await mkdir(dirname(rewritten), { recursive: true });
      await symlink(resolvedLink, rewritten);
      staged = rewritten;
    }
    entries.push({
      id: `repair-${entries.length}`,
      target,
      staged,
      expectedPreIdentity: pre,
    });
  }
  const patch = statePatch(before, after);
  const actions = [
    ...(recovery.recovered
      ? [`rolled back ${recovery.rolledBack} journalled mutation(s) from an interrupted transaction`]
      : []),
    ...shadowResult.actions.map((action) => translateText(action, mapping)),
  ];
  if (entries.length === 0 && Object.keys(patch).length === 0) {
    await rm(stagingRoot, { recursive: true, force: true });
    const result = {
      actions,
      remaining: shadowResult.remaining.map((problem) => translateProblem(problem, mapping)),
      publication: 'no-change' as const,
    };
    if (repairError) throw repairError;
    return result;
  }
  await publishStagedCommand({
    paths,
    transactionId,
    kind: 'doctor-repair',
    stagingRoot,
    allowedRoots: [paths.base, ...mapping.externalRoots],
    entries,
    statePatch: patch,
  });
  if (repairError) throw repairError;
  return {
    actions,
    remaining: shadowResult.remaining.map((problem) => translateProblem(problem, mapping)),
    publication: 'complete',
  };
}

export interface DoctorRestoreResult {
  restored: boolean;
  path?: string;
  rescuedPath?: string;
  error?: string;
}

function findBackupTarget(
  manifest: StateManifest,
  backupId: string,
): { ref: BackupRef; path: string } | null {
  for (const item of manifest.items) {
    const ref = (item as { backupRef?: BackupRef | null }).backupRef;
    if (ref && backupEntryName(ref) === backupId) return { ref, path: item.path };
  }
  for (const entry of manifest.journal ?? []) {
    const ref = entry.undo?.backupRef;
    if (ref && backupEntryName(ref) === backupId) return { ref, path: entry.undo.path };
  }
  return null;
}

/** Plan backup restoration plus current-byte rescue as one command. */
export async function publishDoctorRestore(
  paths: Paths,
  backupId: string,
): Promise<DoctorRestoreResult> {
  const id = backupId.trim();
  if (!id) return { restored: false, error: 'a backup id is required' };
  await withLock(paths, () => recoverState(paths));
  const manifest = await readState(paths);
  const match = findBackupTarget(manifest, id);
  if (!match) return { restored: false, error: `no manifest item references backup '${id}'` };
  if ((await capturePathIdentity(join(paths.backups, id))).kind === 'absent') {
    return { restored: false, error: `backup '${id}' is not present under ${paths.backups}` };
  }
  const transactionId = `doctor-restore-${randomUUID()}`;
  const stagingRoot = join(paths.live, 'commands', transactionId);
  const restored = join(stagingRoot, 'restored');
  await restore(paths, match.ref, restored);
  const currentIdentity = await capturePathIdentity(match.path);
  const entries: StagedCommandEntry[] = [{
    id: 'restore',
    target: match.path,
    staged: restored,
    expectedPreIdentity: currentIdentity,
  }];
  let rescuedPath: string | undefined;
  const quarantine = structuredClone(manifest.quarantine);
  if (currentIdentity.kind !== 'absent') {
    const rescueId = `doctor-restore-${Date.now()}-${randomBytes(6).toString('hex')}`;
    rescuedPath = join(paths.live, 'quarantine', rescueId, 'content');
    const stagedRescue = join(stagingRoot, 'current');
    await copyPath(match.path, stagedRescue);
    entries.unshift({
      id: 'rescue-current',
      target: rescuedPath,
      staged: stagedRescue,
      expectedPreIdentity: { kind: 'absent' },
    });
    const rescue: QuarantineRecord = {
      schemaVersion: 2,
      id: rescueId,
      kind: 'doctor-backup-restore',
      path: match.path,
      retainedPath: rescuedPath,
      reason: `current bytes retained before restoring backup '${id}'`,
      createdAt: Date.now(),
      resolved: false,
    };
    quarantine.push(rescue);
  }
  await publishStagedCommand({
    paths,
    transactionId,
    kind: 'doctor-restore',
    stagingRoot,
    allowedRoots: [paths.base, dirname(match.path)],
    entries,
    ...(rescuedPath ? { statePatch: { quarantine } } : {}),
  });
  return { restored: true, path: match.path, ...(rescuedPath ? { rescuedPath } : {}) };
}
