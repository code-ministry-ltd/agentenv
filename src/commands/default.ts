import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from '../args.js';
import type { Command, CommandContext, RunResult } from '../command.js';
import { writeFileAtomic } from '../fs-atomic.js';
import { recordApproval } from '../session/approvals.js';
import { resolveProjectRoot } from '../session/registry.js';
import { environmentExists, validateEnvName } from '../store.js';

/** The name of the per-folder default file (D16). Regular file at a project root. */
export const AGENTENV_FILE = '.agentenv';

/**
 * `agentenv default <env>… | --remove` — the per-folder default environment (D16).
 *
 * Writes a committable `.agentenv` at the project root naming the default env(s)
 * for that folder, one env name per line; `--remove` deletes it. The file does
 * nothing on its own — a shim launch only applies it after a one-time per-project
 * approval (the `.mcp.json` trust model). Because running `default` is the user's
 * OWN explicit, local act (not the repo file acting), the write also records that
 * approval for this project on THIS machine, so the author's folder is live at
 * once while a fresh CLONE elsewhere stays inert until approved there. Recording a
 * machine-local trust record is not a machine-wide/real-file mutation, so the D16
 * "session scope only" boundary holds.
 */
export const defaultCommand: Command = {
  name: 'default',
  usage: '<env>… | --remove',
  summary: "Set the folder's default env(s) via a committable .agentenv (D16)",

  async run(ctx): Promise<RunResult> {
    const parsed = parseArgs(ctx.args, { booleans: ['remove'] });
    if (parsed.unknown.length > 0) {
      return { stdout: '', stderr: `default: unknown option '${parsed.unknown[0]}'\n`, code: 1 };
    }
    if (parsed.booleans.has('remove')) {
      if (parsed.positionals.length > 0) {
        return { stdout: '', stderr: 'default: --remove takes no environment names\n', code: 1 };
      }
      return removeDefault(ctx);
    }
    if (parsed.positionals.length === 0) {
      return {
        stdout: '',
        stderr: 'default: missing environment name(s)\nUsage: agentenv default <env>… | --remove\n',
        code: 1,
      };
    }
    return writeDefault(ctx, parsed.positionals);
  },
};

async function writeDefault(ctx: CommandContext, names: readonly string[]): Promise<RunResult> {
  const { paths, cwd, options } = ctx;

  // Validate every name up front — the file is committable, so a malformed name
  // must never be written for another machine to trip over. This is name syntax,
  // not existence: a `.agentenv` may legitimately name an env that lives only on
  // another machine (the file is shared via the repo).
  for (const name of names) {
    const err = validateEnvName(name);
    if (err) return { stdout: '', stderr: `default: ${err}\n`, code: 1 };
  }
  // De-duplicate while preserving order (a later duplicate is meaningless).
  const envs = [...new Set(names)];

  const notices: string[] = [];
  for (const name of envs) {
    if (!(await environmentExists(paths, name))) {
      notices.push(
        `default: environment '${name}' does not exist in this store yet — writing it anyway ` +
          '(a launch will warn and proceed unbound until it exists)',
      );
    }
  }

  const projectRoot = await resolveProjectRoot(cwd);
  const file = join(projectRoot, AGENTENV_FILE);
  await writeFileAtomic(file, `${envs.join('\n')}\n`);

  // Trust the folder on THIS machine — this is the user's explicit local command.
  await recordApproval(paths, projectRoot, options.now);

  const stderr = notices.length > 0 ? `${notices.join('\n')}\n` : undefined;
  return {
    stdout: `Wrote ${file} — default env(s) for this folder: [${envs.join(', ')}].\n`,
    ...(stderr ? { stderr } : {}),
    code: 0,
  };
}

async function removeDefault(ctx: CommandContext): Promise<RunResult> {
  const { cwd } = ctx;
  const projectRoot = await resolveProjectRoot(cwd);
  const file = join(projectRoot, AGENTENV_FILE);
  // rm with force is a no-op when absent — report which happened, never fail.
  const existed = await fileExists(file);
  await rm(file, { force: true });
  return {
    stdout: existed ? `Removed ${file}.\n` : `No ${file} to remove.\n`,
    code: 0,
  };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
