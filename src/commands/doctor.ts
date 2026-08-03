import { parseArgs } from '../args.js';
import type { Command, CommandContext, RunResult } from '../command.js';
import { diagnose, repair, restoreBackup, type DoctorProblem } from '../doctor.js';

/**
 * `agentenv doctor [--repair] [--restore <backup>]` (design D4, spec criterion 6).
 *
 * - **no flag** — DETECT + REPORT, read-only. Prints every inconsistency between
 *   the write-ahead manifest and the real surfaces it owns (dangling links,
 *   mangled marker regions, reserialised config, orphaned backups, a pending
 *   journal, store-vs-manifest drift). Exits NON-ZERO when problems are found,
 *   zero when clean. Mutates nothing.
 * - **`--repair`** — roll the journal forward/back and re-drive every broken
 *   surface from the manifest + store, then re-scan; exits zero once clean.
 *   Idempotent and crash-safe (it reuses the journalled, lock-guarded mechanisms).
 * - **`--restore <backup>`** — restore one content-addressed backup to its
 *   manifest-recorded path (added in a later slice).
 */
export const doctorCommand: Command = {
  name: 'doctor',
  usage: '[--repair] [--restore <backup>]',
  summary: 'Detect and repair inconsistencies between the manifest and real surfaces',

  async run(ctx): Promise<RunResult> {
    const parsed = parseArgs(ctx.args, { booleans: ['repair'], values: ['restore'] });
    if (parsed.unknown.length > 0) {
      return fail(`doctor: unknown option '${parsed.unknown[0]}'\n`);
    }
    if (parsed.positionals.length > 0) {
      return fail(`doctor: unexpected argument '${parsed.positionals[0]}'\n`);
    }
    const wantRepair = parsed.booleans.has('repair');
    const wantRestore = parsed.values.has('restore');
    if (wantRepair && wantRestore) {
      return fail('doctor: --repair and --restore are mutually exclusive\n');
    }
    if (wantRestore) return runRestore(ctx, parsed.values.get('restore') ?? '');
    if (wantRepair) return runRepair(ctx);
    return runDiagnose(ctx);
  },
};

function fail(message: string): RunResult {
  return { stdout: '', stderr: message, code: 1 };
}

/** Render one problem as an indented block. */
function renderProblem(p: DoctorProblem): string {
  return (
    `  [${p.kind}] ${p.what}\n` + //
    `    where:  ${p.where}\n` +
    `    repair: ${p.repair}\n`
  );
}

/** `doctor` (no flag): report problems, exit 1 when any are found, 0 when clean. */
async function runDiagnose(ctx: CommandContext): Promise<RunResult> {
  const problems = await diagnose(ctx.paths);
  if (problems.length === 0) {
    return { stdout: 'doctor: no problems found.\n', code: 0 };
  }
  const body = problems.map(renderProblem).join('\n');
  return {
    stdout:
      `doctor found ${problems.length} problem(s):\n\n${body}\n` +
      `Run 'agentenv doctor --repair' to fix.\n`,
    code: 1,
  };
}

/** `doctor --repair`: fix what can be fixed, then re-scan; exit 0 once clean. */
async function runRepair(ctx: CommandContext): Promise<RunResult> {
  const result = await repair(ctx.paths);
  const lines: string[] = [];
  if (result.actions.length === 0) {
    lines.push('doctor --repair: nothing to repair.');
  } else {
    lines.push(`doctor --repair: applied ${result.actions.length} fix(es):`);
    for (const a of result.actions) lines.push(`  - ${a}`);
  }
  if (result.remaining.length === 0) {
    lines.push('doctor: all clear.');
    return { stdout: `${lines.join('\n')}\n`, code: 0 };
  }
  lines.push('', `doctor: ${result.remaining.length} problem(s) remain after repair:`, '');
  const body = result.remaining.map(renderProblem).join('\n');
  return { stdout: `${lines.join('\n')}\n${body}`, code: 1 };
}

/** `doctor --restore <backup>`: restore one content-addressed backup to its path. */
async function runRestore(ctx: CommandContext, backupId: string): Promise<RunResult> {
  if (backupId.trim() === '') {
    return fail('doctor: --restore requires a backup id\n');
  }
  const res = await restoreBackup(ctx.paths, backupId);
  if (!res.restored) {
    return { stdout: '', stderr: `doctor --restore: ${res.error}\n`, code: 1 };
  }
  return {
    stdout:
      `doctor --restore: restored backup '${backupId.trim()}' to ${res.path}\n` +
      (res.rescuedPath ? `doctor --restore: retained displaced current bytes at ${res.rescuedPath}\n` : ''),
    code: 0,
  };
}
