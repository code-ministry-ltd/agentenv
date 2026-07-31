import { parseArgs } from '../args.js';
import type { Command, CommandContext, RunResult } from '../command.js';
import {
  findBinding,
  readSessionRegistry,
  removeBinding,
  resolveProjectRoot,
  setBinding,
} from '../session/registry.js';
import { parseHarnesses } from './activation.js';

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
      return dropGlobal(ctx, parsed.positionals, all, harnesses);
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
  // Wired to the transactional engine in a later slice of this task.
  void ctx;
  void names;
  void all;
  void harnesses;
  return { stdout: '', stderr: 'drop --global: not yet implemented\n', code: 1 };
}
