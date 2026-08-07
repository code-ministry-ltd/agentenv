import { randomUUID } from 'node:crypto';
import { adapters as realAdapters } from '../adapters/index.js';
import type { Adapter } from '../adapter.js';
import { adoptSweep } from '../adopt.js';
import { publishAdoptions } from '../adoption-publication.js';
import type { PlannedGitStep } from '../command-plan.js';
import type { RunOptions, RunResult } from '../command.js';
import {
  type CommitResult,
  commitStore,
  commitStorePaths,
  describeFindings,
} from '../git.js';
import { collectLifecycleGarbage } from '../lifecycle-gc.js';
import { publishDriftSweep } from '../drift-publication.js';
import { withLock } from '../lock.js';
import type { Paths } from '../paths.js';
import { readState, writeState } from '../state.js';
import { beginStoreSync, endStoreSync, type SyncBeforeResult } from '../sync.js';

/**
 * Thin command-layer wiring for the Task 2.1 git-sync lifecycle. Each store-mutating
 * command wraps its mutation in {@link withStoreSync}: pull-on-invoke (drift-commit
 * → `git pull --rebase` → post-pull safeguards) BEFORE, one fail-soft push AFTER,
 * and a per-mutation commit in between. Everything is a no-op when the store is not
 * a git repo, so a non-synced install behaves exactly as before.
 */

/** Adapters in scope for the drift sweep / reconcile — the injected set or the real registry. */
export function inScopeAdapters(options: RunOptions): readonly Adapter[] {
  return options.adapters ?? realAdapters;
}

/** The minimal context the sync wiring needs from a command invocation. */
export interface SyncCtx {
  paths: Paths;
  env: NodeJS.ProcessEnv;
  options: RunOptions;
}

export class PendingCommandError extends Error {
  constructor(readonly transactionId: string) {
    super(
      `required Git bookkeeping is still pending for command '${transactionId}'; ` +
        `run \`agentenv resolve command ${transactionId} --retry\` before another mutation`,
    );
    this.name = 'PendingCommandError';
  }
}

/** Push a loud notice when an auto-commit was BLOCKED by the pre-commit secret scan (D9). */
export function noteBlockedCommit(result: CommitResult, notices: string[]): void {
  if (result.status === 'blocked') {
    notices.push(
      'agentenv: NOT committed — a suspected secret would be written to the synced store:\n' +
        `${describeFindings(result.findings ?? [])}\n` +
        'Replace it with a ${VAR} placeholder (values live in ~/.agentenv/secrets.env), then re-run. ' +
        'If it is a documented example (not a real secret), mark the line `agentenv:allow-secret`.',
    );
  }
}

/**
 * Commit one store mutation with a descriptive message, noting a secret-scan block.
 *
 * Fail-soft (D9, symmetric with {@link beginStoreSync}'s drift-commit): the local
 * mutation has already landed on disk, so a git commit that throws (a locked index,
 * a broken repo) must only WARN — never abort the command that made the change.
 */
export async function commitMutation(ctx: SyncCtx, message: string, notices: string[]): Promise<void> {
  try {
    const result = await commitStore(ctx.paths, ctx.env, message, ctx.options.gitRun);
    noteBlockedCommit(result, notices);
  } catch (err) {
    notices.push(
      `agentenv: commit skipped — ${(err as Error).message}. ` +
        'Your change is saved locally in the store working tree; the next store command will commit it.',
    );
  }
}

/** Required local commit for a whole-command WAL; unsafe statuses keep it pending. */
export async function commitRequiredMutation(
  ctx: SyncCtx,
  message: string,
  notices: string[],
): Promise<void> {
  const result = await commitStore(ctx.paths, ctx.env, message, ctx.options.gitRun);
  noteBlockedCommit(result, notices);
  if (result.status === 'blocked' || result.status === 'rebase-in-progress') {
    throw new Error(`required Git bookkeeping is '${result.status}'`);
  }
}

/** Execute persisted, ordered, path-scoped commits for command-WAL recovery. */
export async function commitRequiredSteps(
  ctx: SyncCtx,
  steps: readonly PlannedGitStep[],
  notices: string[],
  transactionId?: string,
): Promise<void> {
  for (const step of steps) {
    if (transactionId) {
      const complete = await withLock(ctx.paths, async () => {
        const command = (await readState(ctx.paths)).commands.find(
          (candidate) => candidate.transactionId === transactionId,
        );
        const durable = command?.gitSteps?.find((candidate) => candidate.id === step.id);
        if (!durable) throw new Error(`required Git bookkeeping '${step.id}' is not in the durable plan`);
        return durable.status === 'complete';
      });
      if (complete) continue;
    }
    const result = await commitStorePaths(
      ctx.paths,
      ctx.env,
      step.message,
      step.paths,
      ctx.options.gitRun,
    );
    noteBlockedCommit(result, notices);
    if (result.status === 'blocked' || result.status === 'rebase-in-progress') {
      throw new Error(`required Git bookkeeping '${step.id}' is '${result.status}'`);
    }
    if (transactionId) {
      await withLock(ctx.paths, async () => {
        const manifest = await readState(ctx.paths);
        const command = manifest.commands.find(
          (candidate) => candidate.transactionId === transactionId,
        );
        const durable = command?.gitSteps?.find((candidate) => candidate.id === step.id);
        if (!durable) throw new Error(`required Git bookkeeping '${step.id}' disappeared from the durable plan`);
        durable.status = 'complete';
        if (result.commitId) durable.commitId = result.commitId;
        await writeState(ctx.paths, manifest);
      });
    }
  }
}

/** START the sync lifecycle: pull-on-invoke + post-pull safeguards (design D9). */
export async function openStoreSync(
  ctx: SyncCtx,
  notices: string[],
  opts: {
    alreadySwept?: boolean;
    skipAdopt?: boolean;
    skipFetch?: boolean;
    stopOnDriftBlocked?: boolean;
  } = {},
): Promise<SyncBeforeResult> {
  const { paths, env, options } = ctx;
  const result = await beginStoreSync({
    paths,
    env,
    adapters: inScopeAdapters(options),
    onNotice: (n) => notices.push(n),
    ...(options.gitRun ? { gitRun: options.gitRun } : {}),
    ...(options.globals?.offline ? { offline: true } : {}),
    ...(opts.alreadySwept ? { alreadySwept: true } : {}),
    ...(opts.skipAdopt ? { skipAdopt: true } : {}),
    ...(opts.skipFetch ? { skipFetch: true } : {}),
    ...(opts.stopOnDriftBlocked ? { stopOnDriftBlocked: true } : {}),
    ...(!opts.alreadySwept ? {
      publishDrift: async () => {
        const published = await publishDriftSweep({
          paths,
          adapters: inScopeAdapters(options),
          env,
          notices,
          onWarn: (notice) => notices.push(notice),
          ...(options.gitRun ? { gitRun: options.gitRun } : {}),
          gitBookkeeping: (steps, transactionId) =>
            commitRequiredSteps(ctx, steps, notices, transactionId),
        });
        return {
          publication: published.publication,
          ...(published.blockedReason
            ? { blockedReason: published.blockedReason }
            : {}),
          ...(published.transactionId ? { transactionId: published.transactionId } : {}),
        };
      },
    } : {}),
    ...(!opts.skipAdopt ? {
      publishAdoptions: async () => {
        const planned = await adoptSweep({
          paths,
          dryRun: true,
          note: (notice) => notices.push(notice),
        });
        if (planned.adopted.length === 0) return { publication: 'no-change' as const };
        const transactionId = `auto-capture-${randomUUID()}`;
        const publication = await publishAdoptions({
          paths,
          transactionId,
          kind: 'capture',
          records: planned.adopted,
          notices,
          gitBookkeeping: (steps) =>
            commitRequiredSteps(ctx, steps, notices, transactionId),
        });
        return { publication, transactionId };
      },
    } : {}),
  });
  if (result.pendingCommand) throw new PendingCommandError(result.pendingCommand);
  return result;
}

/** END the sync lifecycle: the single fail-soft push (design D9). Returns the push
 *  outcome so a reporting caller (`agentenv sync`) can say what happened. */
export async function closeStoreSync(ctx: SyncCtx, notices: string[]): ReturnType<typeof endStoreSync> {
  const { paths, env, options } = ctx;
  const push = await endStoreSync({
    paths,
    env,
    onNotice: (n) => notices.push(n),
    ...(options.gitRun ? { gitRun: options.gitRun } : {}),
    ...(options.globals?.offline ? { offline: true } : {}),
  });
  try {
    await collectLifecycleGarbage(paths, { limit: 4 });
  } catch (error) {
    notices.push(`agentenv: lifecycle cleanup skipped — ${(error as Error).message}`);
  }
  return push;
}

/**
 * Run `body` inside the sync lifecycle. `openStoreSync` runs first (pull-on-invoke
 * + safeguards), then `body` performs the mutation and returns the commit message
 * (or `null` when it already committed its own — `add skills` commits per skill).
 * One push runs last. Returns the {@link SyncBeforeResult} so a materialising
 * command can honour a `quarantined` pulled tree.
 *
 * NOTE: `body` runs AFTER the pull, so the mutation it makes is committed under its
 * own message — never swept as `agentenv: sync drift`. A command whose mutation must
 * run mid-lifecycle for another reason (e.g. `edit` launching an editor that can
 * abort) uses {@link openStoreSync}/{@link commitMutation}/{@link closeStoreSync}
 * directly to keep the same ordering.
 */
export async function withStoreSync(
  ctx: SyncCtx,
  notices: string[],
  body: () => Promise<string | null>,
  opts: { alreadySwept?: boolean; skipAdopt?: boolean } = {},
): Promise<SyncBeforeResult> {
  const before = await openStoreSync(ctx, notices, opts);
  const message = await body();
  if (message !== null) {
    await commitMutation(ctx, message, notices);
  }
  await closeStoreSync(ctx, notices);
  return before;
}

/** Fold accumulated sync notices into a command result's stderr (nothing added when empty). */
export function withNotices(result: RunResult, notices: readonly string[]): RunResult {
  if (notices.length === 0) return result;
  const stderr = `${result.stderr ?? ''}${notices.join('\n')}\n`;
  return { ...result, stderr };
}
