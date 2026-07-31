import {
  adoptSweep,
  singular,
  type AdoptedRecord,
  type AdoptSweepResult,
} from '../adopt.js';
import { parseArgs } from '../args.js';
import type { Command, CommandContext, RunResult } from '../command.js';
import { confirmDefault } from '../prompt.js';
import { closeStoreSync, commitMutation, openStoreSync, withNotices } from './store-sync.js';

/**
 * `agentenv capture [--dry-run]` — run the auto-adopt sweep now (design D10).
 *
 * Every mid-session-created skill/agent/command in an activated managed dir that
 * the snapshot marks NEW and unowned is adopted into its surface's top env:
 * moved into the store, symlinked back, owned, and **auto-committed per adoption**
 * (`agentenv: adopt skill foo → work`, D9). `--dry-run` previews exactly what
 * would be adopted and changes nothing — the safe way to inspect before letting
 * the sweep run. Guardrails (foreign-manager symlink, secret prompt, project dir,
 * no active env) are applied in {@link adoptSweep}.
 */
export const captureCommand: Command = {
  name: 'capture',
  usage: '[--dry-run]',
  summary: 'Run the auto-adopt sweep now (or --dry-run to preview it)',

  async run(ctx): Promise<RunResult> {
    const parsed = parseArgs(ctx.args, { booleans: ['dry-run'] });
    if (parsed.unknown.length > 0) {
      return { stdout: '', stderr: `capture: unknown option '${parsed.unknown[0]}'\n`, code: 1 };
    }
    const dryRun = parsed.booleans.has('dry-run');
    return dryRun ? previewCapture(ctx) : runCapture(ctx);
  },
};

/** A real sweep: adopt + auto-commit each adoption inside the git-sync lifecycle. */
async function runCapture(ctx: CommandContext): Promise<RunResult> {
  const { paths, env, options } = ctx;
  const notices: string[] = [];
  const syncCtx = { paths, env, options };

  // Pull-on-invoke + post-pull safeguards (D9). A quarantined pull means we must
  // not touch surfaces — abort the sweep and report. `skipAdopt`: capture runs its
  // OWN (interactive) sweep below, so the lifecycle must not also auto-adopt.
  const before = await openStoreSync(syncCtx, notices, { skipAdopt: true });
  if (before.quarantined) {
    await closeStoreSync(syncCtx, notices);
    return withNotices(
      { stdout: 'Did NOT capture — pulled store changes were quarantined (malformed or secret-bearing).\n', code: 0 },
      notices,
    );
  }

  const confirm = options.confirm ?? confirmDefault;
  const result = await adoptSweep({
    paths,
    confirm,
    note: (m) => notices.push(m),
    onAdopt: async (rec: AdoptedRecord) => {
      await commitMutation(
        syncCtx,
        `agentenv: adopt ${singular(rec.storeKind)} ${rec.name} → ${rec.ownerEnv}`,
        notices,
      );
    },
  });

  await closeStoreSync(syncCtx, notices); // one fail-soft push (D9).
  return withNotices({ stdout: renderResult(result), code: 0 }, notices);
}

/** A preview: sweep in dry-run mode; touch nothing, commit nothing, push nothing. */
async function previewCapture(ctx: CommandContext): Promise<RunResult> {
  const { paths, options } = ctx;
  const result = await adoptSweep({
    paths,
    dryRun: true,
    confirm: options.confirm ?? confirmDefault,
  });
  return { stdout: renderResult(result), code: 0 };
}

/** Human summary of a sweep: the adopted (or would-adopt) items, one per line. */
function renderResult(result: AdoptSweepResult): string {
  if (result.adopted.length === 0) {
    return 'Nothing to adopt.\n';
  }
  const verb = result.dryRun ? 'Would adopt' : 'Adopted';
  const lines = result.adopted.map((a) => `  ${singular(a.storeKind)} '${a.name}' → ${a.ownerEnv}`);
  const tail = result.dryRun ? '\nRun `agentenv capture` to adopt them.\n' : '\n';
  return `${verb} ${result.adopted.length} item(s):\n${lines.join('\n')}\n${tail}`;
}
