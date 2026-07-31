import type { Paths } from '../paths.js';
import { environmentExists, validateEnvName } from '../store.js';

/**
 * Shared helpers for the activation commands (`use` / `drop`), which come in a
 * session flavour (bind/unbind a shell, no real files touched) and a `--global`
 * flavour (the transactional real-path engine). Both parse the same
 * `--harness <h>…` scoping and validate env names the same way.
 */

/** Parse a `--harness a,b` value into a trimmed, de-duplicated list (or undefined). */
export function parseHarnesses(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const list = raw
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  return list.length > 0 ? list : undefined;
}

/** The outcome of validating a list of requested env names against the store. */
export interface ValidatedEnvs {
  /** Env names that are well-formed AND exist in the store, in request order. */
  kept: string[];
  /** Warnings for names that were invalid or missing (skip-and-warn, D16-ish). */
  warnings: string[];
}

/**
 * Validate requested env names: a malformed or non-existent name is warned about
 * and skipped (never fatal on its own), so `use writing ghost` still binds
 * `writing`. The caller decides what to do when nothing survives.
 */
export async function validateEnvs(paths: Paths, names: readonly string[]): Promise<ValidatedEnvs> {
  const kept: string[] = [];
  const warnings: string[] = [];
  for (const name of names) {
    const nameError = validateEnvName(name);
    if (nameError) {
      warnings.push(`agentenv: skipping ${nameError}`);
      continue;
    }
    if (!(await environmentExists(paths, name))) {
      warnings.push(`agentenv: skipping unknown environment '${name}'`);
      continue;
    }
    if (!kept.includes(name)) kept.push(name);
  }
  return { kept, warnings };
}
