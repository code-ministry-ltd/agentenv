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
    transactionId?: string,
  ) => Promise<void>;
}

export interface PublishDriftSweepResult {
  result: DriftSweepResult;
  publication: 'no-change' | 'complete' | 'git-pending' | 'blocked';
  blockedReason?: 'secret';
  transactionId?: string;
}

function isSecretScanBlock(error: unknown): boolean {
  return error instanceof Error &&
    /required Git bookkeeping .* is 'blocked'/.test(error.message);
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
  // Existing working-tree drift needs no local WAL: there is no effect to undo
  // or recover. Attempt its scoped commit directly so a secret-scan refusal does
  // not manufacture a git-pending command in state.json.
  if (planned.entries.length === 0 && !planned.statePatch && gitSteps.length > 0) {
    try {
      if (!req.gitBookkeeping) throw new Error('drift sweep requires Git bookkeeping');
      await req.gitBookkeeping(gitSteps);
      await rm(stagingRoot, { recursive: true, force: true });
      return { result: planned.result, publication: 'complete', transactionId };
    } catch (error) {
      if (isSecretScanBlock(error)) {
        await rm(stagingRoot, { recursive: true, force: true });
        return {
          result: planned.result,
          publication: 'blocked',
          blockedReason: 'secret',
        };
      }
      // Ordinary Git/index failures retain the established git-pending command
      // so recovery can retry required bookkeeping. Only a proven secret block
      // is safe to refuse without manufacturing recovery state.
    }
  }
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
