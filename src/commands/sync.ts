import { readFile } from 'node:fs/promises';
import { parseArgs } from '../args.js';
import type { Command, CommandContext, RunResult } from '../command.js';
import {
  abortRebase,
  clearConflictMarker,
  commitStore,
  type ConflictedFile,
  continueRebase,
  getRemoteUrl,
  listConflictedFiles,
  pullRebase,
  rebaseInProgress,
  storeIsRepo,
  writeConflictMarker,
} from '../git.js';
import { ensureStore } from '../store.js';
import { closeStoreSync, noteBlockedCommit, openStoreSync } from './store-sync.js';

/**
 * `agentenv sync` — a manual store sync (design D9, Task 2.2). It runs the same
 * pull-on-invoke + one-push lifecycle every mutating command wraps, but as an
 * explicit user action with a plain-English report of what happened.
 *
 * - **clean state** → drift-commit → `git pull --rebase` → post-pull safeguards →
 *   one fail-soft push; reports pulled / pushed / queued / offline.
 * - **rebase conflict** → 2.1 aborts the rebase so the store keeps working from the
 *   working tree; sync reports it is BLOCKED and points at `agentenv sync --resolve`
 *   (exit 1). A conflict halts SYNC only — never local function.
 * - **`--resolve`** → re-enters the held conflict, shows the conflicted store files
 *   (plain YAML/Markdown), lets the human resolve them on disk (the injected
 *   {@link CommandContext} `resolveConflicts` seam, else the guided two-step flow),
 *   then `git rebase --continue`s and completes the sync so BOTH sides land.
 * - **`--abort`** → cancels the resolution and keeps the local version intact.
 *
 * agentenv NEVER auto-resolves, auto-merges, or force-pushes.
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

    if (parsed.booleans.has('abort')) return abortSync(ctx);
    if (parsed.booleans.has('resolve')) return resolveSync(ctx);
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

/**
 * `agentenv sync --resolve` — the guided walkthrough for a REAL rebase conflict.
 *
 * A normal invocation aborts the conflicting rebase (2.1) so nothing local breaks,
 * which means the conflict is NOT sitting on disk as an in-progress rebase. So the
 * first `--resolve` re-enters it (`pull --rebase` holding the conflict), then either
 * the injected resolver drives it to completion in one shot, or — with no resolver —
 * shows the conflicted files and stops for the user to edit on disk and re-run.
 * NEVER auto-resolves.
 */
async function resolveSync(ctx: CommandContext): Promise<RunResult> {
  const { paths, env, options } = ctx;
  await ensureStore(paths);
  if (!(await storeIsRepo(paths))) {
    return ok('sync --resolve: the store is not a git repository yet — run `agentenv init` first.\n');
  }

  const notices: string[] = [];
  const wasInProgress = await rebaseInProgress(paths);

  // Not already mid-rebase → clean the tree, then re-enter the conflict (held).
  if (!wasInProgress) {
    const drift = await commitStore(paths, env, 'agentenv: sync drift', options.gitRun);
    if (drift.status === 'blocked') {
      noteBlockedCommit(drift, notices);
      return fail(`${notices.join('\n')}\nsync --resolve: could not commit local drift; resolve the secret first.\n`);
    }

    const pull = await pullRebase(paths, env, {
      holdConflict: true,
      ...(options.gitRun ? { run: options.gitRun } : {}),
    });
    if (pull.status === 'no-remote') return ok('sync --resolve: no remote configured — nothing to resolve.\n');
    if (pull.status === 'nothing') return ok('sync --resolve: nothing to resolve (no local history yet).\n');
    if (pull.status === 'offline' || pull.status === 'error') {
      return fail(`sync --resolve: cannot resolve right now — ${pull.detail ?? 'the remote is unreachable'}. Try again when online.\n`);
    }
    if (pull.status === 'ok') {
      // No conflict after all — a clean pull. Finish the sync and clear any marker.
      await clearConflictMarker(paths);
      const push = await closeStoreSync(ctx, notices);
      const line = push?.status === 'ok' ? ' Pushed local changes.' : '';
      return withStderr({ stdout: `sync --resolve: no conflict to resolve — pulled cleanly.${line}\n`, code: 0 }, notices);
    }
    // pull.status === 'conflict' → the rebase is now in progress (held).
    await writeConflictMarker(paths, pull.detail ?? 'store history diverged');
  }

  return driveResolution(ctx, notices, options.resolveConflicts);
}

/**
 * Walk the held rebase to completion. The gate before every `git rebase --continue`
 * is that the conflicted files carry NO leftover conflict markers — so agentenv only
 * ever commits a genuinely-resolved tree, never a marker-laden one, whether the
 * resolution came from the injected resolver or the user's on-disk edits. Re-running
 * `--resolve` before resolving is therefore a safe no-op that just re-lists the files.
 */
async function driveResolution(
  ctx: CommandContext,
  notices: string[],
  seam: ((files: readonly ConflictedFile[]) => Promise<boolean>) | undefined,
): Promise<RunResult> {
  const { paths, env, options } = ctx;
  const MAX_STEPS = 50; // guard against a pathological rebase series

  for (let step = 0; step < MAX_STEPS && (await rebaseInProgress(paths)); step++) {
    const files = await listConflictedFiles(paths, env, options.gitRun);

    if (files.length > 0) {
      if (seam) {
        const resolved = await seam(files);
        if (!resolved) {
          await abortRebase(paths, env, options.gitRun);
          await clearConflictMarker(paths);
          return withStderr(
            { stdout: 'sync --resolve: cancelled — the rebase was aborted; your local store is unchanged.\n', code: 0 },
            notices,
          );
        }
        // Guard: the resolver claimed done but left markers → never commit garbage.
        const stillMarked = await filesStillMarked(files);
        if (stillMarked.length > 0) {
          await abortRebase(paths, env, options.gitRun);
          await clearConflictMarker(paths);
          return fail(
            'sync --resolve: the resolver left unresolved conflict markers in:\n' +
              `${stillMarked.map((p) => `  ${p}`).join('\n')}\n` +
              'The rebase was aborted; your local store is unchanged.\n',
          );
        }
      } else {
        // No resolver: only continue once the human removed the markers on disk.
        // Until then, list the still-conflicted files and stop (idempotent).
        const stillMarked = await filesStillMarked(files);
        if (stillMarked.length > 0) return manualPending(files, notices);
      }
    }

    // Stage the (human-)resolved tree and continue the rebase.
    const cont = await continueRebase(paths, env, options.gitRun);
    if (cont.code !== 0) {
      // A LATER commit in the series conflicted → surface the new files and stop
      // (the seam loop would otherwise spin); if it is not a conflict, it is a real error.
      if (await rebaseInProgress(paths)) {
        const remaining = await listConflictedFiles(paths, env, options.gitRun);
        if (remaining.length > 0) {
          if (seam) continue; // let the resolver handle the next batch
          return manualPending(remaining, notices);
        }
      }
      const detail = firstLine(cont.stderr) || firstLine(cont.stdout) || 'rebase --continue failed';
      return fail(`sync --resolve: ${detail}\nThe rebase is left in progress; run \`agentenv sync --abort\` to cancel.\n`);
    }
  }

  if (await rebaseInProgress(paths)) {
    return fail('sync --resolve: the rebase is still in progress — re-run `agentenv sync --resolve`.\n');
  }

  // Resolved: clear the marker and complete the sync (one push lands both sides).
  await clearConflictMarker(paths);
  const push = await closeStoreSync(ctx, notices);
  const pushLine =
    push?.status === 'ok'
      ? ' Pushed the reconciled history.'
      : push?.status === 'queued'
        ? ' The push is queued (remote unreachable) and will flush on the next reachable invocation.'
        : '';
  return withStderr(
    { stdout: `sync --resolve: resolved the conflict and completed the sync.${pushLine}\n`, code: 0 },
    notices,
  );
}

/** `agentenv sync --abort` — cancel a resolution and keep the local version intact. */
async function abortSync(ctx: CommandContext): Promise<RunResult> {
  const { paths, env, options } = ctx;
  await ensureStore(paths);
  if (!(await storeIsRepo(paths))) {
    return ok('sync --abort: the store is not a git repository — nothing to abort.\n');
  }

  if (await rebaseInProgress(paths)) {
    const res = await abortRebase(paths, env, options.gitRun);
    if (res.code !== 0) {
      return fail(`sync --abort: git rebase --abort failed — ${firstLine(res.stderr) || 'unknown error'}\n`);
    }
  }
  await clearConflictMarker(paths);
  return ok('sync --abort: cancelled — the store is unchanged and your local content is intact.\n');
}

/** Show the conflicted store files with plain-YAML/Markdown guidance and stop (exit 1). */
function manualPending(files: readonly ConflictedFile[], notices: readonly string[]): RunResult {
  const list = files.length > 0 ? files.map((f) => `  ${f.path}`).join('\n') : '  (no files reported)';
  const prefix = notices.length > 0 ? `${notices.join('\n')}\n` : '';
  return {
    stdout: '',
    stderr:
      `${prefix}sync --resolve: a rebase conflict needs your help. These store files conflict:\n` +
      `${list}\n` +
      'The store is plain YAML/Markdown — edit each file to the content you want (remove the\n' +
      '`<<<<<<<` / `=======` / `>>>>>>>` markers), then run `agentenv sync --resolve` again to\n' +
      'continue, or `agentenv sync --abort` to cancel and keep your local version.\n',
    code: 1,
  };
}

/**
 * Which of `files` still carry git conflict markers on disk (i.e. are NOT yet
 * resolved). Requires BOTH a `<<<<<<<` and a `>>>>>>>` start/end marker at line
 * start, so a Markdown `=======` heading underline in a legitimately-resolved store
 * file is never mistaken for an unresolved conflict. Unreadable files are treated as
 * resolved (nothing to gate on).
 */
async function filesStillMarked(files: readonly ConflictedFile[]): Promise<string[]> {
  const marked: string[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = await readFile(f.absPath, 'utf8');
    } catch {
      continue;
    }
    if (/^<{7}[ \t]/m.test(text) && /^>{7}[ \t]/m.test(text)) marked.push(f.path);
  }
  return marked;
}

/** First non-empty trimmed line — compact diagnostics without leaking a multi-line dump. */
function firstLine(text: string): string {
  return text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '') ?? '';
}

/** Attach accumulated sync notices to a result's stderr (nothing added when empty). */
function withStderr(result: RunResult, notices: readonly string[]): RunResult {
  if (notices.length === 0) return result;
  return { ...result, stderr: `${result.stderr ?? ''}${notices.join('\n')}\n` };
}

function ok(stdout: string): RunResult {
  return { stdout, code: 0 };
}
function fail(stderr: string): RunResult {
  return { stdout: '', stderr, code: 1 };
}
