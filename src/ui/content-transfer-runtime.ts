import { createContentTransferRuntime, type ContentTransferRuntime } from '../application/content-transfer-runtime.js';
import type { RunOptions } from '../command.js';
import {
  closeStoreSync,
  commitRequiredSteps,
  openStoreSync,
  PendingCommandError,
} from '../commands/store-sync.js';
import type { Paths } from '../paths.js';

export interface UiContentTransferRuntimeOptions {
  paths: Paths;
  env: NodeJS.ProcessEnv;
  runOptions?: RunOptions;
}

/** Production transfer adapter. Private sync and Git diagnostics stay server-side. */
export function createUiContentTransferRuntime(
  input: UiContentTransferRuntimeOptions,
): ContentTransferRuntime {
  const notices: string[] = [];
  const syncContext = {
    paths: input.paths,
    env: input.env,
    options: input.runOptions ?? {},
  };
  return createContentTransferRuntime({
    paths: input.paths,
    open: async () => {
      try {
        await openStoreSync(syncContext, notices);
        return { status: 'ready' };
      } catch (error) {
        if (!(error instanceof PendingCommandError)) throw error;
        return { status: 'pending-recovery', transactionId: error.transactionId };
      }
    },
    close: async () => {
      await closeStoreSync(syncContext, notices);
    },
    gitBookkeeping: (steps, transactionId) =>
      commitRequiredSteps(syncContext, steps, notices, transactionId),
  });
}
