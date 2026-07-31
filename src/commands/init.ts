import { access, constants } from 'node:fs/promises';
import { adapters as realAdapters } from '../adapters/index.js';
import type { Command, RunResult } from '../command.js';
import { ensureStoreRepo } from '../git.js';
import { emptyManifest, writeState } from '../state.js';
import { generateShims } from '../session/shims.js';
import { ensureStore } from '../store.js';

/**
 * `agentenv init` — one-time setup, safe to re-run (idempotent):
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
 */
export const initCommand: Command = {
  name: 'init',
  usage: '',
  summary: 'Create the store, manifest and shims; print the shell hook line',

  async run({ paths, env, options }): Promise<RunResult> {
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

    const lines = [
      'agentenv initialised.',
      `  store:  ${paths.store}${repo.initialised ? ' (git initialised)' : gitWarning ? ' (git unavailable — sync disabled)' : ''}`,
      `  state:  ${paths.state}`,
      `  shims:  ${paths.shims}${shims.length === 0 ? ' (no adapters registered yet)' : ` (${shims.length})`}`,
      '',
      'Enable session mode by adding this line to your shell rc (.zshrc / .bashrc):',
      '',
      '  eval "$(agentenv shell-init)"',
      '',
    ];
    return {
      stdout: `${lines.join('\n')}\n`,
      code: 0,
      ...(gitWarning ? { stderr: `${gitWarning}\n` } : {}),
    };
  },
};

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
