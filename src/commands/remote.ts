import { parseArgs } from '../args.js';
import type { Command, CommandContext, RunResult } from '../command.js';
import {
  addRemote,
  ensureStoreRepo,
  getRemoteUrl,
  normaliseRemoteUrl,
  probeRemote,
  pushStore,
  redactRemoteUrl,
  removeRemote,
} from '../git.js';
import { ensureStore } from '../store.js';

/**
 * `agentenv remote <url>` — connect the single sync remote (design D14).
 *
 * This task implements the **empty-remote / first-connect** case only:
 *
 * - No remote configured + an EMPTY (or currently-unreachable) target → connect it
 *   and push local history with a normal non-force push (an unreachable target is
 *   connected with the push queued, since migration to a temporarily-down remote
 *   must still work).
 * - Same normalised URL already configured → idempotent no-op.
 * - A DIFFERENT remote already configured, or a NON-EMPTY target → the
 *   same/related/unrelated classification + safe replacement is **Task 2.3**. We
 *   refuse cleanly, leaving all local state untouched (SEAM for 2.3).
 *
 * Never force-pushes; never logs credentials (URLs are redacted).
 */
export const remoteCommand: Command = {
  name: 'remote',
  usage: '<url>',
  summary: 'Connect (or, in 2.3, safely replace) the single sync remote',

  async run(ctx): Promise<RunResult> {
    const parsed = parseArgs(ctx.args, {});
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

    const existing = await getRemoteUrl(paths, env, options.gitRun);
    if (existing) {
      if (normaliseRemoteUrl(existing) === normaliseRemoteUrl(url)) {
        return ok(`Remote already set to ${redactRemoteUrl(url)} — no change.\n`);
      }
      // Safe replacement / history classification is Task 2.3.
      return fail(
        `remote: a different remote is already configured (${redactRemoteUrl(existing)}).\n` +
          'Safely replacing an existing remote (same/related/unrelated history classification) ' +
          'is Task 2.3 — the current remote was left unchanged.\n',
      );
    }

    return connectRemote(ctx, url);
  },
};

/** Connect the FIRST remote (empty / first-connect case, D14). */
async function connectRemote(ctx: CommandContext, url: string): Promise<RunResult> {
  const { paths, env, options } = ctx;
  const redacted = redactRemoteUrl(url);

  await addRemote(paths, env, url, options.gitRun);
  const probe = await probeRemote(paths, env, options.gitRun ? { run: options.gitRun } : {});

  if (probe.status === 'nonempty') {
    // A populated remote needs same/related/unrelated classification — Task 2.3.
    await removeRemote(paths, env, options.gitRun);
    return fail(
      `remote: ${redacted} already has history. Connecting to a NON-EMPTY remote (classifying it as ` +
        'the same / a related / an unrelated store, and safely adopting or replacing) is Task 2.3.\n' +
        'The remote was NOT connected; nothing changed.\n',
    );
  }

  // Empty or currently-unreachable → connect and push local history (queued if offline).
  const push = await pushStore(paths, env, {
    ...(options.gitRun ? { run: options.gitRun } : {}),
    ...(options.now ? { now: options.now } : {}),
  });

  if (push.status === 'ok' || push.status === 'nothing') {
    return ok(`Connected remote ${redacted} and pushed the local store.\n`);
  }
  if (push.status === 'queued') {
    return ok(
      `Connected remote ${redacted}. The remote is unreachable right now — the initial push is ` +
        'queued and will flush on the next invocation that reaches it.\n',
    );
  }
  // no-repo / no-remote should not happen here (we just added the remote).
  return ok(`Connected remote ${redacted}.\n`);
}

function ok(stdout: string): RunResult {
  return { stdout, code: 0 };
}
function fail(stderr: string): RunResult {
  return { stdout: '', stderr, code: 1 };
}
