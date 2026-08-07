import { parseArgs } from '../args.js';
import type { Command, RunResult } from '../command.js';
import {
  deleteEnvironment,
  inspectEnvironmentDeletion,
  type EnvironmentActivity,
  type EnvironmentDeleteResult,
} from '../application/environment-lifecycle.js';
import { createEnvironmentDeleteRuntime } from '../application/environment-lifecycle-runtime.js';
import { confirmDefault } from '../prompt.js';
import {
  closeStoreSync,
  commitRequiredSteps,
  openStoreSync,
  PendingCommandError,
  withNotices,
} from './store-sync.js';

export const rmCommand: Command = {
  name: 'rm',
  usage: '<name>',
  summary: 'Remove an environment',

  async run(ctx) {
    const { args, paths, env, options } = ctx;
    const parsed = parseArgs(args);
    if (parsed.unknown.length > 0) {
      return { stdout: '', stderr: `rm: unknown option '${parsed.unknown[0]}'\n`, code: 1 };
    }
    const name = parsed.positionals[0];
    if (name === undefined) {
      return { stdout: '', stderr: 'rm: missing environment name\nUsage: agentenv rm <name>\n', code: 1 };
    }
    if (parsed.positionals.length > 1) {
      return { stdout: '', stderr: `rm: unexpected argument '${parsed.positionals[1]}'\nUsage: agentenv rm <name>\n`, code: 1 };
    }
    const inspection = await inspectEnvironmentDeletion({ paths, name });
    if (inspection.status !== 'ready') return presentInspection(inspection);

    const confirm = ctx.options.confirm ?? confirmDefault;
    const confirmed = await confirm(`Remove environment '${name}'? This cannot be undone. [y/N] `);
    if (!confirmed) {
      return {
        stdout: `Aborted; '${name}' was not removed.\n`,
        code: 0,
      };
    }

    const notices: string[] = [];
    const syncCtx = { paths, env, options };
    const runtime = createEnvironmentDeleteRuntime({
      paths,
      open: async () => {
        try {
          const opened = await openStoreSync(syncCtx, notices, {
            stopOnDriftBlocked: true,
          });
          return opened.driftCommitBlocked
            ? {
                status: 'drift-blocked',
                secretBearing: opened.driftBlockReason === 'secret',
              }
            : { status: 'ready' };
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
    const result = await deleteEnvironment({
      paths,
      name,
      runtime,
      expectedTargetIdentity: inspection.targetIdentity,
      expectedContainerIdentity: inspection.containerIdentity,
    });
    return presentDeleteResult(result, notices, name);
  },
};

function activeLocation(activity: EnvironmentActivity): string {
  return [
    activity.session ? 'a session binding' : null,
    activity.globalStack ? 'the global stack' : null,
    activity.materialised ? 'materialised global items' : null,
  ].filter(Boolean).join(' and ');
}

function presentInspection(
  result: Exclude<EnvironmentDeleteResult, { status: 'deleted' | 'git-pending' }>,
): RunResult {
  switch (result.status) {
    case 'invalid':
      return { stdout: '', stderr: `rm: ${result.message}\n`, code: 1 };
    case 'not-found':
      return { stdout: '', stderr: `rm: environment '${result.name}' does not exist\n`, code: 1 };
    case 'active':
      return {
        stdout: '',
        stderr: `rm: environment '${result.name}' is active (${activeLocation(result.activity)}) — deactivate it first\n`,
        code: 1,
      };
    case 'stale':
    case 'failure':
      return { stdout: '', stderr: `rm: ${result.message}\n`, code: 1 };
    case 'pending-recovery':
    case 'drift-blocked':
      return { stdout: '', stderr: 'rm: store state prevents deletion\n', code: 1 };
  }
}

function presentDeleteResult(
  result: EnvironmentDeleteResult,
  notices: readonly string[],
  name: string,
): RunResult {
  switch (result.status) {
    case 'deleted':
    case 'git-pending':
      return withNotices({ stdout: `Removed environment '${result.name}'.\n`, code: 0 }, notices);
    case 'pending-recovery':
      return withNotices({
        stdout: '',
        stderr: `rm: refusing to remove '${name}' while store drift remains uncommitted\n`,
        code: 1,
      }, notices);
    case 'drift-blocked':
      return withNotices({
        stdout: '',
        stderr: result.secretBearing
          ? `rm: refusing to remove '${name}' while secret-bearing store drift is uncommitted\n`
          : `rm: refusing to remove '${name}' while store drift remains uncommitted\n`,
        code: 1,
      }, notices);
    default:
      return withNotices(presentInspection(result), notices);
  }
}
