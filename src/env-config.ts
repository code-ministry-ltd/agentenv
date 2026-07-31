import { parse as parseYaml, stringify as stringifyYaml, YAMLParseError } from 'yaml';

/**
 * The env.yaml schema version this CLI understands, as {major, minor}.
 *
 * Version tolerance (design D4): a store may be shared across two machines
 * running different CLI versions, so skew is a *normal* state, not an edge
 * case. We tolerate unknown fields and a newer MINOR; a newer MAJOR is refused
 * with an upgrade message rather than a cryptic schema error.
 */
export const SCHEMA_VERSION = { major: 1, minor: 0 } as const;
export const SCHEMA_VERSION_STRING = `${SCHEMA_VERSION.major}.${SCHEMA_VERSION.minor}`;

/** Patterns the capture sweep (task 1.9/D10) should ignore for this env. */
export interface EnvCapture {
  ignore?: string[];
}

/**
 * A parsed env.yaml manifest. Known fields are typed; unknown fields are
 * preserved via the index signature so a file written by a newer minor is not
 * lossily rejected. Deliberately carries NO harness allowlist (design: every
 * environment is eligible for every adapter).
 */
export interface EnvConfig {
  version: string;
  description: string;
  notes?: string;
  capture?: EnvCapture;
  [key: string]: unknown;
}

/**
 * A problem with an env.yaml file: malformed YAML, a bad/missing version, or a
 * store newer than this CLI. Always names the file; carries a 1-based line
 * number when the YAML parser located the fault.
 */
export class EnvYamlError extends Error {
  constructor(
    message: string,
    readonly file: string,
    readonly line?: number,
  ) {
    super(message);
    this.name = 'EnvYamlError';
  }
}

interface ParsedVersion {
  major: number;
  minor: number;
}

function parseVersion(raw: unknown): ParsedVersion | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // A YAML number like `1` or `1.5`: the integer part is the major, the
    // first fractional digit the minor. Authored files quote the version to
    // avoid this lossy path; this branch is pure tolerance.
    const major = Math.trunc(raw);
    const minor = Math.round((raw - major) * 10);
    return { major, minor };
  }
  if (typeof raw === 'string') {
    const match = /^(\d+)(?:\.(\d+))?$/.exec(raw.trim());
    if (match) {
      return { major: Number(match[1]), minor: match[2] ? Number(match[2]) : 0 };
    }
  }
  return null;
}

function normaliseVersion(raw: unknown, file: string): string {
  const v = parseVersion(raw);
  // major < 1 is nonsensical for a scheme that starts at 1.0 (e.g. an unquoted
  // `version: -1` parses to major -1); reject it rather than treat it as "older".
  if (!v || v.major < 1) {
    throw new EnvYamlError(
      `${file}: missing or invalid 'version' field (expected e.g. "1.0")`,
      file,
    );
  }
  if (v.major > SCHEMA_VERSION.major) {
    throw new EnvYamlError(
      `${file}: store newer than CLI — upgrade agentenv ` +
        `(env.yaml is v${v.major}.${v.minor}, this agentenv supports up to v${SCHEMA_VERSION.major}.x)`,
      file,
    );
  }
  return `${v.major}.${v.minor}`;
}

function parseCapture(raw: unknown): EnvCapture | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return {};
  const ignoreRaw = (raw as Record<string, unknown>).ignore;
  if (Array.isArray(ignoreRaw)) {
    return { ignore: ignoreRaw.map((p) => String(p)) };
  }
  return {};
}

/**
 * Parse and validate env.yaml text. `file` is used only for error messages.
 * Throws {@link EnvYamlError} on malformed YAML (with a line number), a
 * non-mapping root, a missing/invalid version, or a store newer than this CLI.
 */
export function parseEnvConfig(text: string, file: string): EnvConfig {
  let data: unknown;
  try {
    data = parseYaml(text, { prettyErrors: true });
  } catch (err) {
    if (err instanceof YAMLParseError) {
      const line = err.linePos?.[0]?.line;
      const location = line !== undefined ? `${file}:${line}` : file;
      // err.message already includes a code prefix and a source excerpt; keep
      // the leading human sentence and prepend our file:line location.
      const summary = err.message.split('\n', 1)[0] ?? err.message;
      throw new EnvYamlError(`${location}: ${summary}`, file, line);
    }
    throw err;
  }

  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new EnvYamlError(`${file}: expected a YAML mapping at the top level`, file);
  }

  const obj = data as Record<string, unknown>;
  const version = normaliseVersion(obj.version, file);

  const config: EnvConfig = {
    ...obj,
    version,
    description: typeof obj.description === 'string' ? obj.description : '',
  };
  if (typeof obj.notes === 'string') {
    config.notes = obj.notes;
  } else {
    delete config.notes;
  }
  const capture = parseCapture(obj.capture);
  if (capture) {
    config.capture = capture;
  } else {
    delete config.capture;
  }
  return config;
}

/**
 * Render a fresh env.yaml for `agentenv create`: the current schema version, a
 * (safely escaped) description, and commented hints for the optional fields so
 * a human opening the file understands it. Round-trips through parseEnvConfig.
 */
export function scaffoldEnvYaml(opts: { description: string }): string {
  const header =
    '# agentenv environment manifest.\n' +
    '# Managed by `agentenv`; safe to edit by hand (`agentenv edit <name>`).\n';
  const body = stringifyYaml({
    version: SCHEMA_VERSION_STRING,
    description: opts.description,
  });
  const hints =
    '# notes: free-form notes about this environment\n' +
    '# capture:\n' +
    '#   ignore:            # glob patterns the capture sweep should ignore\n' +
    '#     - "**/*.log"\n';
  return `${header}${body}${hints}`;
}
