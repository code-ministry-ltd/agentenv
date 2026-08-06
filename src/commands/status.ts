import { adapters as realAdapters } from '../adapters/index.js';
import type { Command, CommandContext, RunResult } from '../command.js';
import { describeGlobal, type AdapterStatus } from '../engine.js';
import { readConflictMarker } from '../git.js';
import { findBinding, readSessionRegistry, resolveProjectRoot } from '../session/registry.js';
import { readState } from '../state.js';

/**
 * `agentenv status` — the mode + bindings for this shell/project, the active
 * global stack, and per-surface supported/unsupported + shadowing/skips (D6/D7).
 * It NEVER pretends an unsupported surface works — each is listed with its reason.
 */
export const statusCommand: Command = {
  name: 'status',
  usage: '',
  summary: 'Show session bindings, the global stack, and per-surface support',

  async run(ctx): Promise<RunResult> {
    if (ctx.args.length > 0) {
      return { stdout: '', stderr: `status: unexpected argument '${ctx.args[0]}'\nUsage: agentenv status\n`, code: 1 };
    }
    const lines: string[] = ['agentenv status', ''];
    lines.push(...(await syncSection(ctx)));
    lines.push(...(await lifecycleSection(ctx)));
    lines.push(...(await sessionSection(ctx)));
    lines.push('');
    lines.push(...(await globalSection(ctx)));
    return { stdout: `${lines.join('\n')}\n`, code: 0, data: await statusData(ctx) };
  },
};

async function statusData(ctx: CommandContext): Promise<unknown> {
  const { paths, env, cwd, options } = ctx;
  const manifest = await readState(paths);
  const projectRoot = await resolveProjectRoot(cwd);
  const sessionId = env.AGENTENV_SESSION?.trim() || null;
  const binding = sessionId
    ? findBinding(await readSessionRegistry(paths), sessionId, projectRoot)
    : undefined;
  const global = await describeGlobal({ paths, adapters: options.adapters ?? realAdapters, env });
  const conflict = await readConflictMarker(paths);
  return {
    session: {
      projectRoot,
      sessionId,
      mode: binding ? 'bound' : 'unbound',
      envs: binding?.envs ?? [],
      harnesses: binding?.harnesses ?? [],
    },
    global,
    sync: {
      blocked: conflict.pending,
      candidates: manifest.candidates
        .filter((candidate) => candidate.phase !== 'promoted' && candidate.phase !== 'abandoned')
        .map((candidate) => ({
          id: candidate.id,
          phase: candidate.phase,
          blockers: [...candidate.blockers],
          fetchedAt: candidate.fetchedAt,
        })),
    },
    lifecycle: {
      commands: manifest.commands.map((command) => ({
        id: command.transactionId,
        kind: command.kind,
        phase: command.phase,
        gitRequired: command.gitRequired === true,
      })),
      generations: manifest.generations
        .filter((generation) => generation.phase !== 'collected')
        .map((generation) => ({
          id: generation.id,
          phase: generation.phase,
          envs: [...generation.envs],
          reservations: generation.reservations.length,
          leases: generation.leases.length,
        })),
      projections: manifest.globalProjections
        .filter((projection) => projection.phase !== 'collected')
        .map((projection) => ({
          id: projection.id,
          phase: projection.phase,
          ownerEnv: projection.ownerEnv ?? null,
        })),
      rescues: manifest.quarantine
        .filter((rescue) => !rescue.resolved)
        .map((rescue) => ({ id: rescue.id, kind: rescue.kind })),
      migration: manifest.migration
        ? {
            id: manifest.migration.id,
            sourceFormat: manifest.migration.sourceFormat,
            phase: manifest.migration.phase,
            gate: manifest.migration.gate,
            commitPoint: manifest.migration.commitPoint,
          }
        : null,
    },
  };
}

async function lifecycleSection(ctx: CommandContext): Promise<string[]> {
  const manifest = await readState(ctx.paths);
  const commands = manifest.commands;
  const generations = manifest.generations.filter((entry) => entry.phase !== 'collected');
  const projections = manifest.globalProjections.filter((entry) => entry.phase !== 'collected');
  const rescues = manifest.quarantine.filter((entry) => !entry.resolved);
  const migration = manifest.migration;
  if (
    commands.length === 0 &&
    generations.length === 0 &&
    projections.length === 0 &&
    rescues.length === 0 &&
    (!migration || migration.phase === 'opened' || migration.phase === 'rolled-back')
  ) {
    return [];
  }

  const lines = ['Lifecycle:'];
  for (const command of commands) {
    const git = command.gitRequired ? ', Git required' : '';
    lines.push(`  command ${command.transactionId}: ${command.phase} (${command.kind}${git})`);
    const affected = [...new Set(command.operations.map((operation) => operation.path).filter(
      (path): path is string => typeof path === 'string',
    ))];
    for (const path of affected) lines.push(`    affects: ${path}`);
    for (const step of command.gitSteps ?? []) {
      lines.push(
        `    Git ${step.id}: ${step.status ?? 'pending'}` +
          (step.commitId ? ` (${step.commitId.slice(0, 12)})` : ''),
      );
    }
    lines.push(
      `    next: agentenv resolve command ${command.transactionId} --retry`,
    );
  }
  for (const generation of generations) {
    lines.push(
      `  generation ${generation.id}: ${generation.phase}; envs [${generation.envs.join(', ')}]; ` +
        `${generation.reservations.length} reservation(s), ${generation.leases.length} lease(s)`,
    );
  }
  for (const projection of projections) {
    const owner = projection.ownerEnv ? `; owner ${projection.ownerEnv}` : '';
    lines.push(`  projection ${projection.id}: ${projection.phase}${owner}`);
  }
  for (const rescue of rescues) {
    lines.push(`  rescue ${rescue.id}: unresolved (${rescue.kind})`);
  }
  if (migration && migration.phase !== 'opened' && migration.phase !== 'rolled-back') {
    lines.push(`  migration ${migration.id}: ${migration.phase}; gate ${migration.gate}`);
  }
  lines.push('');
  return lines;
}

/**
 * Surface a rebase conflict that is BLOCKING sync (design D9, Task 2.2). Read-only —
 * `status` never itself pulls or aborts; it reports the machine-local marker a prior
 * sync/mutating command left. The store still works from the working tree; the line
 * points the user at the guided walkthrough.
 */
async function syncSection(ctx: CommandContext): Promise<string[]> {
  const marker = await readConflictMarker(ctx.paths);
  const candidates = (await readState(ctx.paths)).candidates.filter(
    (candidate) => candidate.phase !== 'promoted' && candidate.phase !== 'abandoned',
  );
  const lines: string[] = [];
  if (marker.pending) {
    lines.push(
      'Sync:       BLOCKED by a rebase conflict — run `agentenv sync --resolve` to finish syncing',
      '            (or `agentenv sync --abort` to cancel and keep local). The store still works locally.',
    );
  }
  if (candidates.length > 0) {
    if (lines.length === 0) lines.push('Sync candidates:');
    else lines.push('Candidates:');
    for (const candidate of candidates) {
      const blockers = candidate.blockers.length > 0
        ? `; blockers: ${candidate.blockers.join(', ')}`
        : '';
      lines.push(
        `  ${candidate.phase.toUpperCase()} ${candidate.id}${blockers}; retained at ${candidate.worktree}`,
      );
    }
  }
  if (lines.length > 0) lines.push('');
  return lines;
}

async function sessionSection(ctx: CommandContext): Promise<string[]> {
  const { paths, env, cwd } = ctx;
  const session = env.AGENTENV_SESSION;
  const projectRoot = await resolveProjectRoot(cwd);
  const lines = ['Session:', `  project:    ${projectRoot}`];

  if (!session || session.trim() === '') {
    lines.push('  session id: (none — run `eval "$(agentenv shell-init)"` to enable session mode)');
    lines.push('  mode:       unbound');
    return lines;
  }
  lines.push(`  session id: ${session}`);

  const binding = findBinding(await readSessionRegistry(paths), session, projectRoot);
  if (!binding) {
    lines.push('  mode:       unbound (session mode)');
    return lines;
  }
  const scope = binding.harnesses && binding.harnesses.length > 0 ? `  (harnesses: ${binding.harnesses.join(', ')})` : '';
  lines.push(`  mode:       bound → [${binding.envs.join(', ')}]${scope}`);
  return lines;
}

async function globalSection(ctx: CommandContext): Promise<string[]> {
  const { paths, env, options } = ctx;
  const adapters = options.adapters ?? realAdapters;
  const status = await describeGlobal({ paths, adapters, env });

  const lines = [`Global stack: ${status.stack.length > 0 ? `[${status.stack.join(', ')}]` : '(empty)'}`, ''];
  if (status.orphanedEnvs.length > 0) {
    // Owned-but-unstacked envs: a crash committed their items but lost the stack
    // write (Finding 1). Surface them so they are neither invisible nor undroppable
    // (`drop --global --all` clears them).
    lines.push(`Recovered (owned but not in the stack): [${status.orphanedEnvs.join(', ')}]`, '');
  }
  lines.push('Harnesses (global surfaces):');
  if (status.adapters.length === 0) {
    lines.push('  (no adapters registered — global mode needs a harness adapter, Task 1.8/4.x)');
    return lines;
  }

  for (const adapter of status.adapters) {
    lines.push(`  ${adapter.adapterId}`);
    lines.push(...renderAdapter(adapter));
  }
  return lines;
}

function renderAdapter(adapter: AdapterStatus): string[] {
  const lines: string[] = [];
  // Adapter-level session support (D11/D15): a global-only harness (Cursor) says so
  // once, above its per-surface lines, so `status` never implies session mode works.
  if (!adapter.sessionSupported) {
    const reason = adapter.sessionUnsupportedReason ? `: ${adapter.sessionUnsupportedReason}` : '';
    lines.push(`    session-unsupported (global only)${reason}`);
  }
  const width = Math.max(...adapter.surfaces.map((s) => s.surfaceId.length), 1);
  for (const s of adapter.surfaces) {
    const support = s.supported ? 'supported' : `UNSUPPORTED${s.unsupportedReason ? ` (${s.unsupportedReason})` : ''}`;
    const owned = s.supported ? ` — ${s.ownedItems} owned` : '';
    lines.push(`    ${s.surfaceId.padEnd(width)}  ${s.mechanism.padEnd(11)}  ${support}${owned}`);
  }
  for (const skip of adapter.skips) {
    if (skip.reason === 'unsupported') continue; // already shown on the surface line
    lines.push(`    [${skip.reason}] ${skip.detail}`);
  }
  return lines;
}
