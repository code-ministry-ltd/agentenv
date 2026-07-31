import { adapters as realAdapters } from '../adapters/index.js';
import { parseArgs } from '../args.js';
import type { Command, CommandContext, RunResult } from '../command.js';
import { driftSweep } from '../drift.js';
import { materialiseGlobal, selectAdapters } from '../engine.js';
import { setBinding } from '../session/registry.js';
import { resolveProjectRoot } from '../session/registry.js';
import { parseHarnesses, validateEnvs } from './activation.js';
import { renderGlobalSkips } from './global-report.js';
import { closeStoreSync, openStoreSync } from './store-sync.js';

/**
 * `agentenv use <env>… [--harness <h>…] [--global]` — activate an env stack.
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
  usage: '<env>… [--harness <h>…] [--global]',
  summary: 'Activate an env stack (session by default; --global for real paths)',

  async run(ctx): Promise<RunResult> {
    const parsed = parseArgs(ctx.args, { booleans: ['global'], values: ['harness'] });
    if (parsed.unknown.length > 0) {
      return { stdout: '', stderr: `use: unknown option '${parsed.unknown[0]}'\n`, code: 1 };
    }
    if (parsed.positionals.length === 0) {
      return {
        stdout: '',
        stderr: 'use: missing environment name(s)\nUsage: agentenv use <env>… [--harness <h>…] [--global]\n',
        code: 1,
      };
    }
    const harnesses = parseHarnesses(parsed.values.get('harness'));
    if (parsed.booleans.has('global')) {
      return useGlobal(ctx, parsed.positionals, harnesses);
    }
    return useSession(ctx, parsed.positionals, harnesses);
  },
};

async function useSession(
  ctx: CommandContext,
  names: readonly string[],
  harnesses: string[] | undefined,
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
    ...(harnesses ? { harnesses } : {}),
    global: false,
  });

  const scope = harnesses ? ` (harnesses: ${harnesses.join(', ')})` : '';
  const stderr = notices.length > 0 ? `${notices.join('\n')}\n` : undefined;
  return {
    stdout: `Bound this shell to [${kept.join(', ')}]${scope} in ${projectRoot}.\n`,
    ...(stderr ? { stderr } : {}),
    code: 0,
  };
}

async function useGlobal(
  ctx: CommandContext,
  names: readonly string[],
  harnesses: string[] | undefined,
): Promise<RunResult> {
  const { paths, env, options } = ctx;
  const adapters = selectAdapters(options.adapters ?? realAdapters, harnesses);
  if (adapters.length === 0) {
    const detail = harnesses ? ` matching --harness ${harnesses.join(',')}` : '';
    return {
      stdout: '',
      stderr: `use --global: no registered adapter${detail} — global mode needs a harness adapter (Task 1.8/4.x)\n`,
      code: 1,
    };
  }

  const { kept, warnings } = await validateEnvs(paths, names);
  const notices = [...warnings];
  if (kept.length === 0) {
    return { stdout: '', stderr: `${notices.join('\n')}\nuse --global: no valid environments to activate\n`, code: 1 };
  }

  // Per-invocation drift sweep (D9): capture mid-session edits before mutating.
  await driftSweep({ paths, adapters, env, onWarn: (m) => notices.push(m) });

  // Git sync START (D9): commit the swept drift, pull, then run the post-pull
  // safeguards (schema-validate + secret-scan + manifest-reconcile) BEFORE anything
  // materialises. A malformed / secret-bearing pulled tree is quarantined — NOT
  // materialised — and the invocation ends without touching real surfaces.
  const syncCtx = { paths, env, options };
  const before = await openStoreSync(syncCtx, notices, { alreadySwept: true });
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
