import type { Command } from '../command.js';
import { EnvYamlError } from '../env-config.js';
import { listEnvironments, readEnvConfig } from '../store.js';

export const listCommand: Command = {
  name: 'list',
  usage: '',
  summary: 'List environments',

  async run({ args, paths }) {
    if (args.length > 0) {
      return { stdout: '', stderr: `list: unexpected argument '${args[0]}'\nUsage: agentenv list\n`, code: 1 };
    }
    const names = await listEnvironments(paths);
    if (names.length === 0) {
      return {
        stdout: "No environments yet. Create one with 'agentenv create <name>'.\n",
        code: 0,
      };
    }

    // Validate every manifest so a mangled or too-new env.yaml surfaces loudly
    // rather than being silently listed as a healthy environment.
    for (const name of names) {
      try {
        await readEnvConfig(paths, name);
      } catch (err) {
        if (err instanceof EnvYamlError) {
          return { stdout: '', stderr: `list: ${err.message}\n`, code: 1 };
        }
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return {
            stdout: '',
            stderr: `list: environment '${name}' has no env.yaml (${paths.envYaml(name)})\n`,
            code: 1,
          };
        }
        throw err;
      }
    }

    return { stdout: `${names.join('\n')}\n`, code: 0 };
  },
};
