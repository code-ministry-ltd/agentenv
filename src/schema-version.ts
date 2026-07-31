/**
 * A schema version parsed into its `{major, minor}` parts.
 *
 * Shared by env.yaml ({@link import('./env-config.js')}) and state.json
 * ({@link import('./state.js')}), which both tolerate version skew the same way
 * (design D4): unknown fields and a newer MINOR load; a newer MAJOR is refused.
 */
export interface ParsedVersion {
  major: number;
  minor: number;
}

/** Parse `M` or `M.N` (already trimmed) into parts, or null if it doesn't match. */
function parseVersionString(text: string): ParsedVersion | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  return { major: Number(match[1]), minor: match[2] ? Number(match[2]) : 0 };
}

/**
 * Parse a schema version into `{major, minor}`, or return null if it is neither
 * a finite number nor an `M`/`M.N` string.
 *
 * A numeric version is parsed via its **string form** (`String(raw)`), not by
 * arithmetic, so a minor ≥ 10 survives: `1.15` → minor 15 (the old
 * `Math.round((raw - major) * 10)` produced 2). Note a numeric literal cannot
 * distinguish `1.10` from `1.1` — both are the IEEE-754 value `1.1`, so `1.10`
 * parses to minor 1; authored files quote the version (`"1.10"` → minor 10) to
 * avoid this lossy path.
 *
 * `major < 1` is returned as-is (e.g. `0.9` → `{0, 9}`); callers reject it, since
 * they own the "…newer than CLI — upgrade agentenv" vs "invalid version" wording.
 */
export function parseVersion(raw: unknown): ParsedVersion | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return parseVersionString(String(raw));
  }
  if (typeof raw === 'string') {
    return parseVersionString(raw.trim());
  }
  return null;
}
