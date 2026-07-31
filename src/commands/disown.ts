import { basename, dirname } from 'node:path';
import {
  disownItem,
  findAdoptedByName,
  markBaseline,
  singular,
  wouldClobberUnownedPath,
  type AdoptedDirMergeItem,
} from '../adopt.js';
import { parseArgs } from '../args.js';
import type { Command, CommandContext, RunResult } from '../command.js';
import { confirmDefault } from '../prompt.js';
import { readState } from '../state.js';
import { closeStoreSync, commitMutation, openStoreSync, withNotices } from './store-sync.js';

/**
 * `agentenv disown <name>` — reverse an adoption (design D10). Semantics depend
 * on the adopted item's origin, recorded at adoption time:
 *
 * - **global-mode-adopted** → restored to its manifest-recorded ORIGINAL real
 *   path, byte-identically (a sanctioned, recorded real-path write carved out of
 *   the Never list — the reversal of `adopt`).
 * - **session-born** (created inside a session view, never had a real home) →
 *   PROMPT: keep it session-ephemeral (it dies with the shell) or place it into
 *   the real global surface (an explicit user command, so the write is sanctioned).
 *
 * Either way the store copy is moved out and ownership dropped, and the item is
 * added back to its surface baseline so the next sweep does not re-adopt it.
 */
export const disownCommand: Command = {
  name: 'disown',
  usage: '<name>',
  summary: 'Reverse an adoption (restore the item; drop ownership)',

  async run(ctx): Promise<RunResult> {
    const parsed = parseArgs(ctx.args, {});
    if (parsed.unknown.length > 0) {
      return { stdout: '', stderr: `disown: unknown option '${parsed.unknown[0]}'\n`, code: 1 };
    }
    const name = parsed.positionals[0];
    if (name === undefined) {
      return { stdout: '', stderr: 'disown: missing item name\nUsage: agentenv disown <name>\n', code: 1 };
    }

    const matches = findAdoptedByName(await readState(ctx.paths), name);
    if (matches.length === 0) {
      return { stdout: '', stderr: `disown: no adopted item named '${name}'\n`, code: 1 };
    }
    if (matches.length > 1) {
      const where = matches.map((m) => `  ${m.path} (env ${m.ownerEnv})`).join('\n');
      return { stdout: '', stderr: `disown: '${name}' is ambiguous — more than one adopted item:\n${where}\n`, code: 1 };
    }
    return disown(ctx, matches[0]!, name);
  },
};

async function disown(ctx: CommandContext, item: AdoptedDirMergeItem, name: string): Promise<RunResult> {
  const { paths, env, options } = ctx;

  // Decide the destination the store content is restored to.
  let dest: string;
  let outcome: string;
  if (item.origin === 'global') {
    dest = item.originalPath;
    outcome = `restored '${name}' to its original path (${dest})`;
  } else {
    const confirm = options.confirm ?? confirmDefault;
    const placeGlobal = await confirm(
      `agentenv: '${name}' was created inside a session and has no real config home. ` +
        `Place it into the real global surface? (No = keep it session-ephemeral, dies with the shell) [y/N] `,
    );
    if (placeGlobal) {
      if (item.realPath === undefined) {
        return {
          stdout: '',
          stderr: `disown: cannot place '${name}' globally — no real surface was recorded for its session; it stays session-ephemeral\n`,
          code: 1,
        };
      }
      // Finding 1: NEVER clobber a non-owned real path. If the user already has
      // their OWN file/dir there, refuse to place (skip-and-warn) and keep the
      // item session-ephemeral rather than silently overwriting their config.
      if (await wouldClobberUnownedPath(paths, await readState(paths), item.realPath)) {
        dest = item.originalPath;
        outcome =
          `did NOT place '${name}' globally — ${item.realPath} already exists and is not managed by ` +
          `agentenv (placing there would overwrite your own file); kept it session-ephemeral (${dest}), it dies with the shell`;
      } else {
        dest = item.realPath;
        outcome = `placed '${name}' into the real global surface (${dest})`;
      }
    } else {
      dest = item.originalPath;
      outcome = `kept '${name}' session-ephemeral (${dest}); it dies with the shell`;
    }
  }

  const notices: string[] = [];
  const syncCtx = { paths, env, options };
  // `skipAdopt`: disown is the REVERSE of adoption — the lifecycle sweep must not
  // re-adopt the very item we are restoring (also guarded by markBaseline below).
  const before = await openStoreSync(syncCtx, notices, { skipAdopt: true });
  if (before.quarantined) {
    await closeStoreSync(syncCtx, notices);
    return withNotices({ stdout: `Did NOT disown '${name}' — pulled store changes were quarantined.\n`, code: 0 }, notices);
  }

  await disownItem(paths, item, dest);
  await markBaseline(paths, dirname(dest), name); // don't let the next sweep re-adopt it.

  const noun = singular(basename(dirname(item.target)) as 'skills' | 'agents' | 'commands');
  await commitMutation(syncCtx, `agentenv: disown ${noun} ${name}`, notices);
  await closeStoreSync(syncCtx, notices);

  return withNotices({ stdout: `Disowned ${noun} '${name}' — ${outcome}.\n`, code: 0 }, notices);
}
