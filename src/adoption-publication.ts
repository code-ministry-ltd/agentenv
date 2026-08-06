import { cp, mkdir, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type AdoptedDirMergeItem,
  type PlannedAdoptedRecord,
} from './adopt.js';
import { capturePathIdentity, identitiesEqual } from './path-identity.js';
import type { Paths } from './paths.js';
import { addItem, readState } from './state.js';
import type { StagedCommandEntry } from './staged-command.js';
import { publishWithPendingNotice } from './commands/staged-publication.js';
import { commitRequiredSteps, type SyncCtx } from './commands/store-sync.js';

function manifestItem(record: PlannedAdoptedRecord): AdoptedDirMergeItem {
  return {
    surface: 'dir-merge',
    action: 'symlink',
    path: record.surfacePath,
    target: record.storePath,
    ownerEnv: record.ownerEnv,
    backupRef: { kind: 'absent' },
    adopted: true,
    origin: record.origin,
    originalPath: record.surfacePath,
    ...(record.origin === 'session' && record.surface.realDir
      ? { realPath: join(record.surface.realDir, record.name) }
      : {}),
  };
}

export interface PublishAdoptionsRequest {
  paths: Paths;
  syncCtx: SyncCtx;
  transactionId: string;
  kind: 'capture' | 'manual-adopt';
  records: readonly PlannedAdoptedRecord[];
  notices: string[];
}

/** Stage and publish all approved adoptions as one local command, retaining the
 * historical one-commit-per-adoption Git contract after the local commit point. */
export async function publishAdoptions(
  req: PublishAdoptionsRequest,
): Promise<'complete' | 'git-pending'> {
  if (req.records.length === 0) return 'complete';
  const stagingRoot = join(req.paths.live, 'commands', req.transactionId);
  const entries: StagedCommandEntry[] = [];
  const manifest = await readState(req.paths);
  const items = structuredClone(manifest.items);
  const patched = { ...manifest, items };

  for (const [index, record] of req.records.entries()) {
    if (record.destinationIdentity.kind !== 'absent') {
      throw new Error(`adoption destination already exists: ${record.storePath}`);
    }
    const stagedStore = join(stagingRoot, 'store', String(index));
    const stagedSurface = join(stagingRoot, 'surface', String(index));
    await mkdir(dirname(stagedStore), { recursive: true });
    await cp(record.surfacePath, stagedStore, { recursive: true, verbatimSymlinks: true });
    if (!identitiesEqual(
      record.sourceIdentity,
      await capturePathIdentity(record.surfacePath),
    )) {
      throw new Error(`adoption source changed while staging: ${record.surfacePath}`);
    }
    await mkdir(dirname(stagedSurface), { recursive: true });
    await symlink(record.storePath, stagedSurface);
    entries.push({
      id: `store-${index}`,
      target: record.storePath,
      staged: stagedStore,
      expectedPreIdentity: record.destinationIdentity,
    });
    entries.push({
      id: `surface-${index}`,
      target: record.surfacePath,
      staged: stagedSurface,
      expectedPreIdentity: record.sourceIdentity,
    });
    addItem(patched, manifestItem(record));
  }

  const gitSteps = req.records.map((record, index) => ({
    id: `adopt-${index}`,
    message: `agentenv: adopt ${record.storeKind.slice(0, -1)} ${record.name} → ${record.ownerEnv}`,
    paths: [record.storePath],
  }));
  return publishWithPendingNotice({
    paths: req.paths,
    transactionId: req.transactionId,
    kind: req.kind,
    stagingRoot,
    allowedRoots: [req.paths.store, ...req.records.map((record) => record.surface.dir)],
    entries,
    statePatch: { items: patched.items },
    gitSteps,
    gitBookkeeping: () => commitRequiredSteps(
      req.syncCtx,
      gitSteps,
      req.notices,
      req.transactionId,
    ),
  }, req.notices);
}
