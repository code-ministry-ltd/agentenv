import { createHash } from 'node:crypto';
import { resolveAdapter } from '../adapter.js';
import { adapters as realAdapters } from '../adapters/index.js';
import type { Command } from '../command.js';
import { launchHarness } from '../session/launch.js';
import { environmentExists, validateEnvName } from '../store.js';
import { toRunResult } from './shim.js';

/**
 * `agentenv run <env> [env2…] -- <harness> [args…]` — compose a view for the env
 * stack and exec the harness with config-root overrides, WITHOUT needing the
 * shell hook or shims installed (D15). This is the scripts/CI entrypoint: it
 * resolves the adapter from the registry and the real binary from PATH directly.
 *
 * No persistent binding is written — the view is keyed by a hash of the env
 * stack under `live/`, so repeated runs of the same stack reuse it (lazy
 * generation) without a session id.
 */
export const runCommand: Command = {
  name: 'run',
  usage: '<env>… -- <harness> [args…]',
  summary: 'One-shot session launch of a harness under an env stack (no hook needed)',

  async run({ args, paths, env, cwd, options }) {
    const sep = args.indexOf('--');
    if (sep === -1) {
      return usageError("run: missing '--' separator");
    }
    const envs = args.slice(0, sep);
    const after = args.slice(sep + 1);
    const harness = after[0];
    const harnessArgs = after.slice(1);

    if (envs.length === 0) return usageError('run: missing environment name(s)');
    if (!harness) return usageError("run: missing harness after '--'");

    for (const name of envs) {
      const nameError = validateEnvName(name);
      if (nameError) return { stdout: '', stderr: `run: ${nameError}\n`, code: 1 };
      if (!(await environmentExists(paths, name))) {
        return { stdout: '', stderr: `run: environment '${name}' does not exist\n`, code: 1 };
      }
    }

    const adapters = options.adapters ?? realAdapters;
    const adapter = resolveAdapter(adapters, harness);
    if (!adapter) {
      return {
        stdout: '',
        stderr: `run: no adapter for harness '${harness}'\n`,
        code: 1,
      };
    }

    // A stable, binding-free view key per env stack (independent of any shell id).
    const session = `run-${createHash('sha256').update(envs.join(' ')).digest('hex').slice(0, 16)}`;

    const result = await launchHarness({
      paths,
      adapter,
      envs,
      session,
      args: harnessArgs,
      env,
      cwd,
      execHarness: options.execHarness,
      capture: options.capture,
      now: options.now,
    });
    return toRunResult(result);
  },
};

function usageError(message: string) {
  return {
    stdout: '',
    stderr: `${message}\nUsage: agentenv run <env>… -- <harness> [args…]\n`,
    code: 1,
  };
}
