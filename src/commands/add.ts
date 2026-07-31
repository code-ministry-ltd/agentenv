import { access, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { parseArgs } from '../args.js';
import type { Command, CommandContext, RunResult } from '../command.js';
import {
  scaffoldSkillMd,
  validateItemName,
  validateSkillDir,
  validateSkillName,
} from '../content-items.js';
import { environmentExists, validateEnvName } from '../store.js';

/** Content kinds `add` understands, in help/usage order. */
const KINDS = ['skill', 'mcp', 'instructions', 'agent', 'command'] as const;

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

/** Read a file's text, or undefined when it does not exist. */
async function readFileMaybe(p: string): Promise<string | undefined> {
  try {
    return await readFile(p, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
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

/** Build one canonical `mcp/servers.yaml` server entry (design D6). */
function scaffoldMcpServer(name: string, transport: 'stdio' | 'http'): Record<string, unknown> {
  const varBase = name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  if (transport === 'http') {
    return {
      transport: 'http',
      url: 'https://example.com/mcp',
      auth: { bearer_env: `${varBase}_TOKEN` },
    };
  }
  return {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', `@modelcontextprotocol/server-${name}`],
    env: { [`${varBase}_API_KEY`]: `\${${varBase}_API_KEY}` },
  };
}

/**
 * `add mcp <env> <name> [--transport stdio|http]`.
 *
 * Scaffolds/appends a server entry in `mcp/servers.yaml` (canonical D6 shape).
 * Existing servers are preserved; an existing entry of the same name is refused
 * unless `--force`.
 */
async function addMcp(rest: readonly string[], ctx: CommandContext): Promise<RunResult> {
  const parsed = parseArgs(rest, { booleans: ['force', 'print-path'], values: ['transport'] });
  if (parsed.unknown.length > 0) {
    return fail(`add mcp: unknown option '${parsed.unknown[0]}'\n`);
  }
  const resolved = await resolveEnv('mcp', parsed.positionals[0], ctx.paths);
  if ('error' in resolved) return resolved.error;
  const env = resolved.env;

  const name = parsed.positionals[1];
  if (name === undefined) {
    return fail(
      'add mcp: missing server name\n' +
        'Usage: agentenv add mcp <env> <name> [--transport stdio|http] [--force] [--print-path]\n',
    );
  }
  const nameError = validateItemName('mcp server', name);
  if (nameError) return fail(`add mcp: ${nameError}\n`);

  const transport = parsed.values.get('transport') ?? 'stdio';
  if (transport !== 'stdio' && transport !== 'http') {
    return fail(`add mcp: unknown --transport '${transport}' (expected 'stdio' or 'http')\n`);
  }

  const file = join(ctx.paths.envDir(env), 'mcp', 'servers.yaml');
  if (parsed.booleans.has('print-path')) return ok(`${file}\n`);

  let servers: Record<string, unknown> = {};
  const existingText = await readFileMaybe(file);
  if (existingText !== undefined) {
    const parsedYaml: unknown = parseYaml(existingText);
    if (parsedYaml !== null && parsedYaml !== undefined) {
      if (typeof parsedYaml !== 'object' || Array.isArray(parsedYaml)) {
        return fail(`add mcp: ${file} is not a YAML mapping of server definitions\n`);
      }
      servers = parsedYaml as Record<string, unknown>;
    }
  }

  if (Object.prototype.hasOwnProperty.call(servers, name) && !parsed.booleans.has('force')) {
    return fail(`add mcp: server '${name}' already exists in '${env}' (${file}); pass --force to overwrite\n`);
  }

  servers[name] = scaffoldMcpServer(name, transport);
  await mkdir(join(ctx.paths.envDir(env), 'mcp'), { recursive: true });
  await writeFile(file, stringifyYaml(servers), 'utf8');
  return ok(`Added MCP server '${name}' (${transport}) to environment '${env}'.\n`);
}

/**
 * `add instructions <env> [--harness <h>]`.
 *
 * Creates `instructions/base.md` (or `instructions/<h>.md` with `--harness`).
 * `--print-path` prints the target path without writing (the testable "open");
 * an existing file is refused unless `--force`.
 */
async function addInstructions(rest: readonly string[], ctx: CommandContext): Promise<RunResult> {
  const parsed = parseArgs(rest, { booleans: ['force', 'print-path'], values: ['harness'] });
  if (parsed.unknown.length > 0) {
    return fail(`add instructions: unknown option '${parsed.unknown[0]}'\n`);
  }
  const resolved = await resolveEnv('instructions', parsed.positionals[0], ctx.paths);
  if ('error' in resolved) return resolved.error;
  const env = resolved.env;

  if (parsed.positionals[1] !== undefined) {
    return fail(
      `add instructions: unexpected argument '${parsed.positionals[1]}' ` +
        '(instructions takes no <name>; use --harness <h> for a per-harness file)\n',
    );
  }

  const harness = parsed.values.get('harness');
  if (harness !== undefined) {
    const harnessError = validateItemName('harness', harness);
    if (harnessError) return fail(`add instructions: ${harnessError}\n`);
  }
  const label = harness ?? 'base';
  const file = join(ctx.paths.envDir(env), 'instructions', `${label}.md`);
  if (parsed.booleans.has('print-path')) return ok(`${file}\n`);

  if ((await pathExists(file)) && !parsed.booleans.has('force')) {
    return fail(
      `add instructions: '${label}.md' already exists in '${env}' (${file}); ` +
        'pass --force to overwrite, or --print-path to print its path\n',
    );
  }

  const scope = harness ? `${harness} harness` : 'every harness';
  const body =
    `# ${env} — ${label} instructions\n` +
    '\n' +
    `TODO: write instructions ${label === 'base' ? 'that' : 'the'} ${scope} ` +
    `${label === 'base' ? 'should load' : 'should additionally load'} for this environment.\n`;
  await mkdir(join(ctx.paths.envDir(env), 'instructions'), { recursive: true });
  await writeFile(file, body, 'utf8');
  return ok(`Added ${label} instructions to environment '${env}'.\n`);
}

function scaffoldAgentMd(name: string): string {
  return (
    '---\n' +
    `name: ${name}\n` +
    'description: TODO — describe when this subagent should be used.\n' +
    '---\n' +
    '\n' +
    "TODO: write the subagent's system prompt here.\n"
  );
}

function scaffoldCommandMd(name: string): string {
  return (
    '---\n' +
    'description: TODO — one line describing this command.\n' +
    '---\n' +
    '\n' +
    `# ${name}\n` +
    '\n' +
    'TODO: write the command / prompt template here.\n'
  );
}

/**
 * `add agent|command <env> <name>`: scaffold a `<name>.md` under the kind's
 * store subdirectory. Shared by the two near-identical markdown-item kinds.
 */
async function addMarkdownItem(
  kind: 'agent' | 'command',
  subdir: string,
  scaffold: (name: string) => string,
  rest: readonly string[],
  ctx: CommandContext,
): Promise<RunResult> {
  const parsed = parseArgs(rest, { booleans: ['force', 'print-path'] });
  if (parsed.unknown.length > 0) {
    return fail(`add ${kind}: unknown option '${parsed.unknown[0]}'\n`);
  }
  const resolved = await resolveEnv(kind, parsed.positionals[0], ctx.paths);
  if ('error' in resolved) return resolved.error;
  const env = resolved.env;

  const name = parsed.positionals[1];
  if (name === undefined) {
    return fail(
      `add ${kind}: missing ${kind} name\n` +
        `Usage: agentenv add ${kind} <env> <name> [--force] [--print-path]\n`,
    );
  }
  const nameError = validateItemName(kind, name);
  if (nameError) return fail(`add ${kind}: ${nameError}\n`);

  const file = join(ctx.paths.envDir(env), subdir, `${name}.md`);
  if (parsed.booleans.has('print-path')) return ok(`${file}\n`);
  if ((await pathExists(file)) && !parsed.booleans.has('force')) {
    return fail(
      `add ${kind}: ${kind} '${name}' already exists in '${env}' (${file}); pass --force to overwrite\n`,
    );
  }
  await mkdir(join(ctx.paths.envDir(env), subdir), { recursive: true });
  await writeFile(file, scaffold(name), 'utf8');
  return ok(`Added ${kind} '${name}' to environment '${env}'.\n`);
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
      case 'mcp':
        return addMcp(rest, ctx);
      case 'instructions':
        return addInstructions(rest, ctx);
      case 'agent':
        return addMarkdownItem('agent', 'agents', scaffoldAgentMd, rest, ctx);
      case 'command':
        return addMarkdownItem('command', 'commands', scaffoldCommandMd, rest, ctx);
      default:
        return fail(`add: unknown kind '${kind}'\n${kindsHelp()}`);
    }
  },
};
