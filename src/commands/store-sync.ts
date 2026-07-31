import { adapters as realAdapters } from '../adapters/index.js';
import type { Adapter } from '../adapter.js';
import type { RunOptions, RunResult } from '../command.js';
import { type CommitResult, commitStore, describeFindings } from '../git.js';
import type { Paths } from '../paths.js';
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

/** Commit one store mutation with a descriptive message, noting a secret-scan block. */
export async function commitMutation(ctx: SyncCtx, message: string, notices: string[]): Promise<void> {
  const result = await commitStore(ctx.paths, ctx.env, message, ctx.options.gitRun);
  noteBlockedCommit(result, notices);
}

/** START the sync lifecycle: pull-on-invoke + post-pull safeguards (design D9). */
export async function openStoreSync(
  ctx: SyncCtx,
  notices: string[],
  opts: { alreadySwept?: boolean } = {},
): Promise<SyncBeforeResult> {
  const { paths, env, options } = ctx;
  return beginStoreSync({
    paths,
    env,
    adapters: inScopeAdapters(options),
    onNotice: (n) => notices.push(n),
    ...(options.gitRun ? { gitRun: options.gitRun } : {}),
    ...(opts.alreadySwept ? { alreadySwept: true } : {}),
  });
}

/** END the sync lifecycle: the single fail-soft push (design D9). */
export async function closeStoreSync(ctx: SyncCtx, notices: string[]): Promise<void> {
  const { paths, env, options } = ctx;
  await endStoreSync({
    paths,
    env,
    onNotice: (n) => notices.push(n),
    ...(options.gitRun ? { gitRun: options.gitRun } : {}),
  });
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
  opts: { alreadySwept?: boolean } = {},
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
