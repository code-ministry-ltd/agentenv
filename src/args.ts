/** Result of parsing a command's argv (the tokens after the command name). */
export interface ParsedArgs {
  /** Positional (non-flag) arguments, in order. */
  positionals: string[];
  /** Boolean flags that were present, e.g. `--yes`. */
  booleans: Set<string>;
  /** Value options, e.g. `--from writing` or `--from=writing`. */
  values: Map<string, string>;
  /** Unrecognised `--flags` (the caller decides whether to reject). */
  unknown: string[];
}

export interface ArgSpec {
  /** Long flag names (without `--`) that take no value. */
  booleans?: readonly string[];
  /** Long flag names (without `--`) that take a following value. */
  values?: readonly string[];
}

/**
 * A deliberately tiny argv parser: enough for the store commands (a couple of
 * boolean flags and one value option each) without pulling in a dependency.
 * Supports `--flag`, `--opt value`, `--opt=value`, and `--` as an
 * end-of-options terminator.
 */
export function parseArgs(args: readonly string[], spec: ArgSpec = {}): ParsedArgs {
  const booleans = new Set(spec.booleans ?? []);
  const values = new Set(spec.values ?? []);

  const out: ParsedArgs = {
    positionals: [],
    booleans: new Set(),
    values: new Map(),
    unknown: [],
  };

  let optionsEnded = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (optionsEnded || !arg.startsWith('--')) {
      out.positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      optionsEnded = true;
      continue;
    }

    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);

    if (booleans.has(name)) {
      out.booleans.add(name);
    } else if (values.has(name)) {
      if (inlineValue !== undefined) {
        out.values.set(name, inlineValue);
      } else {
        const next = args[i + 1];
        if (next !== undefined) {
          out.values.set(name, next);
          i++;
        } else {
          out.values.set(name, '');
        }
      }
    } else {
      out.unknown.push(arg);
    }
  }

  return out;
}
