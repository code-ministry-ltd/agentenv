import { parseArgs } from '../args.js';
import type { Command, CommandContext, RunResult } from '../command.js';
import {
  addRemote,
  classifyRemoteHistory,
  cleanupCandidateRefs,
  commitStore,
  ensureStoreRepo,
  getRemoteUrl,
  normaliseRemoteUrl,
  pushStore,
  pushUrl,
  rebaseInProgress,
  redactRemoteUrl,
  setRemoteUrl,
} from '../git.js';
import { ensureStore } from '../store.js';
import { closeStoreSync, openStoreSync } from './store-sync.js';

/**
 * `agentenv remote <url>` — connect or SAFELY REPLACE the single sync remote
 * (design D14, spec criterion 8). Replacement classifies the candidate's history
 * before committing to it, and the configured URL flips only as the LAST step, after
 * the chosen action succeeds — so a fault at any step (probe, fetch, push, integrate,
 * archive) leaves the OLD remote configured and all local content intact.
 *
 * Classification (via `git ls-remote` + fetch + `merge-base`, against the candidate
 * URL directly so `origin` is never touched mid-flight):
 *
 * - **same** (candidate == configured, normalised): idempotent no-op + an ordinary sync.
 * - **empty** remote: receive the full local history via a NORMAL (non-force) push,
 *   then flip.
 * - **related** history (a shared commit): integrate under the normal rebase rules,
 *   then flip; a conflict leaves the old URL configured and local state untouched.
 * - **unrelated** non-empty history: REFUSE non-interactively (`--non-interactive` /
 *   `--offline`); interactively DEFAULT to cancel, offering archive-local-and-adopt —
 *   which archives the local store to a recoverable copy BEFORE adopting the remote.
 * - **unreachable** candidate: clear error, change nothing (old remote/URL/content intact).
 *
 * Never force-pushes; never auto-merges unrelated histories; never logs credentials
 * (every URL is redacted).
 */
export const remoteCommand: Command = {
  name: 'remote',
  usage: '<url> [--non-interactive] [--offline]',
  summary: 'Connect or safely replace the single sync remote (design D14)',

  async run(ctx): Promise<RunResult> {
    const parsed = parseArgs(ctx.args, { booleans: ['non-interactive', 'offline'] });
    if (parsed.unknown.length > 0) {
      return fail(`remote: unknown option '${parsed.unknown[0]}'\n`);
    }
    const url = parsed.positionals[0];
    if (url === undefined || url.trim() === '') {
      return fail('remote: missing <url>\nUsage: agentenv remote <url>\n');
    }
    if (parsed.positionals.length > 1) {
      return fail(`remote: unexpected argument '${parsed.positionals[1]}'\nUsage: agentenv remote <url>\n`);
    }

    const { paths, env, options } = ctx;
    await ensureStore(paths);
    await ensureStoreRepo(paths, env, options.gitRun);

    // A HELD `sync --resolve` two-step must be finished before re-pointing the remote:
    // classification/push would race a marker-laden index (D9, Task 2.2). Refuse cleanly.
    if (await rebaseInProgress(paths)) {
      return fail(
        'remote: a conflict resolution is in progress — finish it with `agentenv sync --resolve` ' +
          '(or cancel with `agentenv sync --abort`) before changing the remote.\n',
      );
    }

    const existing = await getRemoteUrl(paths, env, options.gitRun);

    // SAME normalised URL → idempotent no-op, then an ordinary sync (design D14).
    if (existing && normaliseRemoteUrl(existing) === normaliseRemoteUrl(url)) {
      return sameRemoteSync(ctx, url);
    }

    // Flush local drift into a commit BEFORE probing, so the full local history is
    // available to push. The OLD remote does NOT need to be reachable for this — we
    // never pull from it here (migration away from a dead remote must work).
    const drift = await commitStore(paths, env, 'agentenv: sync drift', options.gitRun);
    if (drift.status === 'blocked') {
      return fail(
        'remote: local store drift contains a suspected secret and was NOT committed — resolve it ' +
          '(use a ${VAR} placeholder) before changing the remote. Nothing was changed.\n',
      );
    }

    // Classify the candidate against the local store. `origin` is untouched here.
    const classification = await classifyRemoteHistory(paths, env, url, options.gitRun ? { run: options.gitRun } : {});
    try {
      switch (classification.status) {
        case 'unreachable':
          return unreachableCandidate(ctx, url, existing, classification.detail);
        case 'empty':
          return adoptEmpty(ctx, url, existing);
        case 'related':
          // Integrate + adopt a related history — implemented in a later slice.
          return fail(
            `remote: ${redactRemoteUrl(url)} shares history with the local store (a related remote). ` +
              'Integrating and adopting a related remote is not yet available; nothing was changed.\n',
          );
        case 'unrelated':
          // Refuse / archive-and-adopt an unrelated history — implemented in a later slice.
          return fail(
            `remote: ${redactRemoteUrl(url)} has an unrelated history (no shared commit with the local store). ` +
              'Adopting an unrelated remote is not yet available; nothing was changed.\n',
          );
        default:
          return fail('remote: could not classify the candidate remote; nothing was changed.\n');
      }
    } finally {
      // Never leave the private classification refs behind — win, lose, or throw.
      await cleanupCandidateRefs(paths, env, options.gitRun);
    }
  },
};

/**
 * The SAME URL is already configured (design D14): a no-op re-point, then an ordinary
 * sync (pull-on-invoke + one push), reported plainly. The URL is left exactly as-is.
 */
async function sameRemoteSync(ctx: CommandContext, url: string): Promise<RunResult> {
  const { paths, env, options } = ctx;
  const notices: string[] = [];
  await openStoreSync({ paths, env, options }, notices);
  await closeStoreSync({ paths, env, options }, notices);
  const stderr = notices.length > 0 ? `${notices.join('\n')}\n` : undefined;
  return {
    stdout: `Remote already set to ${redactRemoteUrl(url)} — no change; synced.\n`,
    ...(stderr ? { stderr } : {}),
    code: 0,
  };
}

/**
 * EMPTY candidate (design D14): push the full local history with a NORMAL, non-force
 * push, THEN flip `origin` to the candidate — the flip is the last step, so a push
 * failure leaves the old remote (or, on a first connect, no remote) configured and
 * the local content untouched. Serves both first-connect and safe-replacement.
 */
async function adoptEmpty(ctx: CommandContext, url: string, existing: string | null): Promise<RunResult> {
  const { paths, env, options } = ctx;
  const redacted = redactRemoteUrl(url);

  const push = await pushUrl(paths, env, url, options.gitRun ? { run: options.gitRun } : {});
  if (push.status !== 'ok' && push.status !== 'nothing') {
    const where = existing
      ? `The old remote (${redactRemoteUrl(existing)}) is unchanged`
      : 'Nothing was connected';
    return fail(`remote: could not push the local store to ${redacted} (${push.detail ?? push.status}). ${where}.\n`);
  }

  // Push succeeded — flip the configured URL as the final step (design D14).
  await setRemoteUrl(paths, env, url, options.gitRun);
  const verb = existing ? 'Replaced the remote with' : 'Connected remote';
  return ok(`${verb} ${redacted} and pushed the local store.\n`);
}

/**
 * The candidate is UNREACHABLE (design D14). On a REPLACEMENT, change nothing — the
 * old remote must survive a candidate that is down (and the old remote is never
 * required to be reachable). On a FIRST connect there is nothing to lose, so connect
 * anyway and QUEUE the initial push (migration to a temporarily-down remote must work).
 */
async function unreachableCandidate(
  ctx: CommandContext,
  url: string,
  existing: string | null,
  detail: string | undefined,
): Promise<RunResult> {
  const { paths, env, options } = ctx;
  const redacted = redactRemoteUrl(url);

  if (existing) {
    return fail(
      `remote: ${redacted} is unreachable${detail ? ` (${detail})` : ''}. ` +
        `The old remote (${redactRemoteUrl(existing)}) is unchanged.\n`,
    );
  }

  await addRemote(paths, env, url, options.gitRun);
  const push = await pushStore(paths, env, {
    ...(options.gitRun ? { run: options.gitRun } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  if (push.status === 'queued') {
    return ok(
      `Connected remote ${redacted}. The remote is unreachable right now — the initial push is queued ` +
        'and will flush on the next invocation that reaches it.\n',
    );
  }
  return ok(`Connected remote ${redacted} and pushed the local store.\n`);
}

function ok(stdout: string): RunResult {
  return { stdout, code: 0 };
}
function fail(stderr: string): RunResult {
  return { stdout: '', stderr, code: 1 };
}
