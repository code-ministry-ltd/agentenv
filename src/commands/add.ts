import { access, cp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from '../args.js';
import type { Command, CommandContext, RunResult } from '../command.js';
import { scaffoldSkillMd, validateSkillDir, validateSkillName } from '../content-items.js';
import { environmentExists, validateEnvName } from '../store.js';

/** Content kinds `add` understands, in help/usage order. */
const KINDS = ['skill'] as const;

function ok(stdout: string): RunResult {
  return { stdout, code: 0 };
}

function fail(stderr: string, code = 1): RunResult {
  return { stdout: '', stderr, code };
}

function kindsHelp(): string {
  return `Kinds: ${KINDS.join(', ')}\nUsage: agentenv add <kind> <env> …\n`;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate the shared leading `<env>` argument every kind takes: a well-formed
 * name (checked before any path join, so `add … ../x` can't escape the store)
 * that names an existing environment. Returns the env name or an error result.
 */
async function resolveEnv(
  kind: string,
  envArg: string | undefined,
  paths: CommandContext['paths'],
): Promise<{ env: string } | { error: RunResult }> {
  if (envArg === undefined) {
    return {
      error: fail(`add ${kind}: missing environment name\nUsage: agentenv add ${kind} <env> …\n`),
    };
  }
  const nameError = validateEnvName(envArg);
  if (nameError) {
    return { error: fail(`add ${kind}: ${nameError}\n`) };
  }
  if (!(await environmentExists(paths, envArg))) {
    return { error: fail(`add ${kind}: environment '${envArg}' does not exist\n`) };
  }
  return { env: envArg };
}

/**
 * `add skill <env> <name|localPath>`.
 *
 * Name-vs-path resolution (design D17): an argument that resolves to an existing
 * local directory is a LOCAL PATH — the skill is copied in and validated exactly
 * like a scaffolded one. Otherwise an argument containing `/` is a source that
 * doesn't exist locally: git/`owner/repo` sources are Task 1.10, so it errors.
 * A bare token with no `/` is a NAME to scaffold.
 */
async function addSkill(rest: readonly string[], ctx: CommandContext): Promise<RunResult> {
  const parsed = parseArgs(rest, { booleans: ['force', 'print-path'] });
  if (parsed.unknown.length > 0) {
    return fail(`add skill: unknown option '${parsed.unknown[0]}'\n`);
  }
  const resolved = await resolveEnv('skill', parsed.positionals[0], ctx.paths);
  if ('error' in resolved) return resolved.error;
  const env = resolved.env;

  const target = parsed.positionals[1];
  if (target === undefined) {
    return fail(
      'add skill: missing skill name or local path\n' +
        'Usage: agentenv add skill <env> <name|localPath> [--force] [--print-path]\n',
    );
  }

  const force = parsed.booleans.has('force');
  const printPath = parsed.booleans.has('print-path');
  const skillsDir = join(ctx.paths.envDir(env), 'skills');

  const candidate = resolve(ctx.cwd, target);
  let isDir: boolean;
  try {
    isDir = (await stat(candidate)).isDirectory();
  } catch {
    isDir = false;
  }

  if (isDir) {
    // LOCAL PATH: copy + validate.
    const result = await validateSkillDir(candidate);
    if ('error' in result) return fail(`add skill: ${result.error}\n`);
    const dir = join(skillsDir, result.name);
    if (printPath) return ok(`${dir}\n`);
    const exists = await pathExists(dir);
    if (exists && !force) {
      return fail(
        `add skill: skill '${result.name}' already exists in '${env}' (${dir}); pass --force to overwrite\n`,
      );
    }
    if (exists) await rm(dir, { recursive: true, force: true });
    await mkdir(skillsDir, { recursive: true });
    await cp(candidate, dir, { recursive: true });
    return ok(`Copied skill '${result.name}' into environment '${env}' (from ${candidate}).\n`);
  }

  if (target.includes('/')) {
    // A source path/spec that does not exist locally. Git sources are Task 1.10.
    return fail(
      `add skill: '${target}' is not an existing local directory.\n` +
        'Local skill directories are copied in; git/owner-repo sources arrive in a later release.\n',
    );
  }

  // NAME: scaffold a fresh SKILL.md whose frontmatter name matches the folder.
  const nameError = validateSkillName(target);
  if (nameError) return fail(`add skill: ${nameError}\n`);
  const dir = join(skillsDir, target);
  const file = join(dir, 'SKILL.md');
  if (printPath) return ok(`${file}\n`);
  const exists = await pathExists(dir);
  if (exists && !force) {
    return fail(
      `add skill: skill '${target}' already exists in '${env}' (${dir}); pass --force to overwrite\n`,
    );
  }
  if (exists) await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(file, scaffoldSkillMd(target), 'utf8');
  return ok(`Added skill '${target}' to environment '${env}'.\n`);
}

export const addCommand: Command = {
  name: 'add',
  usage: '<kind> <env> …',
  summary: 'Add a skill, MCP server, instructions, agent or command to an environment',

  async run(ctx): Promise<RunResult> {
    const kind = ctx.args[0];
    if (kind === undefined) {
      return fail(`add: missing kind\n${kindsHelp()}`);
    }
    const rest = ctx.args.slice(1);
    switch (kind) {
      case 'skill':
        return addSkill(rest, ctx);
      default:
        return fail(`add: unknown kind '${kind}'\n${kindsHelp()}`);
    }
  },
};
