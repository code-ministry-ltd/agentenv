import type { JsonValue } from './config-keys.js';
import type { AdapterV2 } from './adapter-v2.js';

/**
 * The adapter contract — FROZEN at the end of Phase 1.
 *
 * An adapter is "a declaration of surfaces plus format quirks" (design §"The
 * shape of the problem") together with the harness's config-root override and a
 * two-bucket classification of what lives under that root (D15). The engine
 * implements the three surface mechanisms once (dir-merge / file-block /
 * config-keys); supporting a new harness is a small adapter that *declares* how
 * its surfaces map onto them.
 *
 * This module defines only DATA and PURE-ish METHODS — no engine logic. Task 1.8
 * (Claude) and the four Phase-4 adapters (Codex / OpenCode / Pi / Cursor)
 * implement {@link Adapter}; the {@link import('./testing') fixture adapter}
 * exercises the whole session machinery with no real harness installed.
 *
 * Everything here is designed to cover all five v1 harnesses without change:
 *
 * | Harness | session | skills          | instructions              | MCP                         |
 * |---------|---------|-----------------|---------------------------|-----------------------------|
 * | Claude  | yes     | dir-merge skills| dir-merge rules/ (D2)     | config-keys .claude.json    |
 * | Codex   | yes     | dir-merge skills| file-block AGENTS.md      | config-keys config.toml     |
 * | OpenCode| yes     | dir-merge agents| config-keys instructions[]| config-keys opencode.json   |
 * | Pi      | yes     | dir-merge skills| file-block AGENTS.md      | UNSUPPORTED (no native MCP) |
 * | Cursor  | NO      | (global only)   | (global only)             | (global only)               |
 */

/**
 * The mechanism a managed surface is composed with — the three surface types
 * from the design's central table. The composer dispatches on this.
 */
export type SurfaceMechanism = 'dir-merge' | 'file-block' | 'config-keys';

/**
 * Which store content a surface draws from — one of the store's content
 * subdirectories (design "Store layout"). Lets the composer find the env content
 * that feeds each surface (`environments/<env>/<storeKind>/…`).
 */
export type StoreKind = 'skills' | 'instructions' | 'mcp' | 'agents' | 'commands' | 'files';

/** file-block layering mode (D2): an import line vs inlined content. */
export type FileBlockLayering = 'import' | 'inline';

/** config-keys ownership style (D3): an object key vs a value in an array. */
export type ConfigKeysStyle = 'keyed' | 'array-element';

/** The on-disk format of a config-keys file, so the composer parses it right. */
export type ConfigFormat = 'json' | 'jsonc' | 'toml';

/**
 * The two-bucket classification of a single entry in the REAL config root (D15):
 * - `state`   — bucket 1: credentials/auth, session history, caches, trust
 *               records, plugin installs. Pass-through by per-entry symlink so
 *               reads AND writes reach the real location. **Unknown entries
 *               default here** — pass-through is the safe unknown.
 * - `managed` — bucket 2: a surface agentenv composes privately (skills dir,
 *               instruction file, MCP/config file). Never a wholesale symlink.
 */
export type EntryBucket = 'state' | 'managed';

/** Fields common to every surface declaration. */
export interface SurfaceBase {
  /** Stable surface id within the adapter, e.g. `skills` | `instructions` | `mcp`. */
  id: string;
  /** Which store content subdirectory feeds this surface. */
  storeKind: StoreKind;
  /**
   * Whether this harness supports the surface at all. `false` marks it
   * unsupported (Pi has no native MCP) so `status` reports it per harness rather
   * than pretending (D6); an unsupported surface is skipped by the composer.
   */
  supported: boolean;
  /** Human explanation shown by `status` when {@link supported} is `false`. */
  unsupportedReason?: string;
}

/**
 * A dir-merge surface (D1): skills / agents / commands, placed as one symlink
 * (or copy) per item beside the user's own items inside the config root.
 */
export interface DirMergeSurface extends SurfaceBase {
  mechanism: 'dir-merge';
  /**
   * Path INSIDE the config root where per-item links live, e.g. `skills` or
   * `rules`. Env items go in the harness's **in-root** dir, never the shared
   * `~/.agents/skills/` (that dir is `$HOME`-derived — writing it would leak the
   * env into every session, D15).
   */
  rootRelativePath: string;
  /**
   * Placement mechanism (D1). `symlink` (default) writes through to the store;
   * `copy` is the write-back fallback where symlink-following is unverified
   * (Windows, OpenCode skills).
   */
  mode?: 'symlink' | 'copy';
  /** Optional physical layout transform for command markdown exposed as skills. */
  layout?: 'command-skill';
}

/**
 * A file-block surface (D2): an instruction file (CLAUDE.md / AGENTS.md) whose
 * managed region layers the user's content and the env's.
 */
export interface FileBlockSurface extends SurfaceBase {
  mechanism: 'file-block';
  /** The instruction file inside the config root, e.g. `AGENTS.md`. */
  rootRelativePath: string;
  /** `import` (harness has `@path` includes) vs `inline` (content embedded). */
  layering: FileBlockLayering;
}

/**
 * A config-keys surface (D3): keys injected into a structured config file
 * (`.claude.json`, `config.toml`, `opencode.json`) at a recorded key path.
 */
export interface ConfigKeysSurface extends SurfaceBase {
  mechanism: 'config-keys';
  /** The config file inside the config root, e.g. `.claude.json`. */
  rootRelativePath: string;
  /** On-disk format, so the composer picks JSON-surgical vs TOML. */
  format: ConfigFormat;
  /** Keyed (object) vs array-element ownership (D3). */
  style: ConfigKeysStyle;
  /**
   * The owned key path: the object key for keyed mode (e.g. `['mcpServers']`) or
   * the array's path for array-element mode (e.g. `['instructions']`).
   */
  keyPath: readonly (string | number)[];
  /**
   * OPTIONAL rung selector for `${VAR}` placeholders in this surface's values (D6,
   * added Task 2.4 — freeze-relevant). The frozen contract flags placeholder-origin
   * fields (`ConfigKeysInjection.secretFields`) but did NOT express whether the
   * harness interpolates `${VAR}` itself. This closes that gap:
   *
   * - **absent / `false` → passthrough (rung 1, the safe default)**: the compiled
   *   `${VAR}` is written to the REAL config verbatim and the harness interpolates
   *   it (Claude `${VAR}`, OpenCode `{env:VAR}`, Cursor `${env:VAR}`). No secret
   *   value ever leaves `secrets.env`/the shell. Defaulting here is deliberate: an
   *   adapter that forgets the flag leaks NOTHING — at worst a harness that cannot
   *   interpolate sees a literal `${VAR}` (visibly broken), never a leaked secret.
   * - **`true` → literal substitution (rung 3)**: the harness cannot interpolate
   *   `${VAR}` in this config file, so at materialisation the engine/composer resolve
   *   each `secretFields` placeholder from `secrets.env`/the shell and write the
   *   LITERAL into the real config. The manifest still records the placeholder, so the
   *   drift sweep restores `${VAR}` before classifying and never sees the literal.
   *
   * Native indirection (rung 2, e.g. Codex `env_vars`) needs no flag: the adapter
   * compiles the placeholder away in {@link Adapter.compileConfigKeys}, so no `${VAR}`
   * — and no `secretFields` entry — reaches materialisation. The rung is therefore
   * per-surface here, since any placeholder still present shares the surface's rung.
   * An unresolved `${VAR}` on a `true` surface fails closed PER SERVER (warn + skip),
   * never writing an empty or placeholder-looking literal.
   */
  substitutePlaceholders?: boolean;
}

/** A managed surface a harness exposes, discriminated by {@link SurfaceMechanism}. */
export type SurfaceDeclaration = DirMergeSurface | FileBlockSurface | ConfigKeysSurface;

/**
 * One value the adapter wants injected into a config-keys surface, produced by
 * {@link Adapter.compileConfigKeys} from the env's store content. Discriminated
 * to match the two config-keys ownership styles (D3).
 */
export type ConfigKeysInjection =
  | {
      style: 'keyed';
      /** The key path to inject at, e.g. `['mcpServers', 'linear']`. */
      keyPath: readonly (string | number)[];
      /** The value to inject. */
      value: JsonValue;
      /**
       * Subpaths within `value` that carried a `${VAR}` placeholder → the
       * placeholder text, so the drift sweep restores the placeholder before
       * classifying and never handles a baked literal (D6).
       */
      secretFields?: Record<string, string>;
    }
  | {
      style: 'array-element';
      /** The array's path, e.g. `['instructions']`. */
      arrayPath: readonly (string | number)[];
      /** The exact value to add; later removal matches by it (order-independent). */
      value: JsonValue;
    };

/**
 * The inverse of one {@link ConfigKeysInjection}: a config-keys value that DRIFTED
 * in the real file, handed to {@link Adapter.describeConfigKeysDrift} so the adapter
 * can say how it disagrees with the env's canonical store. Carries the
 * placeholder-restored value — secret `${VAR}` subfields already reset, never a
 * baked literal (D6).
 */
export interface ConfigKeysDrift {
  /** Keyed (object property) vs array-element ownership — matches the injection style. */
  style: ConfigKeysStyle;
  /** The owned key path (keyed) or the array's path (array-element), as recorded. */
  keyPath: readonly (string | number)[];
  /**
   * The canonical value now in the real file, with every secret-flagged subfield
   * restored to its `${VAR}` placeholder (D6) — exactly the {@link import(
   * './config-keys.js').SyncBackResult}'s `canonicalValue`.
   */
  canonicalValue: JsonValue;
}

/** How one canonical field differs between a harness config and the canonical store. */
export type ConfigKeysDriftKind = 'added' | 'removed' | 'changed';

/**
 * ONE canonical field that differs, named but NEVER valued.
 *
 * The absence of a value slot is the security property, not a convention: a harness
 * config legitimately holds resolved credentials (a `substitutePlaceholders` surface
 * writes literals there by design, and a user may paste a token into any field), so a
 * report that could carry a value would eventually carry a secret to stderr, a CI log
 * or a scrollback buffer. Field NAMES, env-var names, paths and server names are enough
 * to point the user at the exact line to reconcile, and none of them can be a secret.
 */
export interface ConfigKeysDriftChange {
  /**
   * The dotted canonical field path inside the entry (`args`, `env.TOKEN`,
   * `auth.bearer_env`), or `''` for the entry as a whole.
   */
  field: string;
  kind: ConfigKeysDriftKind;
  /**
   * Why agentenv cannot state this difference precisely — a lossy harness shape,
   * contradictory discriminators, a shadowed bearer. Prose plus field/server/harness
   * names only; NEVER a value.
   */
  note?: string;
}

/**
 * How one drifted config-keys entry disagrees with the env's canonical store — what
 * {@link Adapter.describeConfigKeysDrift} returns.
 *
 * This type is the STRUCTURAL half of the v1 "detect and report, never write" contract:
 * it carries no file content and no writable path, so the drift sweep has nothing it
 * could write even if it wanted to. Reinstating automatic write-back would mean
 * reopening the frozen adapter contract, not just changing a call site.
 */
export interface ConfigKeysDriftReport {
  /** The entry the difference concerns — for an MCP surface, the server name. */
  entry: string;
  /**
   * The canonical store file the user edits to make the change permanent, relative to
   * the env's content dir (`environments/<env>/`), e.g. `mcp/servers.yaml`. A LOCATION
   * to name in the report — never a write target.
   */
  storeRelativePath: string;
  /** The canonical fields that differ. Empty means canonical is unaffected. */
  changes: ConfigKeysDriftChange[];
}

/** One retained config-key entry presented to an adapter for strict inversion. */
export interface ConfigKeysReverseDrift {
  style: ConfigKeysStyle;
  keyPath: readonly (string | number)[];
  removed: boolean;
  /** Present when the retained key still exists, with secret placeholders restored. */
  canonicalValue?: JsonValue;
}

/** A writable result exists only when the adapter proves the inversion lossless. */
export type ConfigKeysReverseResult =
  | {
      kind: 'lossless';
      entry: string;
      storeRelativePath: string;
      /** Undefined means remove this exact canonical entry. */
      value?: JsonValue;
    }
  | { kind: 'ambiguous' | 'invalid'; reason: string };

/** The set of environment variables that point a harness at a private root. */
export type OverrideEnv = Record<string, string>;

/**
 * What {@link Adapter.compileConfigKeys} may read when compiling store content
 * into config-keys injections. Carries the env's content dir AND the launch's
 * project root, so an adapter whose config is keyed by the project path (Codex's
 * `[projects."<projectRoot>"] trust_level="trusted"`, which only merges project
 * config when present) can emit a project-path-keyed injection (H3).
 */
export interface ConfigKeysContext {
  /** `environments/<env>/` — the adapter reads the relevant subdir under it. */
  envContentDir: string;
  /**
   * The launch's project root (the harness's cwd), or `null` when there is no
   * project context (e.g. a probe). An adapter keys project-scoped config by it.
   */
  projectRoot: string | null;
  /**
   * OPTIONAL user-visible warning channel. A compile that refuses to emit something
   * unsafe (a SHADOWED bearer) says so here, naming the server and the field (F6).
   * Absent, the adapter falls back to `console.warn`, so a warning is never silently
   * swallowed. Drift REPORTS do not travel this channel — they are returned as data
   * from {@link Adapter.describeConfigKeysDrift} and rendered by the caller.
   */
  onWarn?: (message: string) => void;
}

/** Outcome of an adapter's launch self-check (D15 fail-closed probe). */
export interface SelfCheckResult {
  /** Whether the child provably observes the intended root. */
  ok: boolean;
  /** Human detail for the one-line notice when `ok` is `false`. */
  detail?: string;
}

/**
 * What an adapter's {@link Adapter.selfCheck} probe may use. Kept minimal and
 * injectable so the probe is testable with no real harness (the fixture spawns
 * its fake harness through {@link capture}).
 */
export interface SelfCheckContext {
  /**
   * Resolve the real harness binary from a PATH with agentenv's shim dirs
   * removed (so a probe never re-enters the shim). `null` when not installed.
   */
  resolveBinary(): Promise<string | null>;
  /**
   * Spawn a binary and capture its output. The real implementation spawns; tests
   * inject a fake so the probe runs without a real harness.
   */
  capture(
    binaryPath: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ): Promise<{ code: number | null; stdout: string; stderr: string }>;
  /** The base environment the launch will exec under (before overrides). */
  env: NodeJS.ProcessEnv;
}

/**
 * The frozen adapter contract. An adapter declares identity, how to point the
 * harness at a private root, its managed surfaces, a two-bucket classification,
 * how to compile store content into config-keys values, and a self-check probe.
 *
 * Methods are `async` where a real adapter needs I/O (detect probes the machine;
 * compile reads the store; selfCheck spawns the child). Declarative fields carry
 * everything the composer needs without a method call.
 */
export interface Adapter {
  /** Adapter-v2 declaration used by the new graph/launch paths during migration. */
  definition?: AdapterV2;

  // — identity —

  /** Stable identity, e.g. `claude-code`. Used in manifests, logs and `status`. */
  id: string;
  /** The shim'd command / the harness token after `--`, e.g. `claude`. */
  binaryName: string;
  /** Additional command names that resolve to this adapter (rare). */
  aliases?: readonly string[];
  /**
   * The `<harness>` token for per-harness store files (`instructions/<token>.md`,
   * `agents/<token>/…`, `files/<token>/…`). Defaults to {@link id} when unset.
   */
  storeToken?: string;

  // — session support —

  /**
   * Whether this harness can be session-activated at all. `false` for GUI apps
   * that do not inherit a shell environment (Cursor): the shim launches them with
   * NO overrides plus a one-line `--global` notice (D11/D15).
   */
  sessionSupported: boolean;
  /** Note shown by the shim/`status` when {@link sessionSupported} is `false`. */
  sessionUnsupportedReason?: string;

  // — detection —

  /** Is this harness installed on this machine? Never throws; resolves a boolean. */
  detect(env: NodeJS.ProcessEnv): Promise<boolean>;

  // — config-root override —

  /**
   * The env var that relocates the harness's config root, e.g. `CLAUDE_CONFIG_DIR`
   * (Claude), `CODEX_HOME` (Codex), `OPENCODE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`.
   * Exposed as data so callers can reason about it without invoking the adapter.
   */
  configRootEnv: string;
  /**
   * The full set of env vars to set so the harness reads `root`. Usually
   * `{ [configRootEnv]: root }`, but a harness needing several related vars
   * returns them all here.
   */
  overrideEnv(root: string): OverrideEnv;
  /**
   * Where the harness reads config absent any agentenv override — the source the
   * view is composed FROM. Reads the incoming env (a user-set
   * `configRootEnv` wins over the default home location). Called BEFORE the
   * override is applied, so the view can pass real state through (D15 bucket 1).
   */
  realConfigRoot(env: NodeJS.ProcessEnv): string;

  // — surfaces —

  /** The managed surfaces this harness exposes (supported and unsupported). */
  surfaces: readonly SurfaceDeclaration[];

  // — two-bucket classification (D15) —

  /**
   * Classify a single top-level entry in the real config root as bucket-1
   * (`state`, pass-through symlink) or bucket-2 (`managed`, composed). MUST
   * return `state` for anything it does not recognise — pass-through is the safe
   * unknown (D15). Entries that are surface targets return `managed`.
   */
  classifyEntry(name: string): EntryBucket;

  // — config-keys compilation (D6) —

  /**
   * Compile the env's store content for one config-keys surface into the values
   * to inject. For MCP this parses `mcp/servers.yaml` and shapes it per harness;
   * for an instructions-array surface (OpenCode) it yields the store path to
   * append. Returns `[]` when the env contributes nothing to the surface.
   *
   * The {@link ConfigKeysContext} carries `environments/<env>/` plus the launch's
   * project root, so a project-path-keyed injection (Codex trust) is representable
   * without re-freezing this contract later (H3).
   */
  compileConfigKeys(
    surface: ConfigKeysSurface,
    ctx: ConfigKeysContext,
  ): Promise<ConfigKeysInjection[]>;

  /**
   * OPTIONAL classifier for a config-keys value that drifted in the REAL file: say how
   * it disagrees with the env's CANONICAL store content (`environments/<env>/…`, e.g.
   * `mcp/servers.yaml`) — WITHOUT changing it. agentenv reports the difference and the
   * user reconciles it by editing the canonical file themselves.
   *
   * **Why this is a classifier and not an inverse of {@link compileConfigKeys}.** The
   * shapers are not injective (canonical `transport: http` and `transport: sse` both
   * compile to one OpenCode `type:'remote'` / one bare Codex `url` table), so an inverse
   * must be RECONSTRUCTED from (harness value, prior canonical, branch identity). That
   * reconstruction is a fixed lattice over a user-authored JSON/TOML input space, and
   * every defect three review rounds found lived at a boundary the lattice did not
   * cover — twice with a security consequence (a revoked credential left live in another
   * harness; a secret guard that passed real secrets). The classification is adequate to
   * DESCRIBE a difference; it was never adequate to DECIDE what to do about one. So the
   * decision goes back to the user, and the return type carries no bytes and no writable
   * path — a store write is not expressible here (see {@link ConfigKeysDriftReport}).
   *
   * Called with the drifted {@link ConfigKeysDrift.canonicalValue} (secret `${VAR}`
   * placeholders already restored — never a literal, D6). Return `null` when the surface
   * or key path is not one this adapter models canonically.
   *
   * The {@link ConfigKeysContext} mirrors {@link compileConfigKeys} so the hook can read
   * the env's canonical content to diff against, and key project-scoped stores by
   * `projectRoot`.
   *
   * OPTIONAL: an adapter that omits it degrades to non-lossy hash reconciliation with no
   * field-level report (blocks nothing), exactly like {@link validateConfigFile}.
   */
  describeConfigKeysDrift?(
    surface: ConfigKeysSurface,
    drift: ConfigKeysDrift,
    ctx: ConfigKeysContext,
  ): Promise<ConfigKeysDriftReport | null>;

  /**
   * Strict inverse used only for a quiescent retained global COW projection.
   * Ambiguous/lossy shapes must return no bytes; the caller retains and quarantines.
   */
  reverseConfigKeysDrift?(
    surface: ConfigKeysSurface,
    drift: ConfigKeysReverseDrift,
    ctx: ConfigKeysContext,
  ): Promise<ConfigKeysReverseResult>;

  // — launch self-check (D15 fail-closed) —

  /**
   * Verify the child actually observes `viewRoot`. Each adapter declares its own
   * probe (the fixture spawns its fake harness and compares the printed root).
   * A `false` result marks the harness session-unsupported FOR THIS LAUNCH: the
   * shim execs with no overrides plus a notice — never a half-applied view.
   */
  selfCheck(viewRoot: string, ctx: SelfCheckContext): Promise<SelfCheckResult>;

  // — whole-file config validation (global mode, M5) —

  /**
   * OPTIONAL post-write validation of a whole config file the composer produced,
   * for a harness whose CLI rejects the ENTIRE file on one bad entry — Cursor
   * rejects all of `~/.cursor/mcp.json` if any single server entry is malformed
   * (4.4). Applied in GLOBAL mode (Task 1.7 / 4.x) after a config-keys file is
   * written: a `{ ok: false }` result rolls the write back rather than shipping a
   * file the harness will reject wholesale. Declared now to avoid re-freezing the
   * contract later; OPTIONAL, so session mode and harnesses with per-entry
   * tolerance need not implement it.
   */
  validateConfigFile?(absPath: string, content: string): SelfCheckResult;
}

/** The `<harness>` token for per-harness store files (defaults to the id). */
export function storeToken(adapter: Adapter): string {
  return adapter.storeToken ?? adapter.id;
}

/** Find the adapter a command/binary token resolves to (by binaryName or alias). */
export function resolveAdapter(
  adapters: readonly Adapter[],
  binaryName: string,
): Adapter | undefined {
  return adapters.find(
    (a) => a.binaryName === binaryName || (a.aliases?.includes(binaryName) ?? false),
  );
}

/**
 * Structural sanity check for an adapter object, so a malformed adapter fails
 * loudly at registration rather than mid-launch. Returns an error string, or
 * `null` when the adapter is well-formed. Not a type guard — TypeScript already
 * enforces the shape; this catches the few invariants types cannot (non-empty
 * ids, an override that actually sets the declared var, surface path sanity).
 */
export function validateAdapter(adapter: Adapter): string | null {
  if (!adapter.id) return 'adapter.id is required';
  if (!adapter.binaryName) return `adapter '${adapter.id}': binaryName is required`;
  if (!adapter.configRootEnv) return `adapter '${adapter.id}': configRootEnv is required`;

  const override = adapter.overrideEnv('/probe/root');
  if (override[adapter.configRootEnv] !== '/probe/root') {
    return `adapter '${adapter.id}': overrideEnv must set ${adapter.configRootEnv} to the given root`;
  }

  const seen = new Set<string>();
  for (const surface of adapter.surfaces) {
    if (!surface.id) return `adapter '${adapter.id}': a surface is missing an id`;
    if (seen.has(surface.id)) {
      return `adapter '${adapter.id}': duplicate surface id '${surface.id}'`;
    }
    seen.add(surface.id);
    const rel = surfaceRootRelativePath(surface);
    if (rel !== undefined && (rel === '' || rel.startsWith('/') || rel.includes('..'))) {
      return `adapter '${adapter.id}': surface '${surface.id}' has an unsafe rootRelativePath '${rel}'`;
    }
    // A surface target is a MANAGED bucket-2 entry; it must never classify as
    // bucket-1 `state`, or the composer would try to pass it through as a
    // wholesale symlink into the user's real dir (H2). Assert the two agree.
    const target = rel.split(/[\\/]/)[0] ?? rel;
    if (adapter.classifyEntry(target) === 'state') {
      return `adapter '${adapter.id}': surface '${surface.id}' target '${target}' classifies as 'state' but a surface target must be 'managed'`;
    }
  }
  return null;
}

/** The config-root-relative path a surface targets (every mechanism has one). */
export function surfaceRootRelativePath(surface: SurfaceDeclaration): string {
  return surface.rootRelativePath;
}
