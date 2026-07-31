import type { JsonValue } from '../config-keys.js';

/**
 * Shared machinery for the canonical (D6) `mcp/servers.yaml` ⇄ harness-shape round
 * trip. `servers.yaml` is the ONE canonical source every adapter's
 * `compileConfigKeys` reads, so a drift write-back by one harness must never leave
 * behind a shape — or a gap — that breaks the others (F1).
 *
 * **Why OVERLAY-AND-PRESERVE rather than reconstruction.** The obvious inverse — build
 * a fresh canonical def out of the harness value — is unfixable in principle, because
 * `shape*` is NOT injective: canonical `transport: http` and `transport: sse` both
 * compile to OpenCode's `type:'remote'` and to a bare Codex `url` table, so no true
 * inverse exists. Reconstruction also silently drops every canonical field the shaper
 * does not emit (`timeout`, `enabled`, anything a future release adds) and every field
 * the un-shape whitelist does not know about.
 *
 * So a write-back instead OVERLAYS the changed fields onto the PRIOR canonical def read
 * from `servers.yaml`:
 *
 *   1. the un-shape carries the harness value's fields over VERBATIM (no whitelist), so
 *      a field the user adds in the harness config survives into the store;
 *   2. anything the shaper never emitted is preserved from the prior def, because the
 *      harness value could not possibly have contradicted it;
 *   3. `transport` is preserved verbatim from the prior def whenever the drifted entry
 *      is still in the same transport FAMILY — never re-inferred over a value the user
 *      authored (this is the whole fix for the non-injectivity);
 *   4. only the keys a branch is genuinely authoritative for ({@link UnshapedServer.supersedes})
 *      are deleted when the harness value no longer expresses them — that is how a user
 *      DELETING a field in the harness still propagates.
 *
 * Inference is the fallback for a server with NO prior canonical entry only; there the
 * `http`/`sse` ambiguity is irreducible and resolves to `http` (documented per adapter).
 */

/** Is `v` a plain (non-array) JSON object? */
export function isJsonObject(v: unknown): v is Record<string, JsonValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The transport families every adapter's shaper branches on. */
export type TransportFamily = 'stdio' | 'remote' | 'bespoke';

/** `stdio` → stdio; `http`/`sse` → remote; anything else → bespoke (shaper passthrough). */
export function transportFamily(transport: unknown): TransportFamily {
  if (transport === 'stdio') return 'stdio';
  if (transport === 'http' || transport === 'sse') return 'remote';
  return 'bespoke';
}

/** A copy of `value` without `keys` — the harness-only fields an un-shape translates away. */
export function omitKeys(
  value: Record<string, JsonValue>,
  keys: readonly string[],
): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [key, v] of Object.entries(value)) {
    if (!keys.includes(key)) out[key] = v;
  }
  return out;
}

/** One harness value translated towards canonical, ready to overlay onto the prior def. */
export interface UnshapedServer {
  /**
   * Canonical (D6) fields the harness value expresses — INCLUDING every field the
   * un-shape does not recognise, carried over verbatim (there is no whitelist).
   */
  fields: Record<string, JsonValue>;
  /**
   * The prior-canonical keys this branch is authoritative for. A key listed here and
   * ABSENT from {@link fields} was deleted by the user in the harness config, so it is
   * deleted from canonical too. Everything NOT listed survives from the prior def.
   */
  supersedes: readonly string[];
  /** The family the harness value expresses, used to decide whether `transport` survives. */
  family: TransportFamily;
}

/**
 * The identity un-shape: the harness value IS already canonical-shaped. Every shaper
 * passes a bespoke/unknown transport through untouched, so a harness value that still
 * carries a canonical `transport` came from that passthrough — re-inferring it would
 * destroy the user's authored transport (F1). `supersedes` is empty: a passthrough
 * entry makes no claim about fields it never saw.
 */
export function passthroughUnshape(def: Record<string, JsonValue>): UnshapedServer {
  return { fields: { ...def }, supersedes: [], family: transportFamily(def.transport) };
}

/**
 * Overlay one un-shaped harness value onto the PRIOR canonical def (see the module
 * header). `prior` is the def currently in `servers.yaml`; anything other than an
 * object (or absent) means there is no prior def and the un-shaped fields stand alone.
 */
export function overlayCanonicalServer(prior: unknown, unshaped: UnshapedServer): JsonValue {
  const out: Record<string, JsonValue> = isJsonObject(prior) ? { ...prior } : {};
  for (const key of unshaped.supersedes) {
    if (!(key in unshaped.fields)) delete out[key];
  }
  Object.assign(out, unshaped.fields);
  // `shape*` is not injective on transport, so a re-inferred one would silently rewrite
  // the user's authored value (`sse` → `http`). While the entry is still in the same
  // family, the prior canonical `transport` is authoritative. A `bespoke` family is
  // excluded: there `fields.transport` came from the passthrough itself (the harness
  // value carried it), so it already IS the user's current value.
  if (
    unshaped.family !== 'bespoke' &&
    isJsonObject(prior) &&
    typeof prior.transport === 'string' &&
    transportFamily(prior.transport) === unshaped.family
  ) {
    out.transport = prior.transport;
  }
  return out;
}

/**
 * The whole write-back fold for one drifted server: un-shape `drifted` and overlay it
 * onto `prior`. A non-object drift value (a harness entry the user replaced with a
 * scalar) has nothing to overlay and is written through verbatim.
 */
export function foldDriftIntoCanonical(
  prior: unknown,
  drifted: JsonValue,
  unshape: (def: Record<string, JsonValue>, prior: unknown) => UnshapedServer,
): JsonValue {
  if (!isJsonObject(drifted)) return drifted;
  return overlayCanonicalServer(prior, unshape(drifted, prior));
}
