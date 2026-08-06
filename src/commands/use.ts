import { resolveGlobalSurfaceDestination } from '../adapter-v2.js';
import type { Adapter } from '../adapter.js';
import { snapshotInventory, type AdoptSurface } from '../adopt.js';
import { adapters as realAdapters } from '../adapters/index.js';
import { parseArgs } from '../args.js';
import type { Command, CommandContext, RunResult } from '../command.js';
import { materialiseGlobal } from '../engine.js';
import { setBinding } from '../session/registry.js';
import { resolveProjectRoot } from '../session/registry.js';
import { validateEnvs } from './activation.js';
import { renderGlobalSkips } from './global-report.js';
import { closeStoreSync, openStoreSync } from './store-sync.js';

/**
 * `agentenv use <env>… [--global]` — activate an env stack.
 *
 * - **session (default)** binds this shell + project to the stack via the session
 *   registry (D8/D15). No real config file is touched — the shim/`run` builds the
 *   private view at launch (Task 1.6). Later envs win item-name conflicts (D5).
 * - **`--global`** materialises the stack onto the harness's REAL config paths
 *   through the transactional engine (D4) — the explicit fallback for GUI apps
 *   and machine-wide setups.
 */
export const useCommand: Command = {
  name: 'use',
  usage: '<env>… [--global]',
  summary: 'Activate an env stack (session by default; --global for real paths)',

  async run(ctx): Promise<RunResult> {
    const parsed = parseArgs(ctx.args, { booleans: ['global'] });
    if (parsed.unknown.length > 0) {
      return { stdout: '', stderr: `use: unknown option '${parsed.unknown[0]}'\n`, code: 1 };
    }
    if (parsed.positionals.length === 0) {
      return {
        stdout: '',
        stderr: 'use: missing environment name(s)\nUsage: agentenv use <env>… [--global]\n',
        code: 1,
      };
    }
    if (parsed.booleans.has('global')) {
      return useGlobal(ctx, parsed.positionals);
    }
    return useSession(ctx, parsed.positionals);
  },
};

async function useSession(
  ctx: CommandContext,
  names: readonly string[],
): Promise<RunResult> {
  const { paths, env, cwd } = ctx;
  const session = env.AGENTENV_SESSION;
  if (!session || session.trim() === '') {
    return {
      stdout: '',
      stderr:
        'use: this shell has no session id — run `eval "$(agentenv shell-init)"` in your shell rc first ' +
        '(or use --global to materialise onto real paths)\n',
      code: 1,
    };
  }

  const { kept, warnings } = await validateEnvs(paths, names);
  const notices = [...warnings];
  if (kept.length === 0) {
    return { stdout: '', stderr: `${notices.join('\n')}\nuse: no valid environments to activate\n`, code: 1 };
  }

  const projectRoot = await resolveProjectRoot(cwd);
  await setBinding(paths, {
    session,
    projectRoot,
    envs: kept,
    global: false,
  });

  const stderr = notices.length > 0 ? `${notices.join('\n')}\n` : undefined;
  return {
    stdout: `Bound this shell to [${kept.join(', ')}] in ${projectRoot}.\n`,
    ...(stderr ? { stderr } : {}),
    code: 0,
  };
}

async function useGlobal(
  ctx: CommandContext,
  names: readonly string[],
): Promise<RunResult> {
  const { paths, env, options } = ctx;
  const adapters = options.adapters ?? realAdapters;
  if (adapters.length === 0) {
    return {
      stdout: '',
      stderr: `use --global: no registered adapter — global mode needs a harness adapter\n`,
      code: 1,
    };
  }

  const { kept, warnings } = await validateEnvs(paths, names);
  const notices = [...warnings];
  if (kept.length === 0) {
    return { stdout: '', stderr: `${notices.join('\n')}\nuse --global: no valid environments to activate\n`, code: 1 };
  }

  // Git sync START (D9): commit the swept drift, pull, then run the post-pull
  // safeguards (schema-validate + secret-scan + manifest-reconcile) BEFORE anything
  // materialises. A malformed / secret-bearing pulled tree is quarantined — NOT
  // materialised — and the invocation ends without touching real surfaces.
  const syncCtx = { paths, env, options };
  const before = await openStoreSync(syncCtx, notices);
  if (before.quarantined) {
    await closeStoreSync(syncCtx, notices);
    const stderr = notices.length > 0 ? `${notices.join('\n')}\n` : undefined;
    return {
      stdout:
        `Did NOT materialise [${kept.join(', ')}] — pulled store changes were quarantined ` +
        '(malformed or secret-bearing). See the warning above; nothing on real paths was touched.\n',
      ...(stderr ? { stderr } : {}),
      code: 0,
    };
  }

  const result = await materialiseGlobal({
    paths,
    adapters,
    envs: kept,
    env,
    onWarn: (m) => notices.push(m),
  });

  notices.push(...renderGlobalSkips(result.skips));

  // Snapshot the inventory of every dir-merge surface now materialised (D10), so the
  // NEXT invocation's sweep can tell an agent-created item from these pre-existing
  // ones and auto-adopt it into the top env. Taken AFTER materialise, so the env's
  // own symlinked items are in the baseline (and owned) — never re-adopted.
  const topEnv = result.stack.at(-1);
  if (topEnv !== undefined) {
    await snapshotInventory(paths, globalDirMergeSurfaces(adapters, env, topEnv));
  }

  await closeStoreSync(syncCtx, notices); // Git sync END (D9): one fail-soft push.
  const stderr = notices.length > 0 ? `${notices.join('\n')}\n` : undefined;
  return {
    stdout:
      `Materialised [${kept.join(', ')}] globally (${result.applied} item(s)).\n` +
      `Global stack: [${result.stack.join(', ')}].\n`,
    ...(stderr ? { stderr } : {}),
    code: 0,
  };
}

/**
 * The real dir-merge surfaces (skills / agents / commands) of the in-scope adapters,
 * as {@link AdoptSurface}s owned by `ownerEnv` — the D10 auto-adoption snapshot set
 * for global mode. Only supported dir-merge surfaces whose store kind is an adoptable
 * kind are watched (instructions live in `rules/` but are not agent-created skills).
 */
function globalDirMergeSurfaces(
  adapters: readonly Adapter[],
  env: NodeJS.ProcessEnv,
  ownerEnv: string,
): AdoptSurface[] {
  const surfaces: AdoptSurface[] = [];
  for (const adapter of adapters) {
    for (const surface of adapter.surfaces) {
      if (surface.mechanism !== 'dir-merge' || !surface.supported) continue;
      if (surface.storeKind !== 'skills' && surface.storeKind !== 'agents' && surface.storeKind !== 'commands') {
        continue;
      }
      surfaces.push({
        dir: resolveGlobalSurfaceDestination(adapter, surface, env),
        scope: 'global',
        storeKind: surface.storeKind,
        ownerEnv,
      });
    }
  }
  return surfaces;
}
