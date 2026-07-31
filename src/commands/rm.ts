import { rm as removeDir } from 'node:fs/promises';
import { parseArgs } from '../args.js';
import type { Command } from '../command.js';
import { confirmDefault } from '../prompt.js';
import { environmentExists } from '../store.js';

export const rmCommand: Command = {
  name: 'rm',
  usage: '<name> [--yes]',
  summary: 'Remove an environment',

  async run({ args, paths, options }) {
    const parsed = parseArgs(args, { booleans: ['yes', 'force'] });
    if (parsed.unknown.length > 0) {
      return { stdout: '', stderr: `rm: unknown option '${parsed.unknown[0]}'\n`, code: 1 };
    }
    const name = parsed.positionals[0];
    if (name === undefined) {
      return { stdout: '', stderr: 'rm: missing environment name\nUsage: agentenv rm <name> [--yes]\n', code: 1 };
    }

    // NOTE (task 1.7): once activation exists, rm must refuse to remove an
    // environment that is currently active (in any shell / --global) unless
    // --drop-first is given. Activation does not exist yet, so there is
    // nothing to refuse here.

    if (!(await environmentExists(paths, name))) {
      return { stdout: '', stderr: `rm: environment '${name}' does not exist\n`, code: 1 };
    }

    const skipPrompt = parsed.booleans.has('yes') || parsed.booleans.has('force');
    if (!skipPrompt) {
      const confirm = options.confirm ?? confirmDefault;
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
