import { access } from 'node:fs/promises';
import { parseArgs } from '../args.js';
import type { Command, CommandContext, RunResult } from '../command.js';
import { reconcileRetiredGlobalCows } from '../global-cow.js';
import { withLock } from '../lock.js';
import { abandonCandidate } from '../sync-candidate.js';
import { readState, writeState } from '../state.js';
import { closeStoreSync, commitMutation, withNotices } from './store-sync.js';

function ok(stdout: string): RunResult {
  return { stdout, code: 0 };
}

function fail(stderr: string): RunResult {
  return { stdout: '', stderr, code: 1 };
}

const usage =
  'Usage:\n' +
  '  agentenv resolve projection <id> --quiescent\n' +
  '  agentenv resolve candidate <id> --abandon\n' +
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
  if (projection.phase !== 'retired') {
    return fail(`resolve projection: '${id}' is '${projection.phase}', not retired\n`);
  }

  const result = await reconcileRetiredGlobalCows(ctx.paths, { ids: [id], quiescent: true });
  if (result.quarantined > 0) {
    return fail(
      `resolve projection: '${id}' was quarantined; canonical bytes were not overwritten\n`,
    );
  }
  const notices: string[] = [];
  await commitMutation(
    { paths: ctx.paths, env: ctx.env, options: ctx.options },
    `agentenv: reconcile global projection ${id}`,
    notices,
  );
  await closeStoreSync({ paths: ctx.paths, env: ctx.env, options: ctx.options }, notices);
  return withNotices(
    ok(`Resolved projection '${id}'; retained bytes were not collected.\n`),
    notices,
  );
}

async function resolveCandidate(ctx: CommandContext, id: string, rest: readonly string[]): Promise<RunResult> {
  const parsed = parseArgs(rest, { booleans: ['abandon'] });
  if (
    parsed.unknown.length > 0 ||
    parsed.positionals.length > 0 ||
    !parsed.booleans.has('abandon')
  ) {
    return fail(`resolve candidate: an explicit --abandon is required\n${usage}`);
  }
  try {
    await withLock(ctx.paths, async () => {
      const manifest = await readState(ctx.paths);
      const index = manifest.candidates.findIndex((candidate) => candidate.id === id);
      if (index < 0) throw new Error(`unknown candidate '${id}'`);
      manifest.candidates[index] = abandonCandidate(manifest.candidates[index]!);
      await writeState(ctx.paths, manifest);
    });
  } catch (error) {
    return fail(`resolve candidate: ${(error as Error).message}\n`);
  }
  return ok(`Abandoned candidate '${id}'; its isolated worktree remains retained.\n`);
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
  usage: '<projection|candidate|rescue> <id> …',
  summary: 'Resolve retained projections, candidates, and rescue records',

  async run(ctx): Promise<RunResult> {
    const domain = ctx.args[0];
    const id = ctx.args[1];
    if (!domain || !id) return fail(usage);
    const rest = ctx.args.slice(2);
    switch (domain) {
      case 'projection':
        return resolveProjection(ctx, id, rest);
      case 'candidate':
        return resolveCandidate(ctx, id, rest);
      case 'rescue':
        return resolveRescue(ctx, id, rest);
      default:
        return fail(`resolve: unknown lifecycle kind '${domain}'\n${usage}`);
    }
  },
};
