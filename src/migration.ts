import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { Adapter } from './adapter.js';
import { adapters as defaultAdapters } from './adapters/index.js';
import { writeFileAtomic } from './fs-atomic.js';
import { parseLegacyState, importLegacyState, type LegacyState } from './legacy-state.js';
import { withLock } from './lock.js';
import {
  beginMigrationBackup,
  beginMigrationImport,
  beginMigrationProbes,
  beginMigrationRollback,
  completeMigrationBackup,
  completeMigrationImport,
  completeMigrationRollback,
  createMigrationState,
  openMigrationGate,
  type LegacyStateFormat,
  type MigrationState,
} from './migration-state.js';
import { capturePathIdentity, identitiesEqual, type PathIdentity } from './path-identity.js';
import { resolvePaths, type Paths } from './paths.js';
import { generateShims } from './session/shims.js';
import { readState, writeState, type StateManifest } from './state.js';
import type { GenerationInventoryEntry, ViewGeneration } from './view-generation.js';

const execFileAsync = promisify(execFile);
const WAL_VERSION = '1.0';
const HARNESS_NAMES = new Set(['claude', 'codex', 'cursor-agent', 'opencode', 'pi']);

export type MigrationBoundary =
  | 'gate-installed'
  | 'quiescent'
  | 'root-backed-up'
  | 'external-backed-up'
  | 'import-staged'
  | 'old-root-moved'
  | 'pointer-switched'
  | 'probes-passed'
  | 'before-open';

export interface HarnessProcess {
  pid: number;
  command: string;
}

export interface MigrationRequest {
  paths: Paths;
  adapters?: readonly Adapter[];
  now?: () => number;
  listHarnessProcesses?: () => Promise<HarnessProcess[]>;
  probe?: (paths: Paths, manifest: StateManifest) => Promise<void>;
  afterBoundary?: (boundary: MigrationBoundary) => Promise<void> | void;
}

export interface MigrationResult {
  id: string;
  sourceFormat: LegacyStateFormat;
  status: 'opened' | 'already-opened';
  backup: string;
}

type Snapshot =
  | { kind: 'absent' }
  | { kind: 'symlink'; target: string }
  | { kind: 'file' | 'directory'; backup: string; mode: number };

interface GateEntry {
  name: string;
  path: string;
  snapshot: Snapshot;
  status: 'planned' | 'installed';
}

interface ExternalEntry {
  path: string;
  identity: PathIdentity;
  snapshot: Snapshot;
}

interface MigrationWal {
  version: typeof WAL_VERSION;
  migration: MigrationState;
  createdAt: number;
  sourceStateDigest: string;
  sourceRootIdentity: PathIdentity;
  gateEntries: GateEntry[];
  externalEntries: ExternalEntry[];
  rootBackup: Snapshot | null;
  cutover: 'not-started' | 'old-root-moved' | 'pointer-switched';
}

/** Sibling workspace survives either active-root rename during cutover and rollback. */
export function migrationWorkspace(paths: Paths): string {
  return `${resolve(paths.base)}.migration`;
}

function walPath(paths: Paths): string {
  return join(migrationWorkspace(paths), 'wal.json');
}

function stagedRoot(paths: Paths): string {
  return join(migrationWorkspace(paths), 'staged-root');
}

function oldRoot(paths: Paths): string {
  return join(migrationWorkspace(paths), 'old-root');
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * POSIX, version-neutral migration gate. It cannot call either CLI version: it
 * strips the shim directory and execs the real harness with zero overrides.
 */
export function closedGateShimScript(binaryName: string, shimsDir: string): string {
  const bin = shellQuote(binaryName);
  const dir = shellQuote(shimsDir);
  return `#!/bin/sh
# agentenv version-neutral migration gate — generated; do not edit.
bin=${bin}
shimreal=$(cd ${dir} 2>/dev/null && pwd -P) || shimreal=${dir}
real=""
IFS=:
for d in $PATH; do
  [ -n "$d" ] || d=.
  dreal=$(cd "$d" 2>/dev/null && pwd -P) || dreal="$d"
  [ "$dreal" = "$shimreal" ] && continue
  candidate="$d/$bin"
  [ -f "$candidate" ] && [ -x "$candidate" ] && { real="$candidate"; break; }
done
unset IFS
printf 'agentenv: migration in progress; launching %s without environment overrides\n' "$bin" >&2
[ -n "$real" ] && exec "$real" "$@"
printf 'agentenv: real %s not found on PATH (migration gate)\n' "$bin" >&2
exit 127
`;
}

async function writeWal(paths: Paths, wal: MigrationWal): Promise<void> {
  await mkdir(migrationWorkspace(paths), { recursive: true });
  await writeFileAtomic(walPath(paths), `${JSON.stringify(wal, null, 2)}\n`);
}

async function readWal(paths: Paths): Promise<MigrationWal | null> {
  let text: string;
  try {
    text = await readFile(walPath(paths), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const raw = JSON.parse(text) as Partial<MigrationWal>;
  if (
    raw.version !== WAL_VERSION ||
    !raw.migration ||
    !Array.isArray(raw.gateEntries) ||
    !Array.isArray(raw.externalEntries)
  ) {
    throw new Error(`${walPath(paths)}: invalid migration WAL`);
  }
  return raw as MigrationWal;
}

/** Fail-safe gate query used by the current CLI and its shim path. */
export async function migrationGateClosed(paths: Paths): Promise<boolean> {
  try {
    const wal = await readWal(paths);
    return wal !== null && wal.migration.gate === 'closed' && wal.migration.phase !== 'rolled-back';
  } catch {
    // A corrupt WAL is not evidence that migration completed. Launches must stay
    // usable, but without any environment overrides.
    return true;
  }
}

/** Whether an on-disk state file is one of the two v1 formats awaiting migration. */
export async function legacyMigrationRequired(paths: Paths): Promise<boolean> {
  try {
    const raw = JSON.parse(await readFile(paths.state, 'utf8')) as { version?: unknown };
    return (
      typeof raw.version === 'string' &&
      Number.parseInt(raw.version.split('.')[0] ?? '', 10) === 1
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    // Corrupt state belongs to doctor/recovery, not implicit migration detection.
    return false;
  }
}

async function snapshot(path: string, backupPath: string): Promise<Snapshot> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    throw error;
  }
  if (metadata.isSymbolicLink()) return { kind: 'symlink', target: await readlink(path) };
  if (!metadata.isFile() && !metadata.isDirectory()) {
    throw new Error(`migration cannot snapshot unsupported path type: ${path}`);
  }
  await rm(backupPath, { recursive: true, force: true });
  await mkdir(dirname(backupPath), { recursive: true });
  await cp(path, backupPath, {
    recursive: metadata.isDirectory(),
    verbatimSymlinks: true,
    preserveTimestamps: true,
  });
  return {
    kind: metadata.isDirectory() ? 'directory' : 'file',
    backup: backupPath,
    mode: metadata.mode & 0o7777,
  };
}

async function restoreSnapshot(target: string, saved: Snapshot): Promise<void> {
  await rm(target, { recursive: true, force: true });
  if (saved.kind === 'absent') return;
  await mkdir(dirname(target), { recursive: true });
  if (saved.kind === 'symlink') {
    await symlink(saved.target, target);
    return;
  }
  await cp(saved.backup, target, {
    recursive: saved.kind === 'directory',
    verbatimSymlinks: true,
    preserveTimestamps: true,
  });
  await chmod(target, saved.mode);
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep));
}

function externalPaths(source: LegacyState, paths: Paths): string[] {
  const candidates = source.format === 'cm-v1'
    ? source.raw.items.map((item) => item.path)
    : [
        ...source.raw.ownership.map((record) => record.path),
        ...source.raw.blocks.map((record) => record.target),
        ...source.raw.configKeys.map((record) => record.target),
        ...source.raw.adoptions.map((record) => record.originalPath),
      ];
  const unique = new Set<string>();
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) throw new Error(`legacy owned path is not absolute: ${candidate}`);
    if (!isContained(paths.base, candidate)) unique.add(resolve(candidate));
  }
  return [...unique].sort();
}

async function installGate(
  paths: Paths,
  wal: MigrationWal,
  adapters: readonly Adapter[],
): Promise<void> {
  const names = new Set(adapters.map((adapter) => adapter.binaryName));
  if (await exists(paths.shims)) {
    for (const entry of await readdir(paths.shims, { withFileTypes: true })) {
      if (entry.isFile() || entry.isSymbolicLink()) names.add(entry.name);
    }
  }
  for (const name of [...names].sort()) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`unsafe legacy shim name '${name}'`);
    const path = join(paths.shims, name);
    const entry: GateEntry = {
      name,
      path,
      snapshot: await snapshot(path, join(migrationWorkspace(paths), 'gate-backups', name)),
      status: 'planned',
    };
    wal.gateEntries.push(entry);
    await writeWal(paths, wal);
    await writeFileAtomic(path, closedGateShimScript(name, paths.shims));
    await chmod(path, 0o755);
    entry.status = 'installed';
    await writeWal(paths, wal);
  }
}

async function defaultListHarnessProcesses(): Promise<HarnessProcess[]> {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  const out: HarnessProcess[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2] ?? '';
    if (pid === process.pid || pid === process.ppid) continue;
    const words = command.split(/\s+/u).map((word) => basename(word));
    if (words.some((word) => HARNESS_NAMES.has(word))) out.push({ pid, command });
  }
  return out;
}

async function requireQuiescence(req: MigrationRequest): Promise<void> {
  const active = await (req.listHarnessProcesses ?? defaultListHarnessProcesses)();
  if (active.length === 0) return;
  const detail = active.map(({ pid, command }) => `${pid} (${command})`).join(', ');
  throw new Error(
    `migration cannot establish quiescence: end every legacy harness process and retry; still active: ${detail}`,
  );
}

function sourceDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function acquireJjLock<T>(paths: Paths, fn: () => Promise<T>): Promise<T> {
  await mkdir(paths.base, { recursive: true });
  const deadline = Date.now() + 10_000;
  let handle;
  for (;;) {
    try {
      handle = await open(paths.lock, 'wx');
      await handle.writeFile(`${process.pid}\n`, 'utf8');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let holderText: string;
      try {
        holderText = await readFile(paths.lock, 'utf8');
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw readError;
      }
      const holder = Number.parseInt(holderText, 10);
      let alive = Number.isSafeInteger(holder) && holder > 0;
      if (alive) {
        try {
          process.kill(holder, 0);
        } catch (probeError) {
          alive = (probeError as NodeJS.ErrnoException).code === 'EPERM';
        }
      }
      if (!alive) {
        await rm(paths.lock, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for the JJ v1 lock held by pid ${holder}`, { cause: error });
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }
  return fn().finally(async () => {
    await handle.close();
    try {
      const holder = Number.parseInt(await readFile(paths.lock, 'utf8'), 10);
      if (holder === process.pid) await rm(paths.lock, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  });
}

function withLegacyLock<T>(paths: Paths, format: LegacyStateFormat, fn: () => Promise<T>): Promise<T> {
  return format === 'cm-v1' ? withLock(paths, fn) : acquireJjLock(paths, fn);
}

function generationId(format: LegacyStateFormat, relativePath: string): string {
  return `migration-${format}-${createHash('sha256').update(relativePath).digest('hex').slice(0, 16)}`;
}

async function currentBindingsBySession(stagingPaths: Paths): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  try {
    const raw = JSON.parse(await readFile(join(stagingPaths.base, 'sessions.json'), 'utf8')) as {
      bindings?: Array<{ session?: string; envs?: string[] }>;
    };
    for (const binding of raw.bindings ?? []) {
      if (typeof binding.session !== 'string' || !Array.isArray(binding.envs)) continue;
      const existing = out.get(binding.session) ?? [];
      for (const env of binding.envs) if (!existing.includes(env)) existing.push(env);
      out.set(binding.session, existing);
    }
  } catch {
    // A malformed legacy registry is retained in the root backup. Its views are
    // still quarantined with an empty env list rather than guessed attribution.
  }
  return out;
}

async function migrateJjSessions(stagingPaths: Paths, now: number): Promise<void> {
  const path = join(stagingPaths.base, 'sessions.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path}: invalid JJ v1 session registry`);
  }
  const bindings = (parsed as { bindings?: unknown }).bindings;
  if (!Array.isArray(bindings)) throw new Error(`${path}: invalid JJ v1 session registry`);
  const converted = bindings.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${path}: bindings[${index}] is invalid`);
    }
    const item = entry as Record<string, unknown>;
    if (
      typeof item.sessionId !== 'string' ||
      typeof item.projectRoot !== 'string' ||
      !Array.isArray(item.environments) ||
      !item.environments.every((env) => typeof env === 'string')
    ) {
      throw new Error(`${path}: bindings[${index}] is invalid`);
    }
    const parsedTime = typeof item.updatedAt === 'string' ? Date.parse(item.updatedAt) : Number.NaN;
    return {
      session: item.sessionId,
      projectRoot: item.projectRoot,
      envs: item.environments,
      createdAt: Number.isFinite(parsedTime) ? parsedTime : now,
    };
  });
  await writeFileAtomic(path, `${JSON.stringify({ version: '1.0', bindings: converted }, null, 2)}\n`);
}

async function writeJjApprovals(stagingPaths: Paths, source: LegacyState, now: number): Promise<void> {
  if (source.format !== 'jj-v1' || source.raw.approvedProjects.length === 0) return;
  const approvals = Object.fromEntries(
    source.raw.approvedProjects.map((project) => [resolve(project), { approvedAt: now }]),
  );
  await writeFileAtomic(
    join(stagingPaths.base, 'approvals.json'),
    `${JSON.stringify({ version: '1.0', approvals }, null, 2)}\n`,
  );
}

async function dirEntries(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function finalPath(stagingPaths: Paths, paths: Paths, stagedPath: string): string {
  return join(paths.base, relative(stagingPaths.base, stagedPath));
}

async function importCmGenerations(
  stagingPaths: Paths,
  paths: Paths,
  now: number,
): Promise<ViewGeneration[]> {
  const bindings = await currentBindingsBySession(stagingPaths);
  const generations: ViewGeneration[] = [];
  for (const session of await dirEntries(stagingPaths.live)) {
    if (['candidates', 'commands', 'generations', 'projections', 'quarantine'].includes(session)) continue;
    const sessionPath = join(stagingPaths.live, session);
    for (const adapterId of await dirEntries(sessionPath)) {
      const stagedView = join(sessionPath, adapterId);
      const rel = relative(stagingPaths.live, stagedView);
      generations.push({
        schemaVersion: 2,
        id: generationId('cm-v1', rel),
        envs: bindings.get(session) ?? [],
        phase: 'quarantined',
        reservations: [],
        leases: [],
        adapterId,
        session,
        viewRoot: finalPath(stagingPaths, paths, stagedView),
        inventory: [],
        createdAt: now,
        failure: 'CM v1 live view retained: the pinned format has no trustworthy production inventory',
      });
    }
  }
  return generations;
}

interface JjViewMeta {
  adapter?: unknown;
  environments?: unknown;
  fingerprint?: unknown;
  inventories?: unknown;
}

async function importJjGenerations(
  stagingPaths: Paths,
  paths: Paths,
  now: number,
): Promise<ViewGeneration[]> {
  const generations: ViewGeneration[] = [];
  for (const session of await dirEntries(stagingPaths.live)) {
    const sessionPath = join(stagingPaths.live, session);
    for (const adapterId of await dirEntries(sessionPath)) {
      const adapterPath = join(sessionPath, adapterId);
      for (const fingerprintDir of await dirEntries(adapterPath)) {
        const stagedView = join(adapterPath, fingerprintDir);
        const metaPath = join(stagedView, '.agentenv-view.json');
        let meta: JjViewMeta = {};
        try {
          meta = JSON.parse(await readFile(metaPath, 'utf8')) as JjViewMeta;
        } catch {
          // Preserve and quarantine malformed legacy views; do not infer.
        }
        const envs = Array.isArray(meta.environments)
          ? meta.environments.filter((env): env is string => typeof env === 'string' && env !== '')
          : [];
        const inventory: GenerationInventoryEntry[] = [];
        if (meta.inventories && typeof meta.inventories === 'object' && !Array.isArray(meta.inventories)) {
          for (const [subpath, baseline] of Object.entries(meta.inventories as Record<string, unknown>)) {
            if (!Array.isArray(baseline) || !baseline.every((name) => typeof name === 'string')) continue;
            inventory.push({
              surfaceId: `legacy:${adapterId}:${subpath}`,
              storeKind: subpath,
              mechanism: 'dir-merge',
              path: finalPath(stagingPaths, paths, join(stagedView, subpath)),
              baseline: [...baseline].sort(),
              ownerEnv: envs.at(-1) ?? null,
            });
          }
        }
        const rel = relative(stagingPaths.live, stagedView);
        generations.push({
          schemaVersion: 2,
          id: generationId('jj-v1', rel),
          envs,
          phase: 'quarantined',
          reservations: [],
          leases: [],
          adapterId: typeof meta.adapter === 'string' ? meta.adapter : adapterId,
          session,
          viewRoot: finalPath(stagingPaths, paths, stagedView),
          fingerprint: typeof meta.fingerprint === 'string' ? meta.fingerprint : fingerprintDir,
          inventory,
          createdAt: now,
          failure: 'JJ v1 view retained for safe post-migration reconciliation; legacy child leases were not trustworthy',
        });
      }
    }
  }
  return generations;
}

async function stageImport(
  req: MigrationRequest,
  source: LegacyState,
  wal: MigrationWal,
): Promise<void> {
  const stage = stagedRoot(req.paths);
  await rm(stage, { recursive: true, force: true });
  await cp(req.paths.base, stage, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  const stagingPaths = resolvePaths({ AGENTENV_HOME: stage });
  const now = (req.now ?? Date.now)();
  if (source.format === 'jj-v1') await migrateJjSessions(stagingPaths, now);
  await writeJjApprovals(stagingPaths, source, now);

  const manifest = importLegacyState(source, req.paths, wal.migration.id);
  manifest.generations = source.format === 'cm-v1'
    ? await importCmGenerations(stagingPaths, req.paths, now)
    : await importJjGenerations(stagingPaths, req.paths, now);
  manifest.migration = wal.migration;
  await writeState(stagingPaths, manifest);
}

async function probeCutover(req: MigrationRequest, wal: MigrationWal): Promise<StateManifest> {
  const manifest = await readState(req.paths);
  if (
    manifest.migration?.id !== wal.migration.id ||
    manifest.migration.phase !== 'probing' ||
    manifest.migration.gate !== 'closed'
  ) {
    throw new Error('migrated state did not preserve the closed probing gate');
  }
  if (!(await exists(req.paths.environments))) throw new Error('migrated store environments directory is missing');
  for (const entry of wal.externalEntries) {
    const observed = await capturePathIdentity(entry.path);
    if (!identitiesEqual(observed, entry.identity)) {
      throw new Error(`manifest-owned external path changed during migration: ${entry.path}`);
    }
  }
  for (const generation of manifest.generations) {
    if (generation.phase === 'quarantined' && generation.viewRoot && !(await exists(generation.viewRoot))) {
      throw new Error(`retained legacy view is missing after cutover: ${generation.viewRoot}`);
    }
  }
  await req.probe?.(req.paths, manifest);
  return manifest;
}

async function openGate(
  req: MigrationRequest,
  wal: MigrationWal,
  adapters: readonly Adapter[],
  manifest: StateManifest,
): Promise<void> {
  await generateShims(req.paths, adapters);
  const current = new Set(adapters.map((adapter) => adapter.binaryName));
  for (const entry of wal.gateEntries) {
    if (!current.has(entry.name)) await restoreSnapshot(entry.path, entry.snapshot);
  }
  const opened = openMigrationGate(wal.migration);
  manifest.migration = opened;
  await writeState(req.paths, manifest); // irreversible commit point
  wal.migration = opened;
  await writeWal(req.paths, wal); // makes the version-neutral gate observe open
}

async function currentMigrationIsOpened(paths: Paths, id: string): Promise<boolean> {
  try {
    const state = await readState(paths);
    return state.migration?.id === id && state.migration.commitPoint && state.migration.phase === 'opened';
  } catch {
    return false;
  }
}

async function restoreOriginalRoot(paths: Paths, wal: MigrationWal): Promise<void> {
  const prior = oldRoot(paths);
  if (await exists(prior)) {
    if (await exists(paths.base)) {
      const failed = join(migrationWorkspace(paths), `failed-root-${Date.now()}-${randomUUID()}`);
      await rename(paths.base, failed);
    }
    await rename(prior, paths.base);
    return;
  }
  if (!(await exists(paths.base)) && wal.rootBackup) {
    await restoreSnapshot(paths.base, wal.rootBackup);
  }
}

/** Idempotent pre-commit rollback. It never writes an external path migration did not mutate. */
export async function rollbackMigration(paths: Paths, wal?: MigrationWal): Promise<void> {
  const current = wal ?? (await readWal(paths));
  if (!current) return;
  if (current.migration.commitPoint || (await currentMigrationIsOpened(paths, current.migration.id))) {
    throw new Error('cannot roll back migration after the gate-open commit point');
  }
  if (current.migration.phase !== 'rolling-back' && current.migration.phase !== 'rolled-back') {
    current.migration = beginMigrationRollback(current.migration, 'migration failed before gate opening');
    await writeWal(paths, current);
  }
  await restoreOriginalRoot(paths, current);
  for (const entry of current.gateEntries) await restoreSnapshot(entry.path, entry.snapshot);
  if (current.migration.phase !== 'rolled-back') {
    current.migration = completeMigrationRollback(current.migration);
    await writeWal(paths, current);
  }
}

async function resumeInterrupted(paths: Paths, wal: MigrationWal): Promise<MigrationResult | null> {
  if (wal.migration.phase === 'opened' && wal.migration.commitPoint) {
    return {
      id: wal.migration.id,
      sourceFormat: wal.migration.sourceFormat,
      status: 'already-opened',
      backup: migrationWorkspace(paths),
    };
  }
  if (await currentMigrationIsOpened(paths, wal.migration.id)) {
    wal.migration = openMigrationGate({ ...wal.migration, phase: 'probing' });
    await writeWal(paths, wal);
    return {
      id: wal.migration.id,
      sourceFormat: wal.migration.sourceFormat,
      status: 'opened',
      backup: migrationWorkspace(paths),
    };
  }
  if (wal.migration.phase === 'rolled-back') return null;
  await rollbackMigration(paths, wal);
  throw new Error('an interrupted v1 migration was rolled back safely; re-run migrate to try again');
}

async function boundary(req: MigrationRequest, name: MigrationBoundary): Promise<void> {
  await req.afterBoundary?.(name);
}

/** Gated, staged, rollback-capable migration from either pinned v1 implementation. */
export async function migrateV1(req: MigrationRequest): Promise<MigrationResult> {
  const pending = await readWal(req.paths);
  if (pending) {
    const resumed = await resumeInterrupted(req.paths, pending);
    if (resumed) return resumed;
    // A deliberately rolled-back WAL is evidence only; archive it so a new
    // attempt gets a fresh workspace without overwriting retained failed bytes.
    const archived = `${migrationWorkspace(req.paths)}.rolled-back-${pending.migration.id}`;
    await rename(migrationWorkspace(req.paths), archived);
  }

  const sourceText = await readFile(req.paths.state, 'utf8');
  const source = parseLegacyState(sourceText, req.paths.state);
  const adapters = req.adapters ?? defaultAdapters;
  const now = req.now ?? Date.now;
  const id = `migration-${now()}-${randomUUID()}`;

  return withLegacyLock(req.paths, source.format, async () => {
    const lockedSourceText = await readFile(req.paths.state, 'utf8');
    if (sourceDigest(lockedSourceText) !== sourceDigest(sourceText)) {
      throw new Error('legacy state changed while migration was acquiring its lock; retry');
    }
    const rootIdentity = await capturePathIdentity(req.paths.base);
    const wal: MigrationWal = {
      version: WAL_VERSION,
      migration: createMigrationState(id, source.format),
      createdAt: now(),
      sourceStateDigest: sourceDigest(sourceText),
      sourceRootIdentity: rootIdentity,
      gateEntries: [],
      externalEntries: [],
      rootBackup: null,
      cutover: 'not-started',
    };
    await writeWal(req.paths, wal);

    try {
      await installGate(req.paths, wal, adapters);
      await boundary(req, 'gate-installed');
      await requireQuiescence(req);
      await boundary(req, 'quiescent');

      wal.migration = beginMigrationBackup(wal.migration);
      await writeWal(req.paths, wal);
      wal.rootBackup = await snapshot(req.paths.base, join(migrationWorkspace(req.paths), 'root-backup'));
      await writeWal(req.paths, wal);
      await boundary(req, 'root-backed-up');

      for (const [index, path] of externalPaths(source, req.paths).entries()) {
        const identity = await capturePathIdentity(path);
        const saved = await snapshot(path, join(migrationWorkspace(req.paths), 'external-backups', String(index)));
        const observed = await capturePathIdentity(path);
        if (!identitiesEqual(identity, observed)) {
          throw new Error(`manifest-owned external path changed while being backed up: ${path}`);
        }
        wal.externalEntries.push({ path, identity, snapshot: saved });
        await writeWal(req.paths, wal);
      }
      wal.migration = completeMigrationBackup(wal.migration, migrationWorkspace(req.paths));
      await writeWal(req.paths, wal);
      await boundary(req, 'external-backed-up');

      wal.migration = beginMigrationImport(wal.migration);
      await writeWal(req.paths, wal);
      await stageImport(req, source, wal);
      wal.migration = completeMigrationImport(wal.migration);
      wal.migration = beginMigrationProbes(wal.migration);
      const stagingPaths = resolvePaths({ AGENTENV_HOME: stagedRoot(req.paths) });
      const stagedManifest = await readState(stagingPaths);
      stagedManifest.migration = wal.migration;
      await writeState(stagingPaths, stagedManifest);
      await writeWal(req.paths, wal);
      await boundary(req, 'import-staged');

      await rename(req.paths.base, oldRoot(req.paths));
      wal.cutover = 'old-root-moved';
      await writeWal(req.paths, wal);
      await boundary(req, 'old-root-moved');
      await rename(stagedRoot(req.paths), req.paths.base);
      wal.cutover = 'pointer-switched';
      await writeWal(req.paths, wal);
      await boundary(req, 'pointer-switched');

      const manifest = await probeCutover(req, wal);
      await boundary(req, 'probes-passed');
      await boundary(req, 'before-open');
      await openGate(req, wal, adapters, manifest);

      return { id, sourceFormat: source.format, status: 'opened', backup: migrationWorkspace(req.paths) };
    } catch (error) {
      if (await currentMigrationIsOpened(req.paths, id)) {
        wal.migration = openMigrationGate({ ...wal.migration, phase: 'probing' });
        await writeWal(req.paths, wal);
        return { id, sourceFormat: source.format, status: 'opened', backup: migrationWorkspace(req.paths) };
      }
      await rollbackMigration(req.paths, wal);
      throw error;
    }
  });
}
