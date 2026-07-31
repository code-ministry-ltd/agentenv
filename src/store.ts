import { constants } from 'node:fs';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import type { EnvConfig } from './env-config.js';
import { parseEnvConfig } from './env-config.js';
import type { Paths } from './paths.js';

/**
 * Environment-name rule, chosen to be safe as a directory name and as a token
 * on every harness's CLI: lowercase to avoid collisions on case-insensitive
 * filesystems (macOS), no path separators or dots (blocks `.`/`..` traversal
 * and hidden dirs), starts and ends alphanumeric, 1–64 chars.
 */
export const ENV_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
export const ENV_NAME_RULE =
  "lowercase letters, digits, '-' and '_'; must start and end with a letter or digit; 1–64 chars";

/** Returns an error message for an invalid name, or null when it is valid. */
export function validateEnvName(name: string): string | null {
  if (!ENV_NAME_PATTERN.test(name)) {
    return `invalid environment name '${name}' (${ENV_NAME_RULE})`;
  }
  return null;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the store skeleton exists: `store/environments/` and a generated
 * README explaining the repo to a human who finds it. Idempotent; never
 * overwrites an existing README.
 */
export async function ensureStore(paths: Paths): Promise<void> {
  await mkdir(paths.environments, { recursive: true });
  if (!(await pathExists(paths.storeReadme))) {
    await writeFile(paths.storeReadme, STORE_README, 'utf8');
  }
}

/** List environment names in stable (sorted) order; empty when none exist. */
export async function listEnvironments(paths: Paths): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(paths.environments, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

export function environmentExists(paths: Paths, name: string): Promise<boolean> {
  return pathExists(paths.envDir(name));
}

/**
 * Read and validate an environment's env.yaml. Throws {@link EnvYamlError} on a
 * malformed/too-new manifest, or a filesystem error (ENOENT) when the env or
 * its manifest is missing — callers translate these into CLI errors.
 */
export async function readEnvConfig(paths: Paths, name: string): Promise<EnvConfig> {
  const file = paths.envYaml(name);
  const text = await readFile(file, 'utf8');
  return parseEnvConfig(text, file);
}

export const STORE_README = `# agentenv store

This directory is an [agentenv](https://github.com/code-ministry-ltd/agentenv)
store: named, switchable bundles of AI-agent configuration — skills,
instruction files, MCP servers, subagents, and slash commands.

## Layout

- \`environments/<name>/env.yaml\` — an environment manifest: description,
  notes, and capture-ignore patterns.
- \`environments/<name>/{skills,instructions,mcp,agents,commands,files}/\` —
  created on demand as you add content to an environment.

## Working with it

Prefer the \`agentenv\` CLI over editing by hand:

- \`agentenv list\` — list environments
- \`agentenv show <name>\` — inspect one
- \`agentenv create <name>\` — create one
- \`agentenv edit <name>\` — edit its manifest

Everything here is plain YAML and Markdown in an ordinary directory tree, so it
stays readable and portable even without the CLI.
`;
