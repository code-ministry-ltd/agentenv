import { adapters as realAdapters } from '../adapters/index.js';
import type { Command, CommandContext, RunResult } from '../command.js';
import { describeGlobal, type AdapterStatus } from '../engine.js';
import { readConflictMarker } from '../git.js';
import { findBinding, readSessionRegistry, resolveProjectRoot } from '../session/registry.js';

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
    const lines: string[] = ['agentenv status', ''];
    lines.push(...(await syncSection(ctx)));
    lines.push(...(await sessionSection(ctx)));
    lines.push('');
    lines.push(...(await globalSection(ctx)));
    return { stdout: `${lines.join('\n')}\n`, code: 0 };
  },
};

/**
 * Surface a rebase conflict that is BLOCKING sync (design D9, Task 2.2). Read-only —
 * `status` never itself pulls or aborts; it reports the machine-local marker a prior
 * sync/mutating command left. The store still works from the working tree; the line
 * points the user at the guided walkthrough.
 */
async function syncSection(ctx: CommandContext): Promise<string[]> {
  const marker = await readConflictMarker(ctx.paths);
  if (!marker.pending) return [];
  return [
    'Sync:       BLOCKED by a rebase conflict — run `agentenv sync --resolve` to finish syncing',
    '            (or `agentenv sync --abort` to cancel and keep local). The store still works locally.',
    '',
  ];
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
