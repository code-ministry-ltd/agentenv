import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { PlannedGitStep } from './command-plan.js';
import { planDriftSweep, type DriftSweepRequest, type DriftSweepResult } from './drift.js';
import { listStoreDirtyPaths, type GitRunner } from './git.js';
import { recoverState } from './journal.js';
import { withLock } from './lock.js';
import { publishWithPendingNotice } from './commands/staged-publication.js';

export interface PublishDriftSweepRequest extends DriftSweepRequest {
  notices: string[];
  gitRun?: GitRunner;
  gitBookkeeping?: (
    steps: readonly PlannedGitStep[],
    transactionId: string,
  ) => Promise<void>;
}

export interface PublishDriftSweepResult {
  result: DriftSweepResult;
  publication: 'no-change' | 'complete' | 'git-pending';
  transactionId?: string;
}

/** Publish one discovered drift sweep, with its required scoped Git commit inside
 * the durable post-local-commit phase. */
export async function publishDriftSweep(
  req: PublishDriftSweepRequest,
): Promise<PublishDriftSweepResult> {
  // Recovery of an old focused journal is an explicit prerequisite, never part
  // of discovery for the new whole-command transaction.
  await withLock(req.paths, () => recoverState(req.paths));
  const transactionId = `drift-${randomUUID()}`;
  const stagingRoot = join(req.paths.live, 'commands', transactionId);
  const planned = await planDriftSweep(req, stagingRoot);
  const gitPaths = [...new Set([
    ...planned.gitPaths,
    ...await listStoreDirtyPaths(req.paths, req.env, req.gitRun),
  ])];
  if (planned.entries.length === 0 && !planned.statePatch && gitPaths.length === 0) {
    await rm(stagingRoot, { recursive: true, force: true });
    return { result: planned.result, publication: 'no-change' };
  }
  const gitSteps = gitPaths.length > 0
    ? [{
        id: 'sync-drift',
        message: 'agentenv: sync drift',
        paths: gitPaths,
      }]
    : [];
  const publication = await publishWithPendingNotice({
    paths: req.paths,
    transactionId,
    kind: 'drift-sweep',
    stagingRoot,
    allowedRoots: planned.allowedRoots,
    entries: planned.entries,
    ...(planned.statePatch ? { statePatch: planned.statePatch } : {}),
    ...(gitSteps.length > 0 ? {
      gitSteps,
      gitBookkeeping: () => req.gitBookkeeping
        ? req.gitBookkeeping(gitSteps, transactionId)
        : Promise.reject(new Error('drift sweep requires Git bookkeeping')),
    } : {}),
  }, req.notices);
  return { result: planned.result, publication, transactionId };
}
