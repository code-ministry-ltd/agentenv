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

/**
 * The README written into a fresh store. Its audience is a HUMAN WHO FOUND THIS
 * REPO ON ANOTHER MACHINE — cloned from a sync remote, or stumbled on in a
 * backup — with no idea what it is. So it explains the layout, names the
 * machine-local siblings that are deliberately NOT in here (state.json,
 * secrets.env, backups/, live/, shims/), says plainly that secrets are never
 * synced, and shows how to restore the whole thing onto a new machine.
 *
 * Written by {@link ensureStore} only when absent, so a user who edits it keeps
 * their version forever.
 */
export const STORE_README = `# agentenv store

This directory is an [agentenv](https://github.com/code-ministry-ltd/agentenv)
store: named, switchable bundles of AI-agent configuration — skills,
instruction files, MCP servers, subagents, and slash commands. \`agentenv\`
activates a bundle across whichever AI coding harness you use (Claude Code,
Codex, OpenCode, Pi, Cursor).

This repo is the **synced half** of an agentenv installation. It contains
content only — no credentials, no machine state.

## Layout

\`\`\`
store/                     ← this repo
├── README.md              this file (generated; edit it freely, it is never overwritten)
├── .gitignore
└── environments/
    └── <name>/
        ├── env.yaml       the environment manifest: description, notes,
        │                  capture-ignore patterns
        ├── skills/        one directory per skill (SKILL.md + its files)
        ├── instructions/  base.md, or <harness>.md for a per-harness file
        ├── mcp/
        │   └── servers.yaml   CANONICAL MCP server definitions for this env
        ├── agents/        subagent definitions, one .md per agent
        ├── commands/      slash commands, one .md per command
        └── files/         anything else the environment carries
\`\`\`

Every content subdirectory is created on demand, so a young environment will
have only \`env.yaml\`.

### \`mcp/servers.yaml\`

The canonical, harness-neutral definition of this environment's MCP servers.
Each harness's own format (\`.claude.json\`, \`config.toml\`, \`opencode.json\`,
\`~/.cursor/mcp.json\`) is generated FROM this file at activation time — this
file is the source of truth, and a harness-side edit never writes back into it.
Secret values are held as \`\${VAR}\` placeholders, never literals.

## What is deliberately NOT in this repo

An agentenv installation is \`~/.agentenv/\`, and this store is only one entry
in it. These siblings sit BESIDE the store and are **machine-local by design**:

| Path                       | What it is                                            |
|----------------------------|-------------------------------------------------------|
| \`~/.agentenv/state.json\`   | The write-ahead ownership manifest: what agentenv put where on THIS machine. |
| \`~/.agentenv/secrets.env\`  | \`\${VAR}\` values. **Never synced.** See below.          |
| \`~/.agentenv/backups/\`     | Content-addressed pre-mutation backups.               |
| \`~/.agentenv/live/\`        | Composed private session views. Disposable.           |
| \`~/.agentenv/shims/\`       | PATH shims, one per harness.                          |

None of them is in this repo, and none of them should ever be added to it.

### Secrets are never synced

\`secrets.env\` lives outside this repo on purpose: **no secret value ever
reaches the store.** The store holds \`\${VAR}\` placeholders; the values are
resolved on each machine from that machine's \`secrets.env\` (then the shell
environment) at the moment a config is written.

So cloning this repo gives you the environments but not the credentials. On the
new machine, run \`agentenv secret set <KEY> <VALUE>\` for each placeholder. Any
server whose secret is missing is reported and skipped — it fails closed rather
than writing an empty value.

## Restoring this store on a new machine

\`\`\`sh
agentenv init --remote <this repo's URL>
agentenv list
agentenv use <name> --global
\`\`\`

\`init --remote\` clones this repo into \`~/.agentenv/store\` when the machine
has no store yet, then rebuilds the local machinery around it.

## Working with it

Prefer the \`agentenv\` CLI over editing by hand — it commits each change and
keeps the ownership manifest honest:

- \`agentenv list\` — list environments
- \`agentenv show <name>\` — inspect one
- \`agentenv create <name>\` — create one
- \`agentenv edit <name>\` — edit its manifest
- \`agentenv add <kind> <name> …\` — add a skill, MCP server, instructions,
  subagent or command
- \`agentenv sync\` — pull-rebase and push this repo

Everything here is plain YAML and Markdown in an ordinary directory tree, so it
stays readable and portable even without the CLI. Editing a file by hand is
fine; \`agentenv\` picks the change up on its next invocation and commits it.
`;
