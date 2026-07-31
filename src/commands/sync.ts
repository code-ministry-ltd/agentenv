import { parseArgs } from '../args.js';
import type { Command, CommandContext, RunResult } from '../command.js';
import { getRemoteUrl, storeIsRepo } from '../git.js';
import { ensureStore } from '../store.js';
import { closeStoreSync, openStoreSync } from './store-sync.js';

/**
 * `agentenv sync` — a manual store sync (design D9, Task 2.2). It runs the same
 * pull-on-invoke + one-push lifecycle every mutating command wraps, but as an
 * explicit user action with a plain-English report of what happened.
 *
 * - **clean state** → drift-commit → `git pull --rebase` → post-pull safeguards →
 *   one fail-soft push; reports pulled / pushed / queued / offline.
 * - **rebase conflict** → 2.1 aborts the rebase so the store keeps working from the
 *   working tree; sync reports it is BLOCKED and points at `agentenv sync --resolve`
 *   (exit 1). A conflict halts SYNC only — never local function. Slice 3 adds the
 *   `--resolve` / `--abort` walkthrough; a conflict is NEVER auto-resolved.
 */
export const syncCommand: Command = {
  name: 'sync',
  usage: '[--resolve | --abort]',
  summary: 'Manually sync the store (pull-rebase + push); --resolve walks through a conflict',

  async run(ctx): Promise<RunResult> {
    const parsed = parseArgs(ctx.args, { booleans: ['resolve', 'abort'] });
    if (parsed.unknown.length > 0) {
      return fail(`sync: unknown option '${parsed.unknown[0]}'\nUsage: agentenv sync [--resolve | --abort]\n`);
    }
    if (parsed.positionals.length > 0) {
      return fail(`sync: unexpected argument '${parsed.positionals[0]}'\nUsage: agentenv sync [--resolve | --abort]\n`);
    }
    if (parsed.booleans.has('resolve') && parsed.booleans.has('abort')) {
      return fail('sync: --resolve and --abort are mutually exclusive\n');
    }

    return plainSync(ctx);
  },
};

/** A clean/normal manual sync: pull-on-invoke + one push, with a human report. */
async function plainSync(ctx: CommandContext): Promise<RunResult> {
  const { paths, env, options } = ctx;
  await ensureStore(paths);

  if (!(await storeIsRepo(paths))) {
    return ok('sync: the store is not a git repository yet — run `agentenv init` first.\n');
  }

  const remote = await getRemoteUrl(paths, env, options.gitRun);
  const notices: string[] = [];
  const before = await openStoreSync({ paths, env, options }, notices);
  const push = await closeStoreSync({ paths, env, options }, notices);

  const stderr = notices.length > 0 ? `${notices.join('\n')}\n` : undefined;

  // A conflict halts SYNC only (the local store keeps working). Report it as blocked
  // and point at the resolve walkthrough; exit non-zero so a script knows sync did
  // not complete.
  if (before.conflicted) {
    return {
      stdout: '',
      stderr:
        (stderr ?? '') +
        'sync: blocked by a rebase conflict — run `agentenv sync --resolve` to walk through it ' +
        '(or `agentenv sync --abort` to cancel and keep local). Your store still works locally.\n',
      code: 1,
    };
  }

  const report: string[] = [];
  if (!remote) {
    report.push('Synced locally — no remote is configured (run `agentenv remote <url>` to sync across machines).');
  } else {
    report.push(before.pulled ? 'Pulled remote changes.' : 'No remote changes to pull (already up to date or offline).');
    if (before.quarantined) {
      report.push('Pulled changes were QUARANTINED (malformed or secret-bearing) and NOT materialised — see the warnings above.');
    }
    switch (push?.status) {
      case 'ok':
        report.push('Pushed local changes.');
        break;
      case 'nothing':
        report.push('Nothing to push.');
        break;
      case 'queued':
        report.push('Push queued — the remote is unreachable; it will flush on the next invocation that reaches it.');
        break;
      case 'no-remote':
        report.push('Nothing to push (no remote).');
        break;
      default:
        break;
    }
  }

  return { stdout: `${report.join('\n')}\n`, ...(stderr ? { stderr } : {}), code: 0 };
}

function ok(stdout: string): RunResult {
  return { stdout, code: 0 };
}
function fail(stderr: string): RunResult {
  return { stdout: '', stderr, code: 1 };
}
