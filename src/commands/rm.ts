import { rm as removeDir } from 'node:fs/promises';
import { adapters as realAdapters } from '../adapters/index.js';
import { parseArgs } from '../args.js';
import type { Command, CommandContext } from '../command.js';
import { dematerialiseGlobal, readGlobalStack } from '../engine.js';
import { confirmDefault } from '../prompt.js';
import {
  readSessionRegistry,
  removeBinding,
  setBinding,
} from '../session/registry.js';
import { readState } from '../state.js';
import { environmentExists, validateEnvName } from '../store.js';

export const rmCommand: Command = {
  name: 'rm',
  usage: '<name> [--yes|--force]',
  summary: 'Remove an environment',

  async run(ctx) {
    const { args, paths } = ctx;
    const parsed = parseArgs(args, { booleans: ['yes', 'force', 'drop-first'] });
    if (parsed.unknown.length > 0) {
      return { stdout: '', stderr: `rm: unknown option '${parsed.unknown[0]}'\n`, code: 1 };
    }
    const name = parsed.positionals[0];
    if (name === undefined) {
      return { stdout: '', stderr: 'rm: missing environment name\nUsage: agentenv rm <name> [--drop-first] [--yes]\n', code: 1 };
    }
    // Validate BEFORE any path construction: path.join collapses `..`, so an
    // unvalidated name like `..` or `../../x` would let rm -rf escape the store.
    const nameError = validateEnvName(name);
    if (nameError) {
      return { stdout: '', stderr: `rm: ${nameError}\n`, code: 1 };
    }

    if (!(await environmentExists(paths, name))) {
      return { stdout: '', stderr: `rm: environment '${name}' does not exist\n`, code: 1 };
    }

    // Active-env refusal (deferred from Task 1.1): refuse to remove an env that
    // is currently active — bound in any session OR present in the global stack —
    // unless --drop-first, which deactivates it first (D5/D11).
    const activity = await envActivity(ctx, name);
    if (activity.session || activity.global) {
      if (!parsed.booleans.has('drop-first')) {
        const where = [activity.session ? 'a session binding' : null, activity.global ? 'the global stack' : null]
          .filter(Boolean)
          .join(' and ');
        return {
          stdout: '',
          stderr: `rm: environment '${name}' is active (${where}) — deactivate it first, or pass --drop-first\n`,
          code: 1,
        };
      }
      await deactivateEverywhere(ctx, name, activity);
    }

    const skipPrompt = parsed.booleans.has('yes') || parsed.booleans.has('force');
    if (!skipPrompt) {
      const confirm = ctx.options.confirm ?? confirmDefault;
      const confirmed = await confirm(`Remove environment '${name}'? This cannot be undone. [y/N] `);
      if (!confirmed) {
        return {
          stdout: `Aborted; '${name}' was not removed. (use --yes to skip the prompt)\n`,
          code: 0,
        };
      }
    }

    await removeDir(paths.envDir(name), { recursive: true, force: true });
    return { stdout: `Removed environment '${name}'.\n`, code: 0 };
  },
};

/** Whether an env is active: bound in any session, or present in the global stack/manifest. */
async function envActivity(
  ctx: CommandContext,
  name: string,
): Promise<{ session: boolean; global: boolean }> {
  const { paths } = ctx;
  const registry = await readSessionRegistry(paths);
  const session = registry.bindings.some((b) => b.envs.includes(name));
  const manifest = await readState(paths);
  const global =
    readGlobalStack(manifest).includes(name) || manifest.items.some((i) => i.ownerEnv === name);
  return { session, global };
}

/**
 * `--drop-first`: deactivate `name` everywhere before removal — dematerialise it
 * from the global stack (re-materialising anything it shadowed, D5) and remove it
 * from every session binding (dropping a binding whose last env it was).
 */
async function deactivateEverywhere(
  ctx: CommandContext,
  name: string,
  activity: { session: boolean; global: boolean },
): Promise<void> {
  const { paths, env, options } = ctx;
  if (activity.global) {
    const adapters = options.adapters ?? realAdapters;
    await dematerialiseGlobal({ paths, adapters, envs: [name], all: false, env });
  }
  if (activity.session) {
    const registry = await readSessionRegistry(paths);
    for (const binding of [...registry.bindings]) {
      if (!binding.envs.includes(name)) continue;
      const remaining = binding.envs.filter((e) => e !== name);
      if (remaining.length === 0) {
        await removeBinding(paths, binding.session, binding.projectRoot);
      } else {
        await setBinding(paths, { ...binding, envs: remaining });
      }
    }
  }
}
