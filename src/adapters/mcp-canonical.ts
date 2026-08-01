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
 *   3. `transport` propagates when the harness expresses the distinction NATIVELY and is
 *      preserved from the prior def only where the harness shape is genuinely lossy (see
 *      {@link TransportAuthority});
 *   4. only the keys a branch genuinely EMITS ({@link UnshapedServer.supersedes}) are
 *      deleted when the harness value no longer expresses them — that is how a user
 *      DELETING a field in the harness still propagates, without the remote branch
 *      claiming authority over `command`/`env` it never wrote.
 *
 * **The overriding rule (F6): where a drift is genuinely AMBIGUOUS, agentenv does not
 * infer.** It leaves the canonical field unchanged and surfaces a warning naming the
 * server and the field. A warning the user can act on beats a clever guess that silently
 * changes what a credential or an endpoint does.
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

/**
 * How much authority the drifted harness value has over canonical `transport`:
 *
 * - `native` — the harness records the distinction ITSELF and the user authored it
 *   (Claude/Cursor `type: 'sse'|'http'`; any `command`-shaped entry, since `stdio` is
 *   unambiguous). It PROPAGATES: preserving the prior value here would silently rewrite
 *   the user's own edit back on the next `use` (F6/1).
 * - `inferred` — the harness shape is genuinely non-injective (OpenCode's `type:'remote'`
 *   and Codex's bare `url` table each map from BOTH `http` and `sse`), so the value in
 *   `fields.transport` is a GUESS. The prior canonical transport wins while the entry
 *   stays in the same family; only a family change (or no prior at all) writes the guess.
 * - `verbatim` — the value already carried a canonical `transport` (the shaper's bespoke
 *   passthrough emitted it), so it IS the user's current value.
 * - `ambiguous` — the harness value carries CONTRADICTORY discriminators. Never write a
 *   transport from it: keep the prior one (or none) and warn.
 */
export type TransportAuthority = 'native' | 'inferred' | 'verbatim' | 'ambiguous';

/** The canonical keys that belong to ONE transport family and go with it when it changes. */
const FAMILY_KEYS: Readonly<Record<'stdio' | 'remote', readonly string[]>> = {
  stdio: ['command', 'args', 'env'],
  remote: ['url', 'headers', 'auth'],
};

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

/**
 * The prior canonical def's effective transport: its explicit `transport`, else a
 * hand-authored `type` that names a canonical transport (a servers.yaml a user wrote in
 * harness shape — every shaper honours `type` as the transport hint, so the write-back
 * must read it the same way rather than treating the entry as transport-less).
 */
export function priorTransport(prior: Record<string, JsonValue>): string | undefined {
  if (typeof prior.transport === 'string') return prior.transport;
  if (prior.type === 'stdio' || prior.type === 'http' || prior.type === 'sse') return prior.type;
  return undefined;
}

/** The prior canonical def's family, inferred from its shape when it names no transport. */
export function priorFamily(prior: Record<string, JsonValue>): TransportFamily | undefined {
  const t = priorTransport(prior);
  if (t !== undefined) return transportFamily(t);
  if (prior.command !== undefined) return 'stdio';
  if (prior.url !== undefined) return 'remote';
  return undefined;
}

/** One harness value translated towards canonical, ready to overlay onto the prior def. */
export interface UnshapedServer {
  /**
   * Canonical (D6) fields the harness value expresses — INCLUDING every field the
   * un-shape does not recognise, carried over verbatim (there is no whitelist).
   */
  fields: Record<string, JsonValue>;
  /**
   * The prior-canonical keys THIS BRANCH emits and is therefore authoritative for. A key
   * listed here and ABSENT from {@link fields} was deleted by the user in the harness
   * config, so it is deleted from canonical too. Everything NOT listed survives from the
   * prior def — so a remote branch must NOT list `command`/`args`/`env` (it never writes
   * them, so their absence says nothing), and a stdio branch must not list `url`/`headers`
   * (F6/6). A genuine FAMILY change is handled separately by {@link FAMILY_KEYS}.
   */
  supersedes: readonly string[];
  /** The family the harness value expresses (drives the family-change key sweep). */
  family: TransportFamily;
  /** How far {@link fields}.transport may be trusted — see {@link TransportAuthority}. */
  transportAuthority: TransportAuthority;
}

/**
 * The identity un-shape: the harness value IS already canonical-shaped. Every shaper
 * passes a bespoke/unknown transport through untouched, so a harness value that still
 * carries a canonical `transport` came from that passthrough — re-inferring it would
 * destroy the user's authored transport (F1).
 *
 * The passthrough shaper emits the def VERBATIM, so it saw (and wrote) every canonical
 * field: a prior key missing from the harness value really was deleted by the user, and
 * `supersedes` says so — every prior key (F6/5). Round 2's empty list meant NO deletion
 * ever propagated for a bespoke entry, contradicting the guarantee it claimed.
 */
export function passthroughUnshape(
  def: Record<string, JsonValue>,
  prior: unknown,
): UnshapedServer {
  return {
    fields: { ...def },
    supersedes: isJsonObject(prior) ? Object.keys(prior) : [],
    family: transportFamily(def.transport),
    transportAuthority: 'verbatim',
  };
}

/**
 * Overlay one un-shaped harness value onto the PRIOR canonical def (see the module
 * header). `prior` is the def currently in `servers.yaml`; anything other than an
 * object (or absent) means there is no prior def and the un-shaped fields stand alone.
 */
export function overlayCanonicalServer(prior: unknown, unshaped: UnshapedServer): JsonValue {
  const priorObj = isJsonObject(prior) ? prior : undefined;
  const out: Record<string, JsonValue> = priorObj ? { ...priorObj } : {};

  // A genuine FAMILY change takes the departed family's exclusive keys with it: a server
  // that is now remote has no `command`, and one that is now stdio has no `url`/`auth`.
  // (Within one family this must NOT happen — see UnshapedServer.supersedes.)
  const from = priorObj ? priorFamily(priorObj) : undefined;
  if (from !== undefined && from !== 'bespoke' && from !== unshaped.family) {
    for (const key of FAMILY_KEYS[from]) delete out[key];
  }

  for (const key of unshaped.supersedes) {
    if (!(key in unshaped.fields)) delete out[key];
  }
  Object.assign(out, unshaped.fields);

  if (unshaped.transportAuthority === 'inferred') {
    // The harness shape cannot tell `http` from `sse`, so `fields.transport` is a guess.
    // While the entry is still in the same family the prior canonical value is the truth.
    const pt = priorObj ? priorTransport(priorObj) : undefined;
    if (pt !== undefined && transportFamily(pt) === unshaped.family) out.transport = pt;
  } else if (unshaped.transportAuthority === 'ambiguous') {
    // Contradictory discriminators: never write one. Keep the prior, else say nothing
    // (the shapers still infer a family from `command`/`url`).
    const pt = priorObj ? priorTransport(priorObj) : undefined;
    if (pt !== undefined) out.transport = pt;
    else delete out.transport;
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
