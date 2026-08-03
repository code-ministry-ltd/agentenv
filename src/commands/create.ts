import { cp, mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from '../args.js';
import type { Command, RunResult } from '../command.js';
import { scaffoldEnvYaml } from '../env-config.js';
import { ensureStore, environmentExists, validateEnvName } from '../store.js';
import { withNotices, withStoreSync } from './store-sync.js';

export const createCommand: Command = {
  name: 'create',
  usage: '<name> [--from <env>]',
  summary: 'Create a new environment',

  async run({ args, paths, env, options }): Promise<RunResult> {
    const parsed = parseArgs(args, { values: ['from'] });

    if (parsed.unknown.length > 0) {
      return { stdout: '', stderr: `create: unknown option '${parsed.unknown[0]}'\n`, code: 1 };
    }
    const name = parsed.positionals[0];
    if (name === undefined) {
      return { stdout: '', stderr: 'create: missing environment name\nUsage: agentenv create <name> [--from <env>]\n', code: 1 };
    }
    if (parsed.positionals.length > 1) {
      return {
        stdout: '',
        stderr: `create: unexpected argument '${parsed.positionals[1]}'\nUsage: agentenv create <name> [--from <env>]\n`,
        code: 1,
      };
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
    }

    // Store mutation inside the git-sync lifecycle (pull → create → commit → push).
    const notices: string[] = [];
    await withStoreSync({ paths, env, options }, notices, async () => {
      if (from !== undefined) {
        await cp(paths.envDir(from), paths.envDir(name), { recursive: true });
        return `agentenv: create env ${name} (from ${from})`;
      }
      await mkdir(paths.envDir(name), { recursive: true });
      await writeFile(paths.envYaml(name), scaffoldEnvYaml({ description: '' }), 'utf8');
      return `agentenv: create env ${name}`;
    });

    const stdout =
      from !== undefined
        ? `Created environment '${name}' (copied from '${from}').\n`
        : `Created environment '${name}'.\n`;
    return withNotices({ stdout, code: 0 }, notices);
  },
};
