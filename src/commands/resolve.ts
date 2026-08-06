import { access } from 'node:fs/promises';
import { parseArgs } from '../args.js';
import type { Command, CommandContext, RunResult } from '../command.js';
import { reconcileRetiredGlobalCows } from '../global-cow.js';
import { recoverPendingFilesystemBundles } from '../filesystem-bundle.js';
import { withLock } from '../lock.js';
import { recoverPendingStagedCommands } from '../staged-command.js';
import { resolveRetainedCandidate } from '../sync.js';
import { resumeSessionGenerationSweep } from '../session/generations.js';
import { readState, writeState } from '../state.js';
import {
  closeStoreSync,
  commitRequiredMutation,
  commitRequiredSteps,
  inScopeAdapters,
  withNotices,
} from './store-sync.js';

function ok(stdout: string): RunResult {
  return { stdout, code: 0 };
}

function fail(stderr: string): RunResult {
  return { stdout: '', stderr, code: 1 };
}

const usage =
  'Usage:\n' +
  '  agentenv resolve command <id> --retry\n' +
  '  agentenv resolve projection <id> --quiescent\n' +
  '  agentenv resolve generation <id> --retry\n' +
  '  agentenv resolve candidate <id> (--retry | --abandon)\n' +
  '  agentenv resolve rescue <id> --acknowledge\n';

async function resolveProjection(ctx: CommandContext, id: string, rest: readonly string[]): Promise<RunResult> {
  const parsed = parseArgs(rest, { booleans: ['quiescent'] });
  if (parsed.unknown.length > 0 || parsed.positionals.length > 0) {
    return fail(`resolve projection: unexpected option or argument\n${usage}`);
  }
  if (!parsed.booleans.has('quiescent')) {
    return fail(
      'resolve projection: refusing without --quiescent; close every unsupervised writer first\n',
    );
  }
  const projection = (await readState(ctx.paths)).globalProjections.find((entry) => entry.id === id);
  if (!projection) return fail(`resolve projection: unknown projection '${id}'\n`);
  if (projection.phase !== 'retired' && projection.phase !== 'reconciling') {
    return fail(
      `resolve projection: '${id}' is '${projection.phase}', not retired or reconciling\n`,
    );
  }

  const notices: string[] = [];
  let result;
  try {
    result = await reconcileRetiredGlobalCows(ctx.paths, {
      ids: [id],
      quiescent: true,
      adapters: inScopeAdapters(ctx.options),
      gitBookkeeping: () =>
        commitRequiredMutation(
          { paths: ctx.paths, env: ctx.env, options: ctx.options },
          `agentenv: reconcile global projection ${id}`,
          notices,
        ),
    });
  } catch (error) {
    return fail(`resolve projection: ${(error as Error).message}; retained intent remains\n`);
  }
  if (result.quarantined > 0) {
    return fail(
      `resolve projection: '${id}' was quarantined; canonical bytes were not overwritten\n`,
    );
  }
  await closeStoreSync({ paths: ctx.paths, env: ctx.env, options: ctx.options }, notices);
  return withNotices(
    ok(`Resolved projection '${id}'; retained bytes were not collected.\n`),
    notices,
  );
}

async function resolveWholeCommand(ctx: CommandContext, id: string, rest: readonly string[]): Promise<RunResult> {
  const parsed = parseArgs(rest, { booleans: ['retry'] });
  if (
    parsed.unknown.length > 0 ||
    parsed.positionals.length > 0 ||
    !parsed.booleans.has('retry')
  ) {
    return fail(`resolve command: an explicit --retry is required\n${usage}`);
  }
  const pending = (await readState(ctx.paths)).commands.find(
    (command) => command.transactionId === id,
  );
  if (!pending) return fail(`resolve command: unknown command '${id}'\n`);
  const executor = (pending as typeof pending & { executor?: unknown }).executor;
  const staged = executor === 'staged-command';
  const legacyBundle = pending.kind === 'filesystem-bundle';
  if (!staged && (!legacyBundle || !pending.gitRequired || !pending.gitMessage)) {
    return fail(
      `resolve command: '${id}' requires its domain-specific resolver; retained intent was unchanged\n`,
    );
  }
  if (staged && pending.commitPoint && pending.gitRequired && !pending.gitSteps?.length) {
    return fail(
      `resolve command: '${id}' has no persisted Git steps; retained intent was unchanged\n`,
    );
  }
  const notices: string[] = [];
  try {
    if (staged) {
      const gitBookkeeping = pending.commitPoint && pending.gitRequired
        ? () =>
            commitRequiredSteps(
              { paths: ctx.paths, env: ctx.env, options: ctx.options },
              pending.gitSteps!,
              notices,
              pending.transactionId,
            )
        : undefined;
      await recoverPendingStagedCommands(ctx.paths, gitBookkeeping, id);
    } else {
      await recoverPendingFilesystemBundles(
        ctx.paths,
        () =>
          commitRequiredMutation(
            { paths: ctx.paths, env: ctx.env, options: ctx.options },
            pending.gitMessage!,
            notices,
          ),
        id,
      );
    }
  } catch (error) {
    return fail(`resolve command: ${(error as Error).message}; retained intent remains\n`);
  }
  await closeStoreSync({ paths: ctx.paths, env: ctx.env, options: ctx.options }, notices);
  return withNotices(ok(`Completed retained command '${id}'.\n`), notices);
}

async function resolveCandidate(ctx: CommandContext, id: string, rest: readonly string[]): Promise<RunResult> {
  const parsed = parseArgs(rest, { booleans: ['retry', 'abandon'] });
  const retry = parsed.booleans.has('retry');
  const abandon = parsed.booleans.has('abandon');
  if (
    parsed.unknown.length > 0 ||
    parsed.positionals.length > 0 ||
    retry === abandon
  ) {
    return fail(`resolve candidate: choose exactly one of --retry or --abandon\n${usage}`);
  }
  try {
    const result = await resolveRetainedCandidate({
      paths: ctx.paths,
      env: ctx.env,
      id,
      action: retry ? 'retry' : 'abandon',
      ...(ctx.options.gitRun ? { gitRun: ctx.options.gitRun } : {}),
    });
    if (result.phase !== 'promoted' && result.phase !== 'abandoned') {
      return fail(
        `resolve candidate: '${id}' remains '${result.phase}' with ` +
          `${result.blockerCount} blocker(s); isolated bytes were retained\n`,
      );
    }
  } catch (error) {
    return fail(`resolve candidate: ${(error as Error).message}\n`);
  }
  if (retry) {
    const notices: string[] = [];
    await closeStoreSync({ paths: ctx.paths, env: ctx.env, options: ctx.options }, notices);
    return withNotices(ok(`Promoted candidate '${id}' from its retained private ref.\n`), notices);
  }
  return ok(`Abandoned candidate '${id}'; its isolated worktree remains retained.\n`);
}

async function resolveGeneration(ctx: CommandContext, id: string, rest: readonly string[]): Promise<RunResult> {
  const parsed = parseArgs(rest, { booleans: ['retry'] });
  if (
    parsed.unknown.length > 0 ||
    parsed.positionals.length > 0 ||
    !parsed.booleans.has('retry')
  ) {
    return fail(`resolve generation: an explicit --retry is required\n${usage}`);
  }
  const notices: string[] = [];
  try {
    await resumeSessionGenerationSweep(
      ctx.paths,
      id,
      () =>
        commitRequiredMutation(
          { paths: ctx.paths, env: ctx.env, options: ctx.options },
          `agentenv: sweep session generation ${id}`,
          notices,
        ),
      (ctx.options.now ?? Date.now)(),
    );
  } catch (error) {
    return fail(`resolve generation: ${(error as Error).message}\n`);
  }
  await closeStoreSync({ paths: ctx.paths, env: ctx.env, options: ctx.options }, notices);
  return withNotices(ok(`Completed retained final sweep for generation '${id}'.\n`), notices);
}

async function resolveRescue(ctx: CommandContext, id: string, rest: readonly string[]): Promise<RunResult> {
  const parsed = parseArgs(rest, { booleans: ['acknowledge'] });
  if (
    parsed.unknown.length > 0 ||
    parsed.positionals.length > 0 ||
    !parsed.booleans.has('acknowledge')
  ) {
    return fail(`resolve rescue: an explicit --acknowledge is required\n${usage}`);
  }
  try {
    await withLock(ctx.paths, async () => {
      const manifest = await readState(ctx.paths);
      const rescue = manifest.quarantine.find((entry) => entry.id === id);
      if (!rescue) throw new Error(`unknown rescue '${id}'`);
      await access(rescue.retainedPath);
      rescue.resolved = true;
      await writeState(ctx.paths, manifest);
    });
  } catch (error) {
    return fail(`resolve rescue: ${(error as Error).message}\n`);
  }
  return ok(`Acknowledged rescue '${id}'; retained bytes were not collected.\n`);
}

/** Explicitly resolve retained lifecycle records; no mode implicitly deletes bytes. */
export const resolveCommand: Command = {
  name: 'resolve',
  usage: '<command|projection|generation|candidate|rescue> <id> …',
  summary: 'Resolve retained commands, projections, generations, candidates, and rescues',

  async run(ctx): Promise<RunResult> {
    const domain = ctx.args[0];
    const id = ctx.args[1];
    if (!domain || !id) return fail(usage);
    const rest = ctx.args.slice(2);
    switch (domain) {
      case 'command':
        return resolveWholeCommand(ctx, id, rest);
      case 'projection':
        return resolveProjection(ctx, id, rest);
      case 'candidate':
        return resolveCandidate(ctx, id, rest);
      case 'generation':
        return resolveGeneration(ctx, id, rest);
      case 'rescue':
        return resolveRescue(ctx, id, rest);
      default:
        return fail(`resolve: unknown lifecycle kind '${domain}'\n${usage}`);
    }
  },
};
