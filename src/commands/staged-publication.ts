import type { Paths } from '../paths.js';
import {
  publishStagedCommand,
  type PublishStagedCommandRequest,
} from '../staged-command.js';
import { readState } from '../state.js';

/** Publish a staged command while preserving the existing fail-soft CLI contract
 * for a local change whose required Git commit could not be completed. */
export async function publishWithPendingNotice(
  req: PublishStagedCommandRequest,
  notices: string[],
): Promise<'complete' | 'git-pending'> {
  try {
    await publishStagedCommand(req);
    return 'complete';
  } catch (error) {
    const pending = (await readState(req.paths)).commands.find(
      (command) => command.transactionId === req.transactionId,
    );
    if (!pending?.commitPoint) throw error;
    notices.push(
      `agentenv: required commit is pending — ${(error as Error).message}. ` +
        `The local change and recovery data are retained; run ` +
        `\`agentenv resolve command ${req.transactionId} --retry\`.`,
    );
    return 'git-pending';
  }
}

/** Whether a retained staged draft still exists after an unsuccessful publish. */
export async function commandIsPending(paths: Paths, transactionId: string): Promise<boolean> {
  return (await readState(paths)).commands.some(
    (command) => command.transactionId === transactionId,
  );
}
