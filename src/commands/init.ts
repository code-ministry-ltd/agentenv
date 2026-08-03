import { access, constants } from 'node:fs/promises';
import { adapters as realAdapters } from '../adapters/index.js';
import { parseArgs } from '../args.js';
import type { Command, CommandContext, RunResult } from '../command.js';
import { cloneStore, ensureStoreRepo, redactRemoteUrl, storeIsRepo } from '../git.js';
import { emptyManifest, writeState } from '../state.js';
import { generateShims } from '../session/shims.js';
import { ensureStore } from '../store.js';
import { remoteCommand } from './remote.js';

/**
 * `agentenv init [--remote <url>]` — one-time setup, safe to re-run (idempotent):
 *
 * 1. `ensureStore` — create `store/environments/` + the generated README.
 * 2. `ensureStoreRepo` — make the store a git repo (Task 2.1/D9): `git init`,
 *    a store `.gitignore`, and a baseline commit. Idempotent; offline; never
 *    touches the network (a remote is connected separately via `agentenv remote`).
 * 3. Initialise `state.json` (the ownership manifest) if it does not exist —
 *    an existing manifest is NEVER clobbered.
 * 4. Install one PATH shim per registered adapter via `generateShims` (an empty
 *    registry — Phase 1 — installs no shims, which is fine).
 * 5. Print the shell hook line so the user can wire session mode into their rc.
 *
 * `--remote <url>` is the NEW-MACHINE RESTORE bootstrap (design D14, spec criterion
 * 5): a machine with no local store yet CLONES the populated remote into the store
 * instead of init-empty-then-classify (a fresh local + populated remote would
 * classify as UNRELATED and refuse to integrate). If the remote is empty or
 * unreachable it falls back to an empty store and CONNECTS the remote (so the first
 * push populates it), with a clear message. If the store already exists, `--remote`
 * connects/replaces it via the same safe `agentenv remote` path.
 */
export const initCommand: Command = {
  name: 'init',
  usage: '[--remote <url>]',
  summary: 'Create the store, manifest and shims; print the shell hook line',

  async run(ctx): Promise<RunResult> {
    const parsed = parseArgs(ctx.args, { values: ['remote'] });
    if (parsed.unknown.length > 0) {
      return {
        stdout: '',
        stderr: `init: unknown option '${parsed.unknown[0]}'\nUsage: agentenv init [--remote <url>]\n`,
        code: 1,
      };
    }
    if (parsed.positionals.length > 0) {
      return {
        stdout: '',
        stderr: `init: unexpected argument '${parsed.positionals[0]}'\nUsage: agentenv init [--remote <url>]\n`,
        code: 1,
      };
    }
    const remoteUrl = (parsed.values.get('remote') ?? '').trim();
    if (remoteUrl !== '' && ctx.options.globals?.offline) {
      return {
        stdout: '',
        stderr: 'init: --remote is disabled by --offline\n',
        code: 1,
      };
    }
    const alreadyRepo = await storeIsRepo(ctx.paths);

    // NEW-MACHINE BOOTSTRAP: a --remote on a machine with no local store yet clones
    // the populated remote (design D14) rather than init-empty + classify-unrelated.
    if (remoteUrl !== '' && !alreadyRepo) {
      const clone = await cloneStore(ctx.paths, ctx.env, remoteUrl, ctx.options.gitRun ? { run: ctx.options.gitRun } : {});
      if (clone.status === 'ok') {
        return finishInit(ctx, {
          headline: `agentenv initialised — cloned the store from ${redactRemoteUrl(remoteUrl)}.`,
        });
      }
      // Empty or unreachable remote → init an empty store and connect the remote
      // below, so the first push populates it. Never fatal.
      const detail = clone.status === 'empty' ? 'is empty' : `is unreachable${clone.detail ? ` (${clone.detail})` : ''}`;
      return finishInit(ctx, {
        headline: 'agentenv initialised.',
        connectRemote: remoteUrl,
        notice:
          `agentenv: the remote ${redactRemoteUrl(remoteUrl)} ${detail} — initialised an empty store and ` +
          'connected the remote; your first push will populate it.',
      });
    }

    // Normal init (no remote), or a re-run over an existing store. A --remote given
    // when the store already exists connects/replaces it via the safe `remote` path.
    return finishInit(ctx, {
      headline: 'agentenv initialised.',
      ...(remoteUrl !== '' ? { connectRemote: remoteUrl } : {}),
    });
  },
};

interface FinishOptions {
  /** First stdout line (differs for a cloned restore). */
  headline: string;
  /** A remote URL to connect via the safe `agentenv remote` path after setup. */
  connectRemote?: string;
  /** An extra stderr notice (e.g. the empty/unreachable-remote fallback message). */
  notice?: string;
}

/**
 * The common init tail: ensure the store skeleton + git repo, the manifest, and the
 * shims, then optionally connect a remote and assemble the report. Runs identically
 * whether the store was just cloned (idempotent no-ops) or is being created fresh.
 */
async function finishInit(ctx: CommandContext, finish: FinishOptions): Promise<RunResult> {
  const { paths, env, options } = ctx;
  await ensureStore(paths);

  // Git is the SYNC layer, not a prerequisite for session mode. If git is missing
  // (or the store cannot be init'd), warn but keep going — state.json + shims are
  // the offline, non-git session machinery and must still be created (exit 0).
  let repo = { initialised: false };
  let gitWarning: string | null = null;
  try {
    repo = await ensureStoreRepo(paths, env, options.gitRun);
  } catch (err) {
    gitWarning =
      `agentenv: WARNING — the store was NOT put under version control (${(err as Error).message}). ` +
      'Local commands and session mode still work offline; re-run `agentenv init` once git is ' +
      'available to enable sync.';
  }

  // Initialise the manifest only when absent — re-running init must never
  // discard existing ownership records.
  if (!(await exists(paths.state))) {
    await writeState(paths, emptyManifest());
  }

  const adapters = options.adapters ?? realAdapters;
  const shims = await generateShims(paths, adapters);

  // Connect (or safely replace) the remote via the tested `agentenv remote` path —
  // never reimplement classification here. Its stdout/stderr fold into the report.
  let connectLine: string | null = null;
  let connectStderr: string | null = null;
  if (finish.connectRemote) {
    const res = await remoteCommand.run({ ...ctx, args: [finish.connectRemote] });
    connectLine = res.stdout.trim() !== '' ? res.stdout.trim() : null;
    connectStderr = res.stderr && res.stderr.trim() !== '' ? res.stderr.trim() : null;
  }

  const lines = [
    finish.headline,
    `  store:  ${paths.store}${repo.initialised ? ' (git initialised)' : gitWarning ? ' (git unavailable — sync disabled)' : ''}`,
    `  state:  ${paths.state}`,
    `  shims:  ${paths.shims}${shims.length === 0 ? ' (no adapters registered yet)' : ` (${shims.length})`}`,
    ...(connectLine ? ['', connectLine] : []),
    '',
    'Enable session mode by adding this line to your shell rc (.zshrc / .bashrc):',
    '',
    '  eval "$(agentenv shell-init)"',
    '',
  ];

  const stderrParts = [finish.notice, gitWarning, connectStderr].filter((s): s is string => Boolean(s));
  return {
    stdout: `${lines.join('\n')}\n`,
    code: 0,
    ...(stderrParts.length > 0 ? { stderr: `${stderrParts.join('\n')}\n` } : {}),
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
