import {
  createEnvironmentLifecycleRuntime,
  type EnvironmentLifecycleRuntime,
} from '../application/environment-lifecycle-runtime.js';
import type { RunOptions } from '../command.js';
import {
  closeStoreSync,
  commitRequiredSteps,
  openStoreSync,
  PendingCommandError,
} from '../commands/store-sync.js';
import type { Paths } from '../paths.js';

export interface UiEnvironmentLifecycleRuntimeOptions {
  paths: Paths;
  env: NodeJS.ProcessEnv;
  runOptions?: RunOptions;
}

/** Production HTTP mutation runtime. Notices stay server-side because command and
 * Git errors can contain private local or remote detail. */
export function createUiEnvironmentLifecycleRuntime(
  input: UiEnvironmentLifecycleRuntimeOptions,
): EnvironmentLifecycleRuntime {
  const notices: string[] = [];
  const syncContext = {
    paths: input.paths,
    env: input.env,
    options: input.runOptions ?? {},
  };
  return createEnvironmentLifecycleRuntime({
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
