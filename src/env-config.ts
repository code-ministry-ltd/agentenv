import { parse as parseYaml, parseDocument, stringify as stringifyYaml, YAMLParseError } from 'yaml';
import { parseVersion } from './schema-version.js';

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
 * Provenance for a skill vendored from a git source (design D17): where it came
 * from and a fingerprint of what was vendored, so any machine sharing the store
 * can answer "where did this come from, and has it drifted?". Recorded per skill
 * name under `env.yaml`'s `sources:` map; content stays vendored and offline.
 */
export interface SkillSourceRecord {
  /** Canonical origin: `owner/repo` for GitHub, or a `file://` URL for a local repo. */
  repo: string;
  /** Subpath within the repo the skill was vendored from (`''` = repo root). */
  path: string;
  /** The requested/resolved ref (branch, tag or sha). */
  ref: string;
  /** The resolved HEAD commit sha at fetch time. */
  commit: string;
  /** Content hash of the vendored skill directory. */
  hash: string;
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
  /** Provenance for git-vendored skills, keyed by skill name (design D17). */
  sources?: Record<string, SkillSourceRecord>;
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
 * Parse the optional `sources:` provenance map (design D17). Tolerant: a
 * non-mapping value or malformed entries are dropped rather than rejected, so a
 * hand-mangled block never blocks reading an otherwise-valid manifest. Fields
 * are coerced to strings; a missing field becomes ''.
 */
function parseSources(raw: unknown): Record<string, SkillSourceRecord> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, SkillSourceRecord> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    const s = (x: unknown): string => (typeof x === 'string' ? x : x === undefined ? '' : String(x));
    out[name] = {
      repo: s(v.repo),
      path: s(v.path),
      ref: s(v.ref),
      commit: s(v.commit),
      hash: s(v.hash),
    };
  }
  return out;
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
  const sources = parseSources(obj.sources);
  if (sources) {
    config.sources = sources;
  } else {
    delete config.sources;
  }
  return config;
}

/**
 * Insert or replace one skill's provenance under `env.yaml`'s `sources:` map,
 * returning the updated YAML text. Edits through the YAML Document API so the
 * file's header comments and hand-written fields are preserved. Round-trips
 * through {@link parseEnvConfig}.
 */
export function upsertEnvSource(text: string, name: string, source: SkillSourceRecord): string {
  const doc = parseDocument(text);
  doc.setIn(['sources', name], {
    repo: source.repo,
    path: source.path,
    ref: source.ref,
    commit: source.commit,
    hash: source.hash,
  });
  return doc.toString();
}

/** Copy one skill's exact provenance AST node into a destination manifest.
 * An absent source node removes stale destination provenance; unrelated nodes
 * retain their document-level presentation.
 */
export function copyEnvSource(
  sourceText: string,
  destinationText: string,
  name: string,
): string {
  const source = parseDocument(sourceText);
  const destination = parseDocument(destinationText);
  const sourceNode = source.getIn(['sources', name], true);
  if (sourceNode && typeof sourceNode === 'object' && 'clone' in sourceNode) {
    destination.setIn(
      ['sources', name],
      (sourceNode as { clone(): unknown }).clone(),
    );
  } else {
    if (!destination.hasIn(['sources', name])) return destinationText;
    destination.deleteIn(['sources', name]);
  }
  return destination.toString();
}

/** Remove only one skill's provenance node while retaining the surrounding
 * YAML document's comments, node styles, and ordering. */
export function removeEnvSource(text: string, name: string): string {
  const document = parseDocument(text);
  if (!document.hasIn(['sources', name])) return text;
  document.deleteIn(['sources', name]);
  return document.toString();
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
