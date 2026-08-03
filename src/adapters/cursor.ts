import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { parse as parseYaml } from 'yaml';
import type {
  Adapter,
  ConfigKeysContext,
  ConfigKeysDrift,
  ConfigKeysInjection,
  ConfigKeysDriftReport,
  ConfigKeysSurface,
  EntryBucket,
  SelfCheckResult,
  SurfaceDeclaration,
} from '../adapter.js';
import type { JsonValue } from '../config-keys.js';
import { userHome, type AdapterV2 } from '../adapter-v2.js';
import { resolveBinaryOnPath } from '../session/resolve.js';
import {
  describeCanonicalDrift,
  omitKeys,
  hasConflictingDiscriminators,
  passthroughUnshape,
  resolveAuthDrift,
  transportFamily,
  noteConflictingTransport,
  reverseCanonicalServer,
  type UnshapeContext,
  type UnshapedServer,
} from './mcp-canonical.js';

/**
 * The Cursor adapter — the GLOBAL-ONLY / session-unsupported harness (Task 4.4).
 * The release checkpoint is verified against the current `agent` CLI (see
 * `docs/harness-cursor.md`); the reference machine's
 * `~/.cursor` was only ever READ (probes ran against temp copies / HOME overrides).
 *
 * Cursor is the reason the frozen {@link Adapter} contract carries
 * {@link Adapter.sessionSupported}`:false` and the optional
 * {@link Adapter.validateConfigFile} hook:
 *
 * - **Session mode UNSUPPORTED.** `CURSOR_CONFIG_DIR` is declared for interface
 *   consistency, but the live binary IGNORES it for `mcp.json` resolution — the CLI
 *   reads `~/.cursor/mcp.json` (home-derived) and the project `.cursor/mcp.json`
 *   only, so a config-root override cannot isolate a private view (live-verified:
 *   an `mcp.json` under `$CURSOR_CONFIG_DIR` listed "No MCP servers configured").
 *   An IDE also inherits no shell env (D11/D15). So the shim launches Cursor with NO
 *   overrides plus a one-line `--global` notice (handled by the launch path).
 * - **`mcp.json` whole-file rejection.** The CLI drops EVERY server if a single
 *   entry is malformed (live-verified: one non-object entry, or one object missing
 *   both `command` and `url`, made `mcp list` report "No MCP servers configured" —
 *   including the valid siblings). So {@link validateConfigFile} whole-file-validates
 *   `mcp.json` after each injection: a bad entry rolls the write back rather than
 *   nuking the user's whole MCP set.
 *
 * Global surfaces (used in `--global` mode): skills → `~/.cursor/skills` (dir-merge),
 * MCP → `~/.cursor/mcp.json` `mcpServers` (config-keys, keyed). Global INSTRUCTIONS
 * are unsupported (User Rules are an app+cloud settings DB, not a file surface —
 * skills are the substitute); project `.cursor/rules` + `AGENTS.md` are read-only
 * inputs per D8, never composed.
 */

/** The config-root env var (declared for consistency; the CLI ignores it for mcp.json). */
const CONFIG_ROOT_ENV = 'CURSOR_CONFIG_DIR';

/** How long to wait for `agent --version` in {@link detect} before giving up (ms). */
const DETECT_TIMEOUT_MS = 5000;

/**
 * The real-config-root entries Cursor composes privately (bucket-2, D15). Each is a
 * surface target below; anything NOT here classifies `state` (pass-through) — the
 * contract's safe default (credentials/auth, `cli-config.json`, hooks, sessions,
 * caches, and any file a future Cursor update introduces). `rules` is the nominal
 * (unsupported) global-instructions target — declared managed to satisfy the
 * surface-target invariant, never actually materialised.
 */
const MANAGED_ENTRIES = new Set(['skills', 'mcp.json', 'rules']);

/**
 * Cursor's managed surfaces.
 * - `skills` → per-item dir-merge into `~/.cursor/skills` (Cursor reads it; global
 *   skills are also covered by the shared `agents-standard` pseudo-surface when that
 *   lands — see the note in `docs/harness-cursor.md`).
 * - `instructions` → UNSUPPORTED: Cursor has no clean global-instructions surface
 *   (User Rules live in a cloud-synced settings DB, `state.vscdb` — writing it is out
 *   of scope); skills are the substitute. Declared so `status` reports the gap.
 * - `mcp` → config-keys into `~/.cursor/mcp.json`'s top-level `mcpServers` object,
 *   keyed. Cursor interpolates `${env:VAR}` natively → PASSTHROUGH
 *   (`substitutePlaceholders: false`); no secret literal ever reaches the file.
 */
const SURFACES: readonly SurfaceDeclaration[] = [
  {
    id: 'skills',
    storeKind: 'skills',
    supported: true,
    mechanism: 'dir-merge',
    rootRelativePath: 'skills',
    mode: 'symlink',
  },
  {
    id: 'instructions',
    storeKind: 'instructions',
    supported: false,
    unsupportedReason:
      'Cursor has no global-instructions surface — User Rules are app+cloud only ' +
      '(settings DB, not a file); use skills as the substitute. Project .cursor/rules ' +
      '+ AGENTS.md are read-only inputs (D8), never composed.',
    mechanism: 'dir-merge',
    rootRelativePath: 'rules',
    mode: 'symlink',
  },
  {
    id: 'mcp',
    storeKind: 'mcp',
    supported: true,
    mechanism: 'config-keys',
    rootRelativePath: 'mcp.json',
    format: 'json',
    style: 'keyed',
    keyPath: ['mcpServers'],
    // Cursor interpolates ${env:VAR} itself (rung-1 passthrough, D6): the compiled
    // ${env:VAR} is written verbatim and Cursor resolves it — no secret leaves the env.
    substitutePlaceholders: false,
  },
];

const CURSOR_SESSION_REASON =
  'Cursor does not expose an isolated config root and GUI launches do not inherit a shell environment';

export const cursorDefinition: AdapterV2 = {
  version: 2,
  id: 'cursor',
  binaryName: 'agent',
  session: { supported: false, reason: CURSOR_SESSION_REASON },
  surfaces: [
    {
      id: 'skills',
      storeKind: 'skills',
      composition: { mechanism: 'dir-merge', mode: 'symlink' },
      session: { supported: false, reason: CURSOR_SESSION_REASON },
      global: {
        supported: true,
        destination: { root: 'agents-standard', relativePath: '' },
        writer: 'projection',
        hotReload: true,
        adopt: true,
      },
    },
    {
      id: 'instructions',
      storeKind: 'instructions',
      composition: { mechanism: 'dir-merge', mode: 'symlink' },
      session: { supported: false, reason: CURSOR_SESSION_REASON },
      global: {
        supported: false,
        reason: 'Cursor User Rules are stored in an app/cloud settings database',
      },
    },
    {
      id: 'mcp',
      storeKind: 'mcp',
      composition: {
        mechanism: 'config-keys',
        format: 'json',
        style: 'keyed',
        keyPath: ['mcpServers'],
      },
      session: { supported: false, reason: CURSOR_SESSION_REASON },
      global: {
        supported: true,
        destination: { root: 'config', relativePath: 'mcp.json' },
        writer: 'projection',
      },
    },
  ],
  rawMappings: [],
};

/** Is `v` a plain (non-array) object? */
function isObject(v: unknown): v is Record<string, JsonValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Cursor-native placeholders that are NOT env vars — left untouched by the rewrite. */
const CURSOR_NATIVE_PLACEHOLDERS = new Set(['userHome', 'workspaceFolder']);

/**
 * Rewrite canonical `${VAR}` placeholders (D6) into Cursor's `${env:VAR}` syntax,
 * recursively. IDEMPOTENT: `${env:VAR}` already carries a colon so it never re-matches
 * (`${env:X}` → the name capture stops at `:`), and the Cursor-native `${userHome}` /
 * `${workspaceFolder}` tokens are excluded. So re-compiling an already-Cursor-shaped
 * entry reproduces it exactly.
 */
function toCursorEnvPlaceholders(value: JsonValue): JsonValue {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) =>
      CURSOR_NATIVE_PLACEHOLDERS.has(name) ? match : `\${env:${name}}`,
    );
  }
  if (Array.isArray(value)) return value.map(toCursorEnvPlaceholders);
  if (isObject(value)) {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value)) out[k] = toCursorEnvPlaceholders(v);
    return out;
  }
  return value;
}

/**
 * Record every string subfield shaped like `${...}` as a placeholder to preserve on
 * write-back, keyed by its dot-joined subpath WITHIN the injected value (e.g.
 * `env.GITHUB_TOKEN`, `headers.Authorization`). Mirrors Claude: Cursor interpolates
 * `${env:VAR}` natively (rung-1 passthrough, D6), so the placeholder is kept and
 * flagged, and drift write-back restores the (Cursor-syntax) placeholder rather than a
 * baked literal — keeping the REAL `mcp.json` interpolatable even after a drift event.
 */
function collectPlaceholders(value: unknown, prefix: string, out: Record<string, string>): void {
  if (typeof value === 'string') {
    if (prefix !== '' && /\$\{[^}]+\}/.test(value)) out[prefix] = value;
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      collectPlaceholders(v, prefix === '' ? String(i) : `${prefix}.${i}`, out);
    });
    return;
  }
  if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      const seg = k.replace(/\\/g, '\\\\').replace(/\./g, '\\.');
      collectPlaceholders(v, prefix === '' ? seg : `${prefix}.${seg}`, out);
    }
  }
}

/**
 * Shape one canonical `mcp/servers.yaml` server (D6) into Cursor's `mcp.json`
 * `mcpServers.<name>` object, still carrying canonical `${VAR}` placeholders (the
 * caller runs {@link toCursorEnvPlaceholders} afterwards). IDEMPOTENT on an
 * already-Cursor-shaped entry (no `transport`; `type` present for http/sse, or a bare
 * `command` for stdio) — a HAND-AUTHORED harness-shaped entry keeps its `type` as the
 * transport hint, so `{ type: sse, url }` is not re-inferred to `http` (F5/2A).
 * A harness-side edit is never folded back: {@link Adapter.describeConfigKeysDrift}
 * reports the differing fields and leaves `mcp/servers.yaml` untouched.
 *
 * Mappings:
 *   stdio → `{ command, args?, env? }`  (Cursor infers stdio from `command`; no `type`)
 *   http/sse → `{ type, url, headers? }`, with `auth.bearer_env: VAR` folded into an
 *   `Authorization: Bearer ${VAR}` header. A bespoke/unknown transport passes through
 *   unchanged (fail-soft — never corrupt the user's authored entry).
 */
function shapeCursorServer(def: unknown): JsonValue {
  if (!isObject(def)) return def as JsonValue;

  const transport =
    typeof def.transport === 'string'
      ? def.transport
      : def.command !== undefined
        ? 'stdio'
        : def.url !== undefined
          ? typeof def.type === 'string'
            ? def.type
            : 'http'
          : undefined;

  if (transport === 'stdio') {
    const out: Record<string, JsonValue> = {};
    if (def.command !== undefined) out.command = def.command;
    if (def.args !== undefined) out.args = def.args;
    if (def.env !== undefined) out.env = def.env;
    return out;
  }

  if (transport === 'http' || transport === 'sse') {
    const out: Record<string, JsonValue> = { type: transport };
    if (def.url !== undefined) out.url = def.url;
    const headers: Record<string, JsonValue> = isObject(def.headers) ? { ...def.headers } : {};
    const auth = def.auth;
    if (
      isObject(auth) &&
      typeof auth.bearer_env === 'string' &&
      headers.Authorization === undefined
    ) {
      headers.Authorization = `Bearer \${${auth.bearer_env}}`;
    }
    if (Object.keys(headers).length > 0) out.headers = headers;
    return out;
  }

  // Unknown transport: pass the user's authored def through untouched.
  return def;
}

/** Inverse of {@link toCursorEnvPlaceholders}: rewrite Cursor `${env:VAR}` back to canonical `${VAR}`. */
function fromCursorEnvPlaceholders(value: JsonValue): JsonValue {
  if (typeof value === 'string') {
    return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, '${$1}');
  }
  if (Array.isArray(value)) return value.map(fromCursorEnvPlaceholders);
  if (isObject(value)) {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value)) out[k] = fromCursorEnvPlaceholders(v);
    return out;
  }
  return value;
}

/**
 * A header value shaped `Bearer ${VAR}` → the var name, else null. Tolerant of
 * surrounding/inner whitespace, which a user's hand-edit easily introduces and which
 * must not silently cost them their `auth.bearer_env`.
 */
function bearerEnvFromHeader(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = /^\s*Bearer\s+\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\s*$/.exec(value);
  return m ? m[1]! : null;
}

/** The canonical keys each {@link shapeCursorServer} branch emits (see Claude's note). */
const CURSOR_STDIO_SUPERSEDES = ['type', 'command', 'args', 'env'] as const;

/** The `type` values {@link shapeCursorServer}'s non-passthrough branches emit. */
const CURSOR_SHAPER_TYPES = new Set(['http', 'sse']);
const CURSOR_REMOTE_SUPERSEDES = ['type', 'url', 'headers'] as const;

/**
 * The inverse of {@link shapeCursorServer} + {@link toCursorEnvPlaceholders}, as an
 * OVERLAY over the prior canonical def (see `mcp-canonical.ts`): `${env:VAR}` → `${VAR}`,
 * a bare `command` recognised as stdio, an `Authorization: Bearer ${VAR}` header folded
 * into `auth.bearer_env` — and every OTHER field of the drifted entry carried over
 * verbatim, so a field the user added in `mcp.json` reaches the store rather than being
 * dropped by a whitelist (F5/3). A bespoke `transport` the shaper passed through is never
 * re-inferred (F5/1).
 */
function unshapeCursorServer(
  def: Record<string, JsonValue>,
  prior: unknown,
  ctx: UnshapeContext,
): UnshapedServer {
  const raw = fromCursorEnvPlaceholders(def);
  const canon: Record<string, JsonValue> = isObject(raw) ? raw : {};
  // A `transport` in `mcp.json` can only have come from the shaper's bespoke
  // passthrough, so the entry is already canonical — never re-infer over it (F5/1) —
  // unless it sits beside a `type` the passthrough would never have written, in which
  // case the two disagree and the transport is unknowable (F6/9).
  const conflicting = hasConflictingDiscriminators(canon, CURSOR_SHAPER_TYPES);
  if (typeof canon.transport === 'string' && !conflicting) return passthroughUnshape(canon, prior);
  if (conflicting) noteConflictingTransport(ctx, canon.type as string);

  if (canon.command !== undefined && canon.url === undefined) {
    return {
      fields: { transport: 'stdio', ...omitKeys(canon, ['type', 'transport']) },
      supersedes: CURSOR_STDIO_SUPERSEDES,
      family: 'stdio',
      transportAuthority: conflicting ? 'ambiguous' : 'native',
    };
  }
  if (canon.url !== undefined) {
    // Cursor records the http/sse distinction NATIVELY in `type`, so a `type` the user
    // edited PROPAGATES; only a `type`-less entry is a guess to be resolved from the
    // prior canonical def (F6/1).
    const nativeType = typeof canon.type === 'string';
    const type = nativeType ? (canon.type as string) : 'http';
    const fields: Record<string, JsonValue> = {
      transport: type,
      ...omitKeys(canon, ['type', 'transport', 'headers']),
    };
    const headers = isObject(canon.headers) ? { ...canon.headers } : undefined;
    // A credential is never guessed at: an `Authorization` header that does not map
    // EXACTLY onto canonical `auth.bearer_env` leaves it alone and warns (F6/3+4).
    const auth = resolveAuthDrift({
      prior,
      header: headers?.Authorization,
      bearerEnvFromHeader,
      foldsBearerIntoHeader: true,
      ctx,
    });
    if (auth.kind === 'set') fields.auth = { bearer_env: auth.bearerEnv };
    if (headers !== undefined) {
      if (auth.kind === 'set') delete headers.Authorization; // now carried by `auth`
      if (Object.keys(headers).length > 0) fields.headers = headers;
    } else if (canon.headers !== undefined) {
      fields.headers = canon.headers; // not an object — carry verbatim, never guess
    }
    return {
      fields,
      supersedes:
        auth.kind === 'delete' ? [...CURSOR_REMOTE_SUPERSEDES, 'auth'] : CURSOR_REMOTE_SUPERSEDES,
      family: transportFamily(type),
      transportAuthority: conflicting ? 'ambiguous' : nativeType ? 'native' : 'inferred',
    };
  }
  // Unknown/bespoke Cursor entry: carry the whole (var-canonicalised) entry over.
  return passthroughUnshape(canon, prior);
}

/** Run `agent --version`, resolving `true` only on a clean exit 0. Never throws. */
function versionExitsZero(binaryPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const child = spawn(binaryPath, ['--version'], { stdio: 'ignore' });
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      done(false);
    }, DETECT_TIMEOUT_MS);
    timer.unref?.();
    child.on('exit', (code) => done(code === 0));
    child.on('error', () => done(false));
  });
}

/** Point Cursor at a private root (declared for consistency; the CLI ignores it — see above). */
function overrideEnv(root: string): Record<string, string> {
  return { [CONFIG_ROOT_ENV]: root };
}

/**
 * Whether one `mcp.json` server entry is well-formed enough that Cursor will load it.
 * Live-verified: a valid entry is a non-null object with a `command` (stdio) OR a `url`
 * (http/sse); an empty object, a non-object, or one missing both makes Cursor reject the
 * WHOLE file.
 */
function isValidCursorServer(entry: unknown): boolean {
  if (!isObject(entry)) return false;
  return typeof entry.command === 'string' || typeof entry.url === 'string';
}

/**
 * The Cursor adapter instance registered in {@link import('./index.js')}.
 */
export const cursorAdapter: Adapter = {
  id: 'cursor',
  binaryName: 'agent',
  aliases: ['cursor-agent'],
  definition: cursorDefinition,

  // GUI/IDE + a CLI whose config-root override does not isolate mcp.json → no session
  // path (D11/D15). The shim launches untouched with a --global notice (launch path).
  sessionSupported: false,
  sessionUnsupportedReason:
    'CURSOR_CONFIG_DIR does not isolate the CLI (live-verified 2026.07.23) and an IDE ' +
    'inherits no shell env — activate globally with `agentenv use … --global`',

  async detect(env) {
    const bin = await resolveBinaryOnPath('agent', env);
    if (!bin) return false;
    return versionExitsZero(bin);
  },

  configRootEnv: CONFIG_ROOT_ENV,
  overrideEnv,
  realConfigRoot(env) {
    const configured = env[CONFIG_ROOT_ENV];
    if (configured && configured.trim() !== '') return configured;
    return join(userHome(env), '.cursor');
  },

  surfaces: SURFACES,

  classifyEntry(name): EntryBucket {
    // Bucket-2 surface targets are managed; EVERYTHING else — credentials/auth,
    // cli-config.json, hooks.json, commands, sessions, worktrees, statsig caches, and
    // any file a future Cursor update introduces — defaults to bucket-1 pass-through.
    return MANAGED_ENTRIES.has(name) ? 'managed' : 'state';
  },

  async compileConfigKeys(
    surface: ConfigKeysSurface,
    ctx: ConfigKeysContext,
  ): Promise<ConfigKeysInjection[]> {
    if (surface.id !== 'mcp') return [];
    const serversFile = join(ctx.envContentDir, 'mcp', 'servers.yaml');
    if (!existsSync(serversFile)) return [];
    const parsed = parseYaml(await readFile(serversFile, 'utf8')) as
      | Record<string, unknown>
      | null
      | undefined;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    // One keyed injection per server, owned independently under mcpServers (D3/D6).
    return Object.entries(parsed).map(([name, def]) => {
      const value = toCursorEnvPlaceholders(shapeCursorServer(def));
      const secretFields: Record<string, string> = {};
      collectPlaceholders(value, '', secretFields);
      return {
        style: 'keyed' as const,
        keyPath: ['mcpServers', name],
        value,
        ...(Object.keys(secretFields).length > 0 ? { secretFields } : {}),
      };
    });
  },

  async describeConfigKeysDrift(
    surface: ConfigKeysSurface,
    drift: ConfigKeysDrift,
    ctx: ConfigKeysContext,
  ): Promise<ConfigKeysDriftReport | null> {
    // Classify how one drifted `mcp.json` server (keyPath ['mcpServers', <name>])
    // disagrees with the canonical D6 def in servers.yaml, consistent with Claude.
    // `canonicalValue` already has secret ${env:VAR} placeholders restored (D6);
    // `unshapeCursorServer` + the OVERLAY map Cursor's `${env:}` shape back onto
    // canonical, so the report names CANONICAL fields — the ones the user will edit.
    // servers.yaml is READ here and never written.
    if (surface.id !== 'mcp' || drift.style !== 'keyed') return null;
    if (drift.keyPath.length < 2) return null;
    const name = drift.keyPath[drift.keyPath.length - 1];
    if (typeof name !== 'string') return null;
    const serversFile = join(ctx.envContentDir, 'mcp', 'servers.yaml');
    const existing = existsSync(serversFile)
      ? ((parseYaml(await readFile(serversFile, 'utf8')) as Record<string, unknown> | null) ?? {})
      : {};
    return {
      entry: name,
      storeRelativePath: join('mcp', 'servers.yaml'),
      changes: describeCanonicalDrift({
        prior: existing[name],
        drifted: drift.canonicalValue,
        unshape: unshapeCursorServer,
        server: name,
        adapterId: 'cursor',
      }),
    };
  },

  async reverseConfigKeysDrift(surface, drift, ctx) {
    if (surface.id !== 'mcp' || drift.style !== 'keyed' || drift.keyPath.length < 2) {
      return { kind: 'invalid', reason: 'retained key is not a canonical Cursor MCP entry' };
    }
    const name = drift.keyPath.at(-1);
    if (typeof name !== 'string') return { kind: 'invalid', reason: 'MCP entry name is invalid' };
    const serversFile = join(ctx.envContentDir, 'mcp', 'servers.yaml');
    const existing = existsSync(serversFile)
      ? ((parseYaml(await readFile(serversFile, 'utf8')) as Record<string, unknown> | null) ?? {})
      : {};
    if (drift.removed) {
      return { kind: 'lossless', entry: name, storeRelativePath: join('mcp', 'servers.yaml') };
    }
    if (drift.canonicalValue === undefined) {
      return { kind: 'invalid', reason: 'retained MCP value is absent' };
    }
    const reversed = reverseCanonicalServer({
      prior: existing[name],
      drifted: drift.canonicalValue,
      unshape: unshapeCursorServer,
      server: name,
      adapterId: 'cursor',
    });
    if (reversed.kind === 'invalid') return reversed;
    if (reversed.kind === 'ambiguous') {
      return { kind: 'ambiguous', reason: `ambiguous canonical field(s): ${reversed.fields.join(', ')}` };
    }
    return {
      kind: 'lossless',
      entry: name,
      storeRelativePath: join('mcp', 'servers.yaml'),
      value: reversed.value,
    };
  },

  validateConfigFile(absPath: string, content: string): SelfCheckResult {
    // Cursor rejects the ENTIRE mcp.json if any single server entry is malformed
    // (live-verified). Applied in global mode after each injection: a bad entry — a
    // pre-existing user entry OR a composed one — rolls the write back rather than
    // silently dropping the user's whole MCP set. Parse leniently (Cursor tolerates
    // trailing commas / JSONC), then whole-file-validate every entry.
    if (content.trim() === '') return { ok: true };
    const errors: ParseError[] = [];
    const parsed = parseJsonc(content, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
      return { ok: false, detail: `${absPath}: not parseable as JSON/JSONC — Cursor would reject it` };
    }
    if (!isObject(parsed)) {
      return { ok: false, detail: `${absPath}: top level is not an object — Cursor would reject it` };
    }
    const servers = parsed.mcpServers;
    if (servers === undefined) return { ok: true }; // no MCP block — nothing Cursor loads
    if (!isObject(servers)) {
      return { ok: false, detail: `${absPath}: mcpServers is not an object — Cursor rejects the whole file` };
    }
    const bad = Object.entries(servers)
      .filter(([, entry]) => !isValidCursorServer(entry))
      .map(([n]) => n);
    if (bad.length > 0) {
      return {
        ok: false,
        detail:
          `${absPath}: malformed mcpServers ${bad.map((n) => `'${n}'`).join(', ')} ` +
          `(each needs a 'command' or 'url') — Cursor rejects the WHOLE file, dropping every server`,
      };
    }
    return { ok: true };
  },

  async selfCheck(viewRoot: string): Promise<SelfCheckResult> {
    // Session mode never composes Cursor (the launch path short-circuits on
    // sessionSupported:false before selfCheck). This is a safe, offline fail-closed
    // assertion of that invariant: CURSOR_CONFIG_DIR cannot isolate the CLI, so a
    // session view can never be proven — global mode is the only supported path.
    // The SelfCheckContext (binary resolver / capture) is intentionally unused — the
    // probe stays offline and never touches the CLI.
    return {
      ok: false,
      detail:
        `agent does not isolate its config root via CURSOR_CONFIG_DIR ` +
        `(live-verified) — session mode is unsupported; use --global (view ${viewRoot} not composed)`,
    };
  },
};
