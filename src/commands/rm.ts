import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from '../args.js';
import type { Command, CommandContext } from '../command.js';
import { readGlobalStack } from '../engine.js';
import { confirmDefault } from '../prompt.js';
import { readSessionRegistry } from '../session/registry.js';
import { capturePathIdentity } from '../path-identity.js';
import { readState } from '../state.js';
import { environmentExists, validateEnvName } from '../store.js';
import { commandIsPending, publishWithPendingNotice } from './staged-publication.js';
import {
  closeStoreSync,
  commitRequiredSteps,
  openStoreSync,
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
    // Validate BEFORE any path construction: path.join collapses `..`, so an
    // unvalidated name like `..` or `../../x` would let rm -rf escape the store.
    const nameError = validateEnvName(name);
    if (nameError) {
      return { stdout: '', stderr: `rm: ${nameError}\n`, code: 1 };
    }

    if (!(await environmentExists(paths, name))) {
      return { stdout: '', stderr: `rm: environment '${name}' does not exist\n`, code: 1 };
    }

    // Active-env refusal (deferred from Task 1.1): refuse to remove an env that
    // is currently active — bound in any session OR present in the global stack —
    // Active environments must be explicitly deactivated first.
    const activity = await envActivity(ctx, name);
    if (activity.session || activity.globalStack || activity.materialised) {
      const where = [
        activity.session ? 'a session binding' : null,
        activity.globalStack ? 'the global stack' : null,
        activity.materialised ? 'materialised global items' : null,
      ]
        .filter(Boolean)
        .join(' and ');
      return {
        stdout: '',
        stderr: `rm: environment '${name}' is active (${where}) — deactivate it first\n`,
        code: 1,
      };
    }

    const confirm = ctx.options.confirm ?? confirmDefault;
    const expectedPreIdentity = await capturePathIdentity(paths.envDir(name));
    const confirmed = await confirm(`Remove environment '${name}'? This cannot be undone. [y/N] `);
    if (!confirmed) {
      return {
        stdout: `Aborted; '${name}' was not removed.\n`,
        code: 0,
      };
    }

    // Open the Git lifecycle before deletion. If pre-existing drift contains a
    // suspected secret, it may be the only copy; removing the environment would
    // make the subsequent deletion-only commit look safe while losing those bytes.
    const notices: string[] = [];
    const syncCtx = { paths, env, options };
    const before = await openStoreSync(syncCtx, notices);
    if (before.driftCommitBlocked) {
      return withNotices({
        stdout: '',
        stderr: `rm: refusing to remove '${name}' while secret-bearing store drift is uncommitted\n`,
        code: 1,
      }, notices);
    }
    const transactionId = `remove-${name}-${randomUUID()}`;
    const stagingRoot = join(paths.live, 'commands', transactionId);
    await mkdir(stagingRoot, { recursive: true });
    const missingStagedPath = join(stagingRoot, 'absent');
    const gitSteps = [{
      id: 'remove-environment',
      message: `agentenv: remove env ${name}`,
      paths: [paths.envDir(name)],
    }];
    try {
      const publication = await publishWithPendingNotice({
        paths,
        transactionId,
        kind: 'environment-remove',
        stagingRoot,
        allowedRoots: [paths.store],
        entries: [{
          id: 'environment',
          target: paths.envDir(name),
          staged: missingStagedPath,
          expectedPreIdentity,
        }],
        gitSteps,
        gitBookkeeping: () => commitRequiredSteps(syncCtx, gitSteps, notices, transactionId),
      }, notices);
      if (publication === 'complete') await closeStoreSync(syncCtx, notices);
    } catch (error) {
      if (!(await commandIsPending(paths, transactionId))) {
        await rm(stagingRoot, { recursive: true, force: true });
      }
      await closeStoreSync(syncCtx, notices);
      return withNotices({
        stdout: '',
        stderr: `rm: ${(error as Error).message}\n`,
        code: 1,
      }, notices);
    }
    return withNotices({ stdout: `Removed environment '${name}'.\n`, code: 0 }, notices);
  },
};

/**
 * How an env is active, split so the refusal can name each cause precisely:
 * `session` (bound in any shell), `globalStack` (present in the persisted global
 * stack), and `materialised` (owns at least one manifest item on real paths — true
 * for a normally-stacked env AND for a crash-orphaned one whose stack write was lost).
 */
async function envActivity(
  ctx: CommandContext,
  name: string,
): Promise<{ session: boolean; globalStack: boolean; materialised: boolean }> {
  const { paths } = ctx;
  const registry = await readSessionRegistry(paths);
  // NOTE (Finding 4 — record-only, deferred to later/D15): a binding left by a
  // now-dead shell is never garbage-collected, so it still reads as an active
  // session here and forces --drop-first. Accepted for 1.7 — dead-shell binding GC
  // is future work, not part of the engine + core CLI.
  const session = registry.bindings.some((b) => b.envs.includes(name));
  const manifest = await readState(paths);
  const globalStack = readGlobalStack(manifest).includes(name);
  const materialised = manifest.items.some((i) => i.ownerEnv === name);
  return { session, globalStack, materialised };
}
