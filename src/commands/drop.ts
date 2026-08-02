import { adapters as realAdapters } from '../adapters/index.js';
import { globalAdapterTargets } from '../adapter-v2.js';
import { parseArgs } from '../args.js';
import type { Command, CommandContext, RunResult } from '../command.js';
import { driftSweep } from '../drift.js';
import { dematerialiseGlobal, selectAdapters } from '../engine.js';
import {
  findBinding,
  readSessionRegistry,
  removeBinding,
  resolveProjectRoot,
  setBinding,
} from '../session/registry.js';
import { parseHarnesses } from './activation.js';
import { renderGlobalSkips } from './global-report.js';
import { closeStoreSync, openStoreSync } from './store-sync.js';

/**
 * `agentenv drop [<env>… | --all] [--harness <h>…] [--global]` — deactivate.
 *
 * - **session (default)** removes this shell's binding (or the named envs from
 *   it) via the session registry. No real files are touched.
 * - **`--global`** dematerialises from the harness's REAL config paths using the
 *   MANIFEST only (never scan-and-guess), re-materialising anything a dropped env
 *   had shadowed (D5). `drop --all --global` clears the whole global stack.
 */
export const dropCommand: Command = {
  name: 'drop',
  usage: '[<env>… | --all] [--harness <h>…] [--global]',
  summary: 'Deactivate an env stack (session by default; --global for real paths)',

  async run(ctx): Promise<RunResult> {
    const parsed = parseArgs(ctx.args, { booleans: ['global', 'all'], values: ['harness'] });
    if (parsed.unknown.length > 0) {
      return { stdout: '', stderr: `drop: unknown option '${parsed.unknown[0]}'\n`, code: 1 };
    }
    const all = parsed.booleans.has('all');
    if (all && parsed.positionals.length > 0) {
      return { stdout: '', stderr: 'drop: --all cannot be combined with named environments\n', code: 1 };
    }
    const harnesses = parseHarnesses(parsed.values.get('harness'));
    if (parsed.booleans.has('global')) {
      return dropGlobal(ctx, parsed.positionals, all || parsed.positionals.length === 0, harnesses);
    }
    return dropSession(ctx, parsed.positionals, all);
  },
};

async function dropSession(
  ctx: CommandContext,
  names: readonly string[],
  all: boolean,
): Promise<RunResult> {
  const { paths, env, cwd } = ctx;
  const session = env.AGENTENV_SESSION;
  if (!session || session.trim() === '') {
    return { stdout: 'Nothing bound in this shell (no session id).\n', code: 0 };
  }
  const projectRoot = await resolveProjectRoot(cwd);
  const binding = findBinding(await readSessionRegistry(paths), session, projectRoot);
  if (!binding) {
    return { stdout: `Nothing bound in this shell for ${projectRoot}.\n`, code: 0 };
  }

  // No names (or --all) → drop the whole binding.
  if (all || names.length === 0) {
    await removeBinding(paths, session, projectRoot);
    return { stdout: `Unbound this shell in ${projectRoot}.\n`, code: 0 };
  }

  // Named envs → remove exactly those from the stack; drop the binding if empty.
  const remaining = binding.envs.filter((e) => !names.includes(e));
  if (remaining.length === 0) {
    await removeBinding(paths, session, projectRoot);
    return { stdout: `Unbound this shell in ${projectRoot} (last env removed).\n`, code: 0 };
  }
  await setBinding(paths, { ...binding, envs: remaining });
  return { stdout: `Now bound to [${remaining.join(', ')}] in ${projectRoot}.\n`, code: 0 };
}

async function dropGlobal(
  ctx: CommandContext,
  names: readonly string[],
  all: boolean,
  harnesses: string[] | undefined,
): Promise<RunResult> {
  const { paths, env, options } = ctx;
  const adapters = selectAdapters(options.adapters ?? realAdapters, harnesses);
  // `--harness` restricts removal to the matching adapters' real roots; without it,
  // every owned item of the dropped envs is removed (dematerialise is adapter-free).
  const restrictToRoots = harnesses
    ? adapters.flatMap((adapter) => globalAdapterTargets(adapter, env))
    : undefined;

  const notices: string[] = [];
  // Drift sweep BEFORE removal (D9): reconcile config-key hashes so removal is not
  // blocked by drift, and preserve mid-session edits to the store first.
  await driftSweep({ paths, adapters, env, onWarn: (m) => notices.push(m) });

  // Git sync START (D9): commit the swept drift, pull, run the post-pull safeguards.
  // Removal is manifest-driven and safe even on a quarantined pull, so drop proceeds
  // regardless — the reconcile warning still surfaces a remotely-deleted active env.
  const syncCtx = { paths, env, options };
  await openStoreSync(syncCtx, notices, { alreadySwept: true });

  const result = await dematerialiseGlobal({
    paths,
    adapters,
    envs: names,
    all,
    env,
    ...(restrictToRoots ? { restrictToRoots } : {}),
    onWarn: (m) => notices.push(m),
  });

  notices.push(...renderGlobalSkips(result.skips));
  await closeStoreSync(syncCtx, notices); // Git sync END (D9): one fail-soft push.
  const stderr = notices.length > 0 ? `${notices.join('\n')}\n` : undefined;
  const what = all ? 'the whole global stack' : `[${names.join(', ')}]`;
  return {
    stdout:
      `Dematerialised ${what} globally (${result.removed} item(s) removed` +
      `${result.applied > 0 ? `, ${result.applied} re-materialised` : ''}).\n` +
      `Global stack: [${result.stack.join(', ')}].\n`,
    ...(stderr ? { stderr } : {}),
    code: 0,
  };
}
