import { cp, mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from '../args.js';
import type { Command } from '../command.js';
import { scaffoldEnvYaml } from '../env-config.js';
import { ensureStore, environmentExists, validateEnvName } from '../store.js';

export const createCommand: Command = {
  name: 'create',
  usage: '<name> [--from <env>]',
  summary: 'Create a new environment',

  async run({ args, paths }) {
    const parsed = parseArgs(args, { values: ['from'] });

    if (parsed.unknown.length > 0) {
      return { stdout: '', stderr: `create: unknown option '${parsed.unknown[0]}'\n`, code: 1 };
    }
    const name = parsed.positionals[0];
    if (name === undefined) {
      return { stdout: '', stderr: 'create: missing environment name\nUsage: agentenv create <name> [--from <env>]\n', code: 1 };
    }
    const nameError = validateEnvName(name);
    if (nameError) {
      return { stdout: '', stderr: `create: ${nameError}\n`, code: 1 };
    }

    await ensureStore(paths);

    if (await environmentExists(paths, name)) {
      return { stdout: '', stderr: `create: environment '${name}' already exists\n`, code: 1 };
    }

    const from = parsed.values.get('from');
    if (from !== undefined) {
      const fromError = validateEnvName(from);
      if (fromError) {
        return { stdout: '', stderr: `create: --from: ${fromError}\n`, code: 1 };
      }
      if (!(await environmentExists(paths, from))) {
        return { stdout: '', stderr: `create: --from: environment '${from}' does not exist\n`, code: 1 };
      }
      await cp(paths.envDir(from), paths.envDir(name), { recursive: true });
      return { stdout: `Created environment '${name}' (copied from '${from}').\n`, code: 0 };
    }

    await mkdir(paths.envDir(name), { recursive: true });
    await writeFile(paths.envYaml(name), scaffoldEnvYaml({ description: '' }), 'utf8');
    return { stdout: `Created environment '${name}'.\n`, code: 0 };
  },
};
