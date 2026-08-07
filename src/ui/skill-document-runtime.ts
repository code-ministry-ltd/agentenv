import { createContentTransferRuntime, type ContentTransferRuntime } from '../application/content-transfer-runtime.js';
import type { RunOptions } from '../command.js';
import { commitRequiredSteps, openStoreSync, PendingCommandError } from '../commands/store-sync.js';
import type { Paths } from '../paths.js';

export interface UiSkillDocumentRuntimeOptions {
  paths: Paths;
  env: NodeJS.ProcessEnv;
  runOptions?: RunOptions;
}

/** Save runtime with pull/recovery and required local commits, deliberately no push. */
export function createUiSkillDocumentRuntime(
  input: UiSkillDocumentRuntimeOptions,
): ContentTransferRuntime {
  const notices: string[] = [];
  const context = {
    paths: input.paths,
    env: input.env,
    options: input.runOptions ?? {},
  };
  return createContentTransferRuntime({
    paths: input.paths,
    open: async () => {
      try {
        await openStoreSync(context, notices);
        return { status: 'ready' };
      } catch (error) {
        if (!(error instanceof PendingCommandError)) throw error;
        return { status: 'pending-recovery', transactionId: error.transactionId };
      }
    },
    // Browser save is local-only. In particular, this does not call closeStoreSync,
    // whose CLI lifecycle includes a fail-soft remote push.
    close: async () => {},
    gitBookkeeping: (steps, transactionId) =>
      commitRequiredSteps(context, steps, notices, transactionId),
  });
}
