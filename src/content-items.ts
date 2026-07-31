import { basename, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';

/**
 * The STRICTEST cross-harness skill-name rule (design D17): a skill is a folder
 * whose name must equal its SKILL.md frontmatter `name`, and that name must be a
 * single folder-safe, lowercase, kebab-case token so it is legal as a directory
 * on every filesystem and as an identifier in every harness that reads SKILL.md.
 *
 * Kebab-case only — lowercase letters/digits in hyphen-separated segments, no
 * underscores, no leading/trailing/consecutive hyphens. This is deliberately
 * tighter than {@link ENV_NAME_PATTERN} (which allows `_`): environment names are
 * ours alone, whereas a skill name is consumed by third-party harnesses whose
 * common denominator is kebab-case.
 */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SKILL_NAME_MAX = 64;
export const SKILL_NAME_RULE =
  "lowercase letters, digits and single hyphens (kebab-case); must start and end " +
  'with a letter or digit; no consecutive hyphens; 1–64 chars';

/** Returns an error message for an invalid skill name, or null when it is valid. */
export function validateSkillName(name: string): string | null {
  if (name.length > SKILL_NAME_MAX || !SKILL_NAME_PATTERN.test(name)) {
    return `invalid skill name '${name}' (${SKILL_NAME_RULE})`;
  }
  return null;
}

/**
 * Name rule for the non-skill content items (MCP servers, agents, commands) and
 * harness tokens: a single lowercase token, letters/digits plus `-`/`_`, starting
 * and ending alphanumeric, 1–64 chars. Folder- and key-safe, and blocks `.`/`..`
 * traversal and hidden names. Looser than the skill rule (underscores allowed)
 * because these names are not the strict cross-harness SKILL.md identifier.
 */
export const ITEM_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
export const ITEM_NAME_RULE =
  "lowercase letters, digits, '-' and '_'; must start and end with a letter or " +
  'digit; 1–64 chars';

/** Returns an error message for an invalid item name, or null when it is valid. */
export function validateItemName(kind: string, name: string): string | null {
  if (!ITEM_NAME_PATTERN.test(name)) {
    return `invalid ${kind} name '${name}' (${ITEM_NAME_RULE})`;
  }
  return null;
}

/**
 * Parse a leading YAML frontmatter block (`---\n…\n---`) from a Markdown file.
 * Returns the parsed mapping, or null when the text has no frontmatter or its
 * frontmatter is not a YAML mapping.
 */
export function parseFrontmatter(text: string): Record<string, unknown> | null {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return null;
  let data: unknown;
  try {
    data = parseYaml(match[1]!);
  } catch {
    return null;
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  return data as Record<string, unknown>;
}

/** Outcome of validating a skill directory: the resolved name, or an error. */
export type SkillDirResult = { name: string } | { error: string };

/**
 * Validate a skill directory exactly as a scaffolded one is validated (design
 * D17): it must contain a `SKILL.md` with YAML frontmatter carrying a `name`
 * that (a) passes the strict skill-name rule and (b) equals the folder name.
 * `dir` is an absolute path; its basename is the folder name.
 */
export async function validateSkillDir(dir: string): Promise<SkillDirResult> {
  const folder = basename(dir);
  const skillMd = join(dir, 'SKILL.md');
  let text: string;
  try {
    text = await readFile(skillMd, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { error: `no SKILL.md found in '${dir}'` };
    }
    throw err;
  }
  const frontmatter = parseFrontmatter(text);
  if (!frontmatter) {
    return {
      error: `SKILL.md in '${dir}' has no valid YAML frontmatter (expected a leading '---' block with a 'name:' field)`,
    };
  }
  const name = frontmatter.name;
  if (typeof name !== 'string' || name === '') {
    return { error: `SKILL.md in '${dir}' is missing a frontmatter 'name' field` };
  }
  const nameError = validateSkillName(name);
  if (nameError) {
    return { error: nameError };
  }
  if (name !== folder) {
    return {
      error: `skill folder name '${folder}' must equal its SKILL.md frontmatter name '${name}'`,
    };
  }
  return { name };
}

/** Render a valid scaffolded SKILL.md whose frontmatter name matches the folder. */
export function scaffoldSkillMd(name: string): string {
  return (
    '---\n' +
    `name: ${name}\n` +
    'description: TODO — one sentence on when this skill should be used.\n' +
    '---\n' +
    '\n' +
    `# ${name}\n` +
    '\n' +
    'TODO: write the skill instructions here.\n'
  );
}
