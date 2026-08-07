import type { PlannedGitStep } from '../command-plan.js';
import type { Paths } from '../paths.js';
import { readState } from '../state.js';
import {
  publishStagedCommand,
  recoverPendingStagedCommands,
  type PublishStagedCommandRequest,
} from '../staged-command.js';

export type ContentTransferOpenOutcome =
  | { status: 'ready' }
  | { status: 'pending-recovery'; transactionId: string };

export type ContentTransferPublicationOutcome =
  | { status: 'complete' }
  | { status: 'git-pending' };

export type ContentTransferPublicationRequest = Omit<
  PublishStagedCommandRequest,
  'gitBookkeeping'
>;

/** Presentation-neutral boundary around sync and recoverable publication. */
export interface ContentTransferRuntime {
  open(): Promise<ContentTransferOpenOutcome>;
  close(): Promise<void>;
  publish(request: ContentTransferPublicationRequest): Promise<ContentTransferPublicationOutcome>;
}

export interface ContentTransferRuntimeOptions {
  paths: Paths;
  open?: () => Promise<ContentTransferOpenOutcome>;
  close?: () => Promise<void>;
  gitBookkeeping?: (
    steps: readonly PlannedGitStep[],
    transactionId: string,
  ) => Promise<void>;
  onGitPending?: (error: Error, transactionId: string) => void;
}

/** Build the real staged-command adapter while keeping sync policy injectable. */
export function createContentTransferRuntime(
  options: ContentTransferRuntimeOptions,
): ContentTransferRuntime {
  return {
    open: options.open ?? (async () => ({ status: 'ready' })),
    close: options.close ?? (async () => {}),
    publish: async (request) => {
      let observed: ContentTransferPublicationOutcome | undefined;
      const afterPersist = request.afterPersist;
      try {
        await publishStagedCommand({
          ...request,
          afterPersist: async (plan) => {
            if (plan.phase === 'complete') observed = { status: 'complete' };
            else if (plan.commitPoint) observed = { status: 'git-pending' };
            await afterPersist?.(plan);
          },
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
        if (observed?.status === 'complete') {
          await recoverPendingStagedCommands(options.paths, undefined, request.transactionId)
            .catch(() => undefined);
          return observed;
        }
        let retained;
        try {
          retained = (await readState(options.paths)).commands.find(
            (command) => command.transactionId === request.transactionId,
          );
        } catch {
          if (observed?.status !== 'git-pending') throw error;
        }
        if (!retained?.commitPoint && observed?.status !== 'git-pending') throw error;
        options.onGitPending?.(error as Error, request.transactionId);
        return { status: 'git-pending' };
      }
    },
  };
}
