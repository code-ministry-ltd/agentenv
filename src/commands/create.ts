import { parseArgs } from '../args.js';
import type { Command, RunResult } from '../command.js';
import {
  cloneEnvironment,
  createEnvironment,
  type EnvironmentLifecycleResult,
} from '../application/environment-lifecycle.js';
import { createEnvironmentLifecycleRuntime } from '../application/environment-lifecycle-runtime.js';
import {
  closeStoreSync,
  commitRequiredSteps,
  openStoreSync,
  PendingCommandError,
  withNotices,
} from './store-sync.js';

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
    const from = parsed.values.get('from');
    const notices: string[] = [];
    const syncCtx = { paths, env, options };
    const runtime = createEnvironmentLifecycleRuntime({
      paths,
      open: async () => {
        try {
          await openStoreSync(syncCtx, notices);
          return { status: 'ready' };
        } catch (error) {
          if (!(error instanceof PendingCommandError)) throw error;
          return { status: 'pending-recovery', transactionId: error.transactionId };
        }
      },
      close: async () => {
        await closeStoreSync(syncCtx, notices);
      },
      gitBookkeeping: (steps, transactionId) =>
        commitRequiredSteps(syncCtx, steps, notices, transactionId),
      onGitPending: (error, transactionId) => {
        notices.push(
          `agentenv: required commit is pending — ${error.message}. ` +
            `The local change and recovery data are retained; run ` +
            `\`agentenv resolve command ${transactionId} --retry\`.`,
        );
      },
    });
    const result = from === undefined
      ? await createEnvironment({ paths, name, runtime })
      : await cloneEnvironment({ paths, name, source: from, runtime });
    return presentCreateResult(result, notices);
  },
};

function presentCreateResult(
  result: EnvironmentLifecycleResult,
  notices: readonly string[],
): RunResult {
  switch (result.status) {
    case 'created':
    case 'git-pending': {
      const stdout = result.operation === 'clone'
        ? `Created environment '${result.name}' (copied from '${result.source}').\n`
        : `Created environment '${result.name}'.\n`;
      return withNotices({ stdout, code: 0 }, notices);
    }
    case 'invalid':
      return withNotices({
        stdout: '',
        stderr: `create: ${result.field === 'source' ? '--from: ' : ''}${result.message}\n`,
        code: 1,
      }, notices);
    case 'exists':
      return withNotices({
        stdout: '',
        stderr: `create: environment '${result.name}' already exists\n`,
        code: 1,
      }, notices);
    case 'source-not-found':
      return withNotices({
        stdout: '',
        stderr: `create: --from: environment '${result.source}' does not exist\n`,
        code: 1,
      }, notices);
    case 'pending-recovery':
      throw new PendingCommandError(result.transactionId);
    case 'stale':
    case 'failure':
      return withNotices({
        stdout: '',
        stderr: `create: ${result.message}\n`,
        code: 1,
      }, notices);
  }
}
