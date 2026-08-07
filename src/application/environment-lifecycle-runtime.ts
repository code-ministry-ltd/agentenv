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

export type EnvironmentDeleteOpenOutcome =
  | EnvironmentLifecycleOpenOutcome
  | { status: 'drift-blocked'; secretBearing: boolean };

/** Delete opens the store before removing the only retained copy, so it also
 * reports whether pre-existing drift could not be committed safely. */
export interface EnvironmentDeleteRuntime {
  open(): Promise<EnvironmentDeleteOpenOutcome>;
  close(): Promise<void>;
  publish(
    request: EnvironmentLifecyclePublicationRequest,
  ): Promise<EnvironmentLifecyclePublicationOutcome>;
}

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

export interface EnvironmentDeleteRuntimeOptions extends Omit<
  EnvironmentLifecycleRuntimeOptions,
  'open'
> {
  open: () => Promise<EnvironmentDeleteOpenOutcome>;
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

/** Build the delete variant of the real staged-publication runtime. */
export function createEnvironmentDeleteRuntime(
  options: EnvironmentDeleteRuntimeOptions,
): EnvironmentDeleteRuntime {
  const { open, ...lifecycleOptions } = options;
  const lifecycle = createEnvironmentLifecycleRuntime(lifecycleOptions);
  return {
    open,
    close: lifecycle.close,
    publish: lifecycle.publish,
  };
}
