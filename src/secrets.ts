import { chmod, readFile } from 'node:fs/promises';
import type { JsonValue } from './config-keys.js';
import { writeFileAtomic } from './fs-atomic.js';
import type { Paths } from './paths.js';

/**
 * The machine-local secrets model (spec criterion 7, design D6). Central guarantee:
 * **no secret value ever reaches the synced store.** Secret values live only in
 * `~/.agentenv/secrets.env` ({@link Paths.secrets}, never synced) or the shell
 * environment; the store holds `${VAR}` placeholders. This module:
 *
 * - parses `secrets.env` (dotenv-ish `KEY=value`, with comments, quoting, blanks);
 * - resolves a `${VAR}` name → secrets.env first, then the shell environment;
 * - substitutes placeholders into a compiled config value at **materialisation**
 *   time for the *substitute* rung (harnesses that cannot interpolate `${VAR}`
 *   themselves), reporting any name that resolved to nothing.
 *
 * It never writes into the store and never logs a resolved value. Write-back always
 * restores the placeholder (that half lives in `config-keys.ts`); substitution here
 * only feeds the REAL config file at write time.
 */

/** Match a `${VAR}` placeholder; the capture is the (untrimmed) variable name. */
const PLACEHOLDER_RE = /\$\{([^}]+)\}/g;

/** A valid `KEY` on the left of a `secrets.env` assignment. */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Resolve a `${VAR}` name to a value: `secrets.env` wins, then the shell env
 * (D6). `resolve` returns `undefined` when neither source carries the name — the
 * signal the caller uses to fail closed *per server* (warn + skip, never leak an
 * empty literal).
 */
export interface SecretResolver {
  resolve(name: string): string | undefined;
}

/**
 * Parse `secrets.env` text into a `KEY → value` map. Format (dotenv-ish, kept
 * deliberately small):
 *
 * - blank lines and `#`-prefixed comment lines are ignored;
 * - `KEY=value`, optionally `export KEY=value`; whitespace around `=` is trimmed;
 * - a value in single quotes is taken literally; in double quotes, the usual
 *   `\n \r \t \" \\` escapes are decoded; an unquoted value has a trailing
 *   ` # comment` stripped;
 * - an invalid key (not `[A-Za-z_][A-Za-z0-9_]*`) or a line with no `=` is skipped;
 * - a later assignment to the same key wins.
 *
 * Pure — it never touches disk; {@link loadSecrets} reads the file and calls this.
 */
export function parseSecretsEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const body = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trimStart() : trimmed;
    const eq = body.indexOf('=');
    if (eq === -1) continue;
    const key = body.slice(0, eq).trim();
    if (!KEY_RE.test(key)) continue;
    out.set(key, unquoteValue(body.slice(eq + 1).trim()));
  }
  return out;
}

/** Decode one `secrets.env` value: single-quote literal, double-quote escapes, or bare. */
function unquoteValue(v: string): string {
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1);
  }
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\([nrt"\\])/g, (_, c: string) => {
      switch (c) {
        case 'n':
          return '\n';
        case 'r':
          return '\r';
        case 't':
          return '\t';
        default:
          return c; // `"` or `\`
      }
    });
  }
  // Unquoted: strip a trailing ` # comment` (whitespace before the hash).
  const comment = v.search(/\s#/);
  return comment === -1 ? v : v.slice(0, comment).trimEnd();
}

/** Read `secrets.env`, treating a missing file as empty (secrets are optional). */
async function readSecretsFile(paths: Paths): Promise<string> {
  try {
    return await readFile(paths.secrets, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

/** Load `secrets.env` into a `KEY → value` map (empty when the file is absent). */
export async function loadSecrets(paths: Paths): Promise<Map<string, string>> {
  return parseSecretsEnv(await readSecretsFile(paths));
}

/**
 * Build a resolver over a secrets map + shell env: `secrets.env` first, then the
 * environment (D6). Pure over its inputs, so it is trivially testable.
 */
export function makeResolver(secrets: Map<string, string>, env: NodeJS.ProcessEnv): SecretResolver {
  return {
    resolve(name: string): string | undefined {
      if (secrets.has(name)) return secrets.get(name);
      return env[name];
    },
  };
}

/** Load `secrets.env` and return a resolver layered over the shell env (D6). */
export async function loadResolver(paths: Paths, env: NodeJS.ProcessEnv): Promise<SecretResolver> {
  return makeResolver(await loadSecrets(paths), env);
}

/** Outcome of substituting `${VAR}` placeholders in one string. */
export interface SubstituteStringResult {
  /** The string with every RESOLVED placeholder replaced by its value. */
  text: string;
  /** Variable names that resolved to nothing (still present verbatim in `text`). */
  unresolved: string[];
}

/**
 * Replace every `${VAR}` in `input` with its resolved value. An unresolved name
 * is left verbatim and reported in {@link SubstituteStringResult.unresolved}, so
 * the caller can fail closed rather than write an empty or placeholder-looking
 * literal into the real config.
 */
export function substituteString(
  input: string,
  resolve: (name: string) => string | undefined,
): SubstituteStringResult {
  const unresolved: string[] = [];
  const text = input.replace(PLACEHOLDER_RE, (whole, rawName: string) => {
    const name = rawName.trim();
    const value = resolve(name);
    if (value === undefined) {
      if (!unresolved.includes(name)) unresolved.push(name);
      return whole; // keep the placeholder; caller decides to skip
    }
    return value;
  });
  return { text, unresolved };
}

/** Outcome of substituting the secret-flagged subfields of a config value. */
export interface SubstituteFieldsResult {
  /** A deep clone with each flagged subfield's placeholders resolved to literals. */
  value: JsonValue;
  /** Every variable name that resolved to nothing across all flagged subfields. */
  unresolved: string[];
}

/**
 * Resolve the `${VAR}` placeholders inside the secret-flagged subfields of a
 * compiled config value — the *substitute* rung (D6, rung 3). `secretFields` maps
 * a dot-joined subpath (e.g. `env.TOKEN`, `headers.Authorization`, or a top-level
 * `url`) to the placeholder text that originally sat there; this walks each, reads
 * the string currently there, and substitutes its placeholders.
 *
 * Only flagged subfields are touched, so substitution is exactly coupled to what
 * the manifest records as a secret — the write-back side ({@link import(
 * './config-keys.js').syncBack}) restores those same subfields to their placeholders,
 * so nothing substituted here can ever be carried into the store as a literal.
 *
 * The subpath split is naive on `.` — symmetric with the `${prefix}.${k}` keys the
 * adapters produce (`collectPlaceholders`). A subpath that no longer resolves to a
 * string is skipped (best-effort), never an error.
 */
export function substituteSecretFields(
  value: JsonValue,
  secretFields: Record<string, string>,
  resolve: (name: string) => string | undefined,
): SubstituteFieldsResult {
  const clone = structuredClone(value);
  const unresolved: string[] = [];
  for (const dotted of Object.keys(secretFields)) {
    const segments = dotted.split('.');
    const current = getStringAt(clone, segments);
    if (current === undefined) continue; // subfield gone/non-string — best-effort
    const res = substituteString(current, resolve);
    for (const name of res.unresolved) {
      if (!unresolved.includes(name)) unresolved.push(name);
    }
    setStringAt(clone, segments, res.text);
  }
  return { value: clone, unresolved };
}

/**
 * Resolve a path segment to a valid ARRAY index, or `undefined` when `cur` is not an
 * array or the segment is not an in-bounds non-negative integer. Lets navigation
 * descend into an array-nested placeholder (canonical MCP `args.<i>`) so both
 * substitution here and restoration in `config-keys.ts` reach an array element.
 */
function arrayIndexSegment(cur: JsonValue, seg: string): number | undefined {
  if (!Array.isArray(cur) || !/^\d+$/.test(seg)) return undefined;
  const idx = Number(seg);
  return idx < cur.length ? idx : undefined;
}

/** Step one segment into `cur`, through an object key OR an array index; else `undefined`. */
function stepInto(cur: JsonValue, seg: string): JsonValue | undefined {
  const idx = arrayIndexSegment(cur, seg);
  if (idx !== undefined) return (cur as JsonValue[])[idx] as JsonValue;
  if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
  return (cur as { [k: string]: JsonValue })[seg] as JsonValue;
}

/** Read the string at a dot-path within a JSON value; `undefined` if absent/non-string. */
function getStringAt(root: JsonValue, path: string[]): string | undefined {
  let cur: JsonValue = root;
  for (const seg of path) {
    const next = stepInto(cur, seg);
    if (next === undefined) return undefined;
    cur = next;
  }
  return typeof cur === 'string' ? cur : undefined;
}

/** Set the string leaf at a dot-path within a JSON value; a missing segment is a no-op. */
function setStringAt(root: JsonValue, path: string[], leaf: string): void {
  let cur: JsonValue = root;
  for (let i = 0; i < path.length - 1; i++) {
    const next = stepInto(cur, path[i] as string);
    if (next === undefined) return;
    cur = next;
  }
  const last = path[path.length - 1] as string;
  const idx = arrayIndexSegment(cur, last);
  if (idx !== undefined) {
    (cur as JsonValue[])[idx] = leaf;
    return;
  }
  if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return;
  (cur as { [k: string]: JsonValue })[last] = leaf;
}

/**
 * Mask a secret value for display (`secret list`) so `list` never prints a value
 * (spec criterion 7). Shows only the length as a run of `•`, capped, so neither
 * the value nor its exact length leaks for a long token.
 */
export function maskSecret(value: string): string {
  if (value === '') return '(empty)';
  const dots = Math.min(value.length, 8);
  return '•'.repeat(dots);
}

/** Serialise a `KEY → value` map back to `secrets.env` text (values quoted when needed). */
export function serializeSecretsEnv(secrets: Map<string, string>): string {
  const lines: string[] = [];
  for (const [key, value] of secrets) {
    lines.push(`${key}=${quoteValue(value)}`);
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/** Quote a value for writing iff it would not round-trip bare through {@link parseSecretsEnv}. */
function quoteValue(value: string): string {
  const needsQuote =
    value === '' ||
    value !== value.trim() ||
    /[\n\r\t"'#\\]/.test(value) ||
    value.includes(' ');
  if (!needsQuote) return value;
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

/**
 * Write a `KEY → value` map to `secrets.env` atomically, then tighten the file to
 * owner-only (`0600`) — it holds real secret values and is machine-local, never
 * synced. Best-effort `chmod` (skipped where the platform cannot).
 */
export async function writeSecrets(paths: Paths, secrets: Map<string, string>): Promise<void> {
  await writeFileAtomic(paths.secrets, serializeSecretsEnv(secrets));
  try {
    await chmod(paths.secrets, 0o600);
  } catch {
    // chmod unsupported (e.g. some Windows filesystems) — acceptable.
  }
}
