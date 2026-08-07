import type { PlannedGitStep } from '../command-plan.js';
import type { Paths } from '../paths.js';
import {
  publishStagedCommand,
  type PublishStagedCommandRequest,
} from '../staged-command.js';
import { readState } from '../state.js';

export type EnvironmentLifecycleOpenOutcome =
  | { status: 'ready' }
  | { status: 'pending-recovery'; transactionId: string };

export type EnvironmentLifecyclePublicationOutcome =
  | { status: 'complete' }
  | { status: 'git-pending' };

export type EnvironmentLifecyclePublicationRequest = Omit<
  PublishStagedCommandRequest,
  'gitBookkeeping'
>;

/** Presentation-neutral boundary around sync and staged publication. */
export interface EnvironmentLifecycleRuntime {
  open(): Promise<EnvironmentLifecycleOpenOutcome>;
  close(): Promise<void>;
  publish(
    request: EnvironmentLifecyclePublicationRequest,
  ): Promise<EnvironmentLifecyclePublicationOutcome>;
}

export interface EnvironmentLifecycleRuntimeOptions {
  paths: Paths;
  open?: () => Promise<EnvironmentLifecycleOpenOutcome>;
  close?: () => Promise<void>;
  gitBookkeeping?: (
    steps: readonly PlannedGitStep[],
    transactionId: string,
  ) => Promise<void>;
  onGitPending?: (error: Error, transactionId: string) => void;
}

/** Build a real staged-publication runtime with injectable, typed sync boundaries. */
export function createEnvironmentLifecycleRuntime(
  options: EnvironmentLifecycleRuntimeOptions,
): EnvironmentLifecycleRuntime {
  return {
    open: options.open ?? (async () => ({ status: 'ready' })),
    close: options.close ?? (async () => {}),
    publish: async (request) => {
      try {
        await publishStagedCommand({
          ...request,
          ...(options.gitBookkeeping
            ? {
                gitBookkeeping: () => options.gitBookkeeping!(
                  request.gitSteps ?? [],
                  request.transactionId,
                ),
              }
            : {}),
        });
        return { status: 'complete' };
      } catch (error) {
        const pending = (await readState(options.paths)).commands.find(
          (command) => command.transactionId === request.transactionId,
        );
        if (!pending?.commitPoint) throw error;
        options.onGitPending?.(error as Error, request.transactionId);
        return { status: 'git-pending' };
      }
    },
  };
}
