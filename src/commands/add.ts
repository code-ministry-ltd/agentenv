import { randomUUID } from 'node:crypto';
import { access, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { parseArgs } from '../args.js';
import type { Command, CommandContext, RunResult } from '../command.js';
import {
  scaffoldSkillMd,
  validateItemName,
  validateSkillDir,
  validateSkillName,
} from '../content-items.js';
import type { SkillSourceRecord } from '../env-config.js';
import { parseEnvConfig, upsertEnvSource } from '../env-config.js';
import { publishStagedBundle } from '../filesystem-bundle.js';
import { rebaseInProgress } from '../git.js';
import { confirmDefault, selectSkillsDefault } from '../prompt.js';
import {
  diffDirs,
  fetchSkillSource,
  hashDir,
  resolveSkillSource,
  scanSkillDirs,
  type ParsedSkillSource,
} from '../skill-source.js';
import { environmentExists, readEnvConfig, validateEnvName } from '../store.js';
import { commitRequiredMutation, withNotices, withStoreSync } from './store-sync.js';

/** Content kinds `add` understands, in help/usage order. */
const KINDS = ['skill', 'mcp', 'instructions', 'agent', 'command'] as const;

function ok(stdout: string): RunResult {
  return { stdout, code: 0 };
}

function fail(stderr: string, code = 1): RunResult {
  return { stdout: '', stderr, code };
}

function kindsHelp(): string {
  return (
    `Kinds: ${KINDS.join(', ')}, skills\n` +
    'Usage: agentenv add <kind> <env> …\n' +
    '       agentenv add skills <env> <owner/repo[/path][@ref]> [--all]   (scan a git source)\n'
  );
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
  try {
    await readEnvConfig(paths, envArg);
  } catch (err) {
    // A deliberately held conflict leaves env.yaml markers on disk. The settled
    // contract permits local content edits in that window but forbids Git/index
    // bookkeeping; sync --resolve owns the eventual commit.
    if (await rebaseInProgress(paths)) return { env: envArg };
    return {
      error: fail(`add ${kind}: environment '${envArg}' has an invalid env.yaml (${(err as Error).message})\n`),
    };
  }
  return { env: envArg };
}

async function publishContentMutation(
  ctx: CommandContext,
  target: string,
  populate: (staged: string) => Promise<void>,
  message: string,
  notices: string[],
): Promise<void> {
  const transactionId = randomUUID();
  const stagingRoot = join(ctx.paths.live, 'commands', transactionId);
  const staged = join(stagingRoot, 'content');
  await mkdir(stagingRoot, { recursive: true });
  try {
    await populate(staged);
    const paused = await rebaseInProgress(ctx.paths);
    await publishStagedBundle({
      paths: ctx.paths,
      transactionId,
      stagingRoot,
      entries: [{ id: 'content', target, staged }],
      ...(!paused ? { gitMessage: message } : {}),
      ...(!paused
        ? {
            gitBookkeeping: () =>
              commitRequiredMutation(
                { paths: ctx.paths, env: ctx.env, options: ctx.options },
                message,
                notices,
              ),
          }
        : {}),
    });
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
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
async function addSkill(
  rest: readonly string[],
  ctx: CommandContext,
  notices: string[],
): Promise<RunResult> {
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
    await publishContentMutation(
      ctx,
      dir,
      (staged) => cp(candidate, staged, { recursive: true, verbatimSymlinks: true }),
      `agentenv: add skill ${result.name} → ${env}`,
      notices,
    );
    return ok(`Copied skill '${result.name}' into environment '${env}' (from ${candidate}).\n`);
  }

  if (target.includes('/')) {
    // A source containing '/' that is not an existing local dir → a git source (D17).
    if (printPath) {
      return fail(
        'add skill: --print-path is not supported for git sources ' +
          '(the skill name is only known after fetching)\n',
      );
    }
    return addSkillFromGit(env, target, force, ctx, notices);
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
  await publishContentMutation(
    ctx,
    dir,
    async (staged) => {
      await mkdir(staged, { recursive: true });
      await writeFile(join(staged, 'SKILL.md'), scaffoldSkillMd(target), 'utf8');
    },
    `agentenv: add skill ${target} → ${env}`,
    notices,
  );
  return ok(`Added skill '${target}' to environment '${env}'.\n`);
}

/** First 7 chars of a commit sha, for compact messages. */
function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** Replace the environment's `skills/<name>/` directory with a copy of `sourceDir`. */
async function copySkillDir(
  ctx: CommandContext,
  env: string,
  name: string,
  sourceDir: string,
  notices: string[],
): Promise<void> {
  const destDir = join(ctx.paths.envDir(env), 'skills', name);
  await publishContentMutation(
    ctx,
    destDir,
    (staged) => cp(sourceDir, staged, { recursive: true, verbatimSymlinks: true }),
    `agentenv: add skill ${name} → ${env}`,
    notices,
  );
}

/**
 * Copy a validated skill directory into the environment's store and record its
 * provenance in `env.yaml`'s `sources:` map (design D17). The destination is
 * replaced wholesale (the caller has already decided overwrite is allowed).
 */
async function writeVendoredSkill(
  ctx: CommandContext,
  env: string,
  name: string,
  sourceDir: string,
  provenance: SkillSourceRecord,
  notices: string[],
): Promise<void> {
  const yamlPath = ctx.paths.envYaml(env);
  const yamlText = await readFile(yamlPath, 'utf8');
  const yamlAfter = upsertEnvSource(yamlText, name, provenance);
  parseEnvConfig(yamlAfter, yamlPath);

  const transactionId = randomUUID();
  const stagingRoot = join(ctx.paths.live, 'commands', transactionId);
  const stagedSkill = join(stagingRoot, 'skill');
  const stagedYaml = join(stagingRoot, 'env.yaml');
  await mkdir(stagingRoot, { recursive: true });
  try {
    await cp(sourceDir, stagedSkill, { recursive: true, verbatimSymlinks: true });
    await writeFile(stagedYaml, yamlAfter, 'utf8');

    const paused = await rebaseInProgress(ctx.paths);
    await publishStagedBundle({
      paths: ctx.paths,
      transactionId,
      stagingRoot,
      entries: [
        {
          id: 'skill-content',
          target: join(ctx.paths.envDir(env), 'skills', name),
          staged: stagedSkill,
        },
        { id: 'skill-provenance', target: yamlPath, staged: stagedYaml },
      ],
      ...(!paused ? { gitMessage: `agentenv: add skill ${name} → ${env}` } : {}),
      ...(!paused
        ? {
            gitBookkeeping: () =>
              commitRequiredMutation(
                { paths: ctx.paths, env: ctx.env, options: ctx.options },
                `agentenv: add skill ${name} → ${env}`,
                notices,
              ),
          }
        : {}),
    });
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

/** The recorded provenance for `name` in `env`, or undefined when there is none. */
async function existingProvenance(
  ctx: CommandContext,
  env: string,
  name: string,
): Promise<SkillSourceRecord | undefined> {
  try {
    const cfg = await readEnvConfig(ctx.paths, env);
    return cfg.sources?.[name];
  } catch {
    return undefined;
  }
}

/**
 * `add skill <env> <gitSource>` — fetch, then vendor exactly ONE skill (design
 * D17). The source path must BE a skill (a dir with SKILL.md); a collection
 * errors listing the candidates. Re-adding the same source is the v1 update path:
 * a content change shows a diff and prompts (respecting `--force`/injected confirm).
 * The temp clone is always cleaned up; a fetch failure changes nothing.
 */
async function addSkillFromGit(
  env: string,
  target: string,
  force: boolean,
  ctx: CommandContext,
  notices: string[],
): Promise<RunResult> {
  const source = await resolveSkillSource(target);
  if ('error' in source) return fail(`add skill: ${source.error}\n`);
  const fetched = await fetchSkillSource(source);
  if ('error' in fetched) return fail(`add skill: ${fetched.error}\n`);

  try {
    if (!(await pathExists(join(fetched.scanDir, 'SKILL.md')))) {
      const candidates = await scanSkillDirs(fetched.scanDir);
      if (candidates.length === 0) {
        return fail(
          `add skill: no SKILL.md found at '${target}'.\n` +
            'Point at a directory containing a SKILL.md, or use `agentenv add skills` to scan a collection.\n',
        );
      }
      const list = candidates.map((c) => `  - ${c.name}`).join('\n');
      return fail(
        `add skill: '${target}' is a collection of ${candidates.length} skills, not one skill.\n` +
          `Use \`agentenv add skills ${env} ${target}\` to choose, or point at one of:\n${list}\n`,
      );
    }

    // Vendored skills pass the SAME strict validation as scaffolded/local ones.
    const validation = await validateSkillDir(fetched.scanDir);
    if ('error' in validation) return fail(`add skill: ${validation.error}\n`);
    const name = validation.name;
    const hash = await hashDir(fetched.scanDir);
    const provenance: SkillSourceRecord = {
      repo: source.repo,
      path: source.subpath,
      ref: fetched.ref,
      commit: fetched.commit,
      hash,
    };

    const destDir = join(ctx.paths.envDir(env), 'skills', name);
    const exists = await pathExists(destDir);
    const prior = exists ? await existingProvenance(ctx, env, name) : undefined;
    const sameSource = prior !== undefined && prior.repo === source.repo && prior.path === source.subpath;

    if (exists && sameSource) {
      // Re-add of the same source: the v1 update path.
      if (prior.hash === hash) {
        return ok(
          `Skill '${name}' in '${env}' is already up to date ` +
            `(source unchanged; ${shortSha(fetched.commit)}).\n`,
        );
      }
      const diff = await diffDirs(destDir, fetched.scanDir);
      if (!force) {
        const confirm = ctx.options.confirm ?? confirmDefault;
        const question =
          `Skill '${name}' has changed at its source:\n${diff}\n\n` +
          `Overwrite '${name}' in '${env}' with the updated source? [y/N] `;
        if (!(await confirm(question))) {
          return ok(`${diff}\n\nLeft skill '${name}' unchanged.\n`);
        }
      }
      await writeVendoredSkill(ctx, env, name, fetched.scanDir, provenance, notices);
      return ok(
        `${diff}\n\nUpdated skill '${name}' in '${env}' ` +
          `(${shortSha(prior.commit)} → ${shortSha(fetched.commit)}).\n`,
      );
    }

    if (exists && !sameSource && !force) {
      // Name collision with a differently-sourced or locally-made skill (D1/D7).
      return fail(
        `add skill: skill '${name}' already exists in '${env}' from a different source; ` +
          'pass --force to overwrite\n',
      );
    }

    await writeVendoredSkill(ctx, env, name, fetched.scanDir, provenance, notices);
    return ok(
      `Vendored skill '${name}' into '${env}' from ${source.repo} (${shortSha(fetched.commit)}).\n`,
    );
  } finally {
    await rm(fetched.cloneDir, { recursive: true, force: true });
  }
}

/** POSIX-style repo path of a skill dir found under a fetched source's scan root. */
function repoPathOf(subpath: string, scanRoot: string, skillDir: string): string {
  const rel = relative(scanRoot, skillDir).split(sep).join('/');
  return [subpath, rel].filter((s) => s !== '').join('/');
}

/**
 * `add skills <env> <source> [--all] [--force]` — scan a source for every skill
 * (design D17), present a checklist (name + description), and install the
 * selection. `--all` installs everything non-interactively; the checklist is an
 * injectable selector so tests never need a TTY. A local directory is scanned in
 * place (no provenance); a git source is cloned and each installed skill records
 * its own provenance. Name collisions skip-and-warn unless `--force`.
 */
async function addSkills(
  rest: readonly string[],
  ctx: CommandContext,
  notices: string[],
): Promise<RunResult> {
  const parsed = parseArgs(rest, { booleans: ['all', 'force'] });
  if (parsed.unknown.length > 0) {
    return fail(`add skills: unknown option '${parsed.unknown[0]}'\n`);
  }
  const resolved = await resolveEnv('skills', parsed.positionals[0], ctx.paths);
  if ('error' in resolved) return resolved.error;
  const env = resolved.env;

  const target = parsed.positionals[1];
  if (target === undefined) {
    return fail(
      'add skills: missing source\n' +
        'Usage: agentenv add skills <env> <owner/repo[/path][@ref]|localDir> [--all] [--force]\n',
    );
  }
  const all = parsed.booleans.has('all');
  const force = parsed.booleans.has('force');

  // Local existing dir → scan in place (no provenance); otherwise a git source.
  const localDir = resolve(ctx.cwd, target);
  let localIsDir: boolean;
  try {
    localIsDir = (await stat(localDir)).isDirectory();
  } catch {
    localIsDir = false;
  }

  let scanRoot: string;
  let cleanup: () => Promise<void> = async () => {};
  let git: { source: ParsedSkillSource; commit: string; ref: string } | undefined;

  if (localIsDir) {
    scanRoot = localDir;
  } else {
    const source = await resolveSkillSource(target);
    if ('error' in source) return fail(`add skills: ${source.error}\n`);
    const fetched = await fetchSkillSource(source);
    if ('error' in fetched) return fail(`add skills: ${fetched.error}\n`);
    scanRoot = fetched.scanDir;
    cleanup = () => rm(fetched.cloneDir, { recursive: true, force: true });
    git = { source, commit: fetched.commit, ref: fetched.ref };
  }

  try {
    const candidates = await scanSkillDirs(scanRoot);
    if (candidates.length === 0) {
      return fail(`add skills: no skills (SKILL.md) found at '${target}'\n`);
    }

    let selected: readonly string[];
    if (all) {
      selected = candidates.map((c) => c.name);
    } else {
      const selector = ctx.options.selectSkills ?? selectSkillsDefault;
      selected = await selector(candidates.map((c) => ({ name: c.name, description: c.description })));
    }
    if (selected.length === 0) {
      return ok('No skills selected; nothing installed. (pass --all to install everything found)\n');
    }

    const wanted = new Set(selected);
    const chosen = candidates.filter((c) => wanted.has(c.name));
    const installed: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];

    for (const c of chosen) {
      const validation = await validateSkillDir(c.dir);
      if ('error' in validation) {
        errors.push(`${c.name}: ${validation.error}`);
        continue;
      }
      const name = validation.name;
      const destDir = join(ctx.paths.envDir(env), 'skills', name);
      if ((await pathExists(destDir)) && !force) {
        skipped.push(`${name} (already exists; \`agentenv add skill\` to update, or --force)`);
        continue;
      }
      if (git) {
        const hash = await hashDir(c.dir);
        await writeVendoredSkill(ctx, env, name, c.dir, {
          repo: git.source.repo,
          path: repoPathOf(git.source.subpath, scanRoot, c.dir),
          ref: git.ref,
          commit: git.commit,
          hash,
        }, notices);
      } else {
        await copySkillDir(ctx, env, name, c.dir, notices);
      }
      installed.push(name);
    }

    const lines: string[] = [];
    if (installed.length > 0) {
      lines.push(`Installed ${installed.length} skill(s) into '${env}': ${installed.join(', ')}.`);
    }
    if (skipped.length > 0) lines.push(`Skipped: ${skipped.join('; ')}.`);
    if (errors.length > 0) lines.push(`Errors: ${errors.join('; ')}.`);
    const text = `${lines.join('\n')}\n`;
    if (installed.length === 0 && errors.length > 0) {
      return fail(text);
    }
    return ok(text);
  } finally {
    await cleanup();
  }
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
async function addMcp(
  rest: readonly string[],
  ctx: CommandContext,
  notices: string[],
): Promise<RunResult> {
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
  await publishContentMutation(
    ctx,
    file,
    (staged) => writeFile(staged, stringifyYaml(servers), 'utf8'),
    `agentenv: add mcp ${name} → ${env}`,
    notices,
  );
  return ok(`Added MCP server '${name}' (${transport}) to environment '${env}'.\n`);
}

/**
 * `add instructions <env> [--harness <h>]`.
 *
 * Creates `instructions/base.md` (or `instructions/<h>.md` with `--harness`).
 * `--print-path` prints the target path without writing (the testable "open");
 * an existing file is refused unless `--force`.
 */
async function addInstructions(
  rest: readonly string[],
  ctx: CommandContext,
  notices: string[],
): Promise<RunResult> {
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
  await publishContentMutation(
    ctx,
    file,
    (staged) => writeFile(staged, body, 'utf8'),
    `agentenv: add instructions → ${env}`,
    notices,
  );
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
  notices: string[],
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
  await publishContentMutation(
    ctx,
    file,
    (staged) => writeFile(staged, scaffold(name), 'utf8'),
    `agentenv: add ${kind} ${name} → ${env}`,
    notices,
  );
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
    if (kind !== 'skills' && !KINDS.includes(kind as (typeof KINDS)[number])) {
      return fail(`add: unknown kind '${kind}'\n${kindsHelp()}`);
    }

    // Every real `add` mutates the store, so it runs inside the git-sync lifecycle:
    // pull-on-invoke first, then the mutation + its commit, then one push. `add skills`
    // commits per skill itself (returns null below); every other kind is committed
    // once by the wrapper with a message derived from the positional args.
    const notices: string[] = [];
    let result: RunResult = fail(`add: unknown kind '${kind}'\n${kindsHelp()}`);
    try {
      await withStoreSync({ paths: ctx.paths, env: ctx.env, options: ctx.options }, notices, async () => {
        result = await dispatchAdd(kind, rest, ctx, notices);
        return null;
      });
    } catch (err) {
      result = fail(
        `add: ${(err as Error).message}; committed filesystem intent was retained for recovery\n`,
      );
    }
    return withNotices(result, notices);
  },
};

/** Dispatch to the kind's handler (all begin/commit/push wiring lives in {@link addCommand}). */
function dispatchAdd(
  kind: string,
  rest: readonly string[],
  ctx: CommandContext,
  notices: string[],
): Promise<RunResult> {
  switch (kind) {
    case 'skill':
      return addSkill(rest, ctx, notices);
    case 'skills':
      return addSkills(rest, ctx, notices);
    case 'mcp':
      return addMcp(rest, ctx, notices);
    case 'instructions':
      return addInstructions(rest, ctx, notices);
    case 'agent':
      return addMarkdownItem('agent', 'agents', scaffoldAgentMd, rest, ctx, notices);
    case 'command':
      return addMarkdownItem('command', 'commands', scaffoldCommandMd, rest, ctx, notices);
    default:
      return Promise.resolve(fail(`add: unknown kind '${kind}'\n${kindsHelp()}`));
  }
}
