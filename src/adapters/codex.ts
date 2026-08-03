import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import type {
  Adapter,
  ConfigKeysContext,
  ConfigKeysDrift,
  ConfigKeysInjection,
  ConfigKeysDriftReport,
  ConfigKeysSurface,
  EntryBucket,
  SelfCheckContext,
  SelfCheckResult,
  SurfaceDeclaration,
} from '../adapter.js';
import { userHome, type AdapterV2 } from '../adapter-v2.js';
import type { JsonValue } from '../config-keys.js';
import { resolveBinaryOnPath } from '../session/resolve.js';
import {
  describeCanonicalDrift,
  omitKeys,
  passthroughUnshape,
  resolveAuthDrift,
  reverseCanonicalServer,
  transportFamily,
  type UnshapeContext,
  type UnshapedServer,
} from './mcp-canonical.js';

/**
 * The Codex CLI adapter — the Phase-4 implementation of the frozen {@link Adapter}
 * contract (Task 4.1). Every declaration is re-verified LIVE against `codex`
 * 0.146.0 on a COPY of the real `~/.codex` (see `docs/harness-codex.md`); the
 * Phase-0 spike (`spike/FINDINGS.md`) proved `CODEX_HOME` relocates
 * `config.toml` + `auth.json` and that a view's MCP set isolates per shell.
 * Nothing here is engine logic — only Codex's surface declarations and format
 * quirks, dispatched by the shared composer/launch.
 *
 * Config root: `~/.codex/` (relocated wholesale by `CODEX_HOME`, confirmed live:
 * `codex doctor` reports `config.toml → $CODEX_HOME/config.toml` and
 * `auth file → $CODEX_HOME/auth.json`). Two-bucket split (D15): `auth.json` is the
 * bucket-1 pass-through that keeps the view logged in; the surface targets
 * (`config.toml`/`AGENTS.md`/`skills`) are bucket-2 managed; every other entry
 * (`hooks.json`, `prompts/`, `agents/`, `tmp/`, caches, and any future Codex file)
 * defaults to bucket-1 pass-through — the safe unknown.
 *
 * MCP quirk (D6): Codex does NOT interpolate `${VAR}` inside `[mcp_servers.*]`
 * values, so this adapter compiles the canonical `mcp/servers.yaml` to Codex's
 * **native indirections first** — `env_vars` (stdio allowlist),
 * `bearer_token_env_var` and `env_http_headers` (HTTP) — which point Codex at the
 * process env var with NO secret in the file. Only a secret with no native
 * indirection (embedded in a `url`, a renamed env var, a `Bearer ${VAR}` header)
 * stays as a `${VAR}` placeholder and is flagged in `secretFields`; the surface's
 * {@link ConfigKeysSurface.substitutePlaceholders `substitutePlaceholders:true`}
 * then has the engine resolve those to literals in the (ephemeral) view only,
 * while the manifest keeps the placeholder so write-back never bakes a secret.
 */

/** The config-root env var that relocates Codex's entire config root (D15). */
const CONFIG_ROOT_ENV = 'CODEX_HOME';

/** How long to wait for `codex --version` in {@link detect} before giving up (ms). */
const DETECT_TIMEOUT_MS = 5000;

/**
 * The real-config-root entries Codex composes privately (bucket-2, D15). Every one
 * is also a surface target below; anything NOT here classifies `state`
 * (pass-through), the contract's safe default for unknown entries — including the
 * bucket-1 `auth.json` that keeps the view logged in.
 */
const MANAGED_ENTRIES = new Set(['config.toml', 'AGENTS.md', 'skills']);

/**
 * Codex's managed surfaces:
 *  - **skills** dir-merge at `$CODEX_HOME/skills` (in-root, NEVER `~/.agents/skills`,
 *    which is `$HOME`-derived and would leak the env into every session, D15).
 *    Codex documents symlinked skill folders as supported. NOTE: the
 *    `$CODEX_HOME/skills` *loader* is UNVERIFIED on 0.146.0 (Codex's documented
 *    user location is `~/.agents/skills`; the in-root dir is referenced only by
 *    legacy repo samples, and the loader can't be proven non-interactively without
 *    a logged-in install — spike Q2). Kept `supported:true` per the design's
 *    per-adapter placement; see `docs/harness-codex.md`.
 *  - **instructions** file-block `AGENTS.md` in **inline** mode (D2) — Codex has no
 *    include syntax, so the managed region holds the store file's content verbatim.
 *  - **mcp** config-keys into `config.toml`'s `[mcp_servers.*]` tables (TOML, keyed).
 *    `substitutePlaceholders:true` — Codex can't interpolate `${VAR}` in mcp values,
 *    so any placeholder the native indirections could NOT remove is resolved to a
 *    literal in the ephemeral view (never the store).
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
    id: 'commands',
    storeKind: 'commands',
    supported: true,
    mechanism: 'dir-merge',
    rootRelativePath: 'skills',
    mode: 'symlink',
    layout: 'command-skill',
  },
  {
    id: 'instructions',
    storeKind: 'instructions',
    supported: true,
    mechanism: 'file-block',
    rootRelativePath: 'AGENTS.md',
    layering: 'inline',
  },
  {
    id: 'mcp',
    storeKind: 'mcp',
    supported: true,
    mechanism: 'config-keys',
    rootRelativePath: 'config.toml',
    format: 'toml',
    style: 'keyed',
    keyPath: ['mcp_servers'],
    substitutePlaceholders: true,
  },
];

/** Adapter v2: Codex sessions relocate CODEX_HOME; global skills use the shared standard. */
export const codexDefinition: AdapterV2 = {
  version: 2,
  id: 'codex',
  binaryName: 'codex',
  session: {
    supported: true,
    launch: { rootOverride: { variable: CONFIG_ROOT_ENV } },
  },
  surfaces: [
    {
      id: 'skills',
      storeKind: 'skills',
      composition: { mechanism: 'dir-merge', mode: 'symlink' },
      session: {
        supported: true,
        destination: { root: 'view', relativePath: 'skills' },
        writer: 'direct',
        hotReload: true,
        adopt: true,
      },
      global: {
        supported: true,
        destination: { root: 'agents-standard', relativePath: '' },
        writer: 'projection',
        hotReload: true,
        adopt: true,
      },
    },
    {
      id: 'commands',
      storeKind: 'commands',
      composition: { mechanism: 'dir-merge', mode: 'symlink', layout: 'command-skill' },
      session: {
        supported: true,
        destination: { root: 'view', relativePath: 'skills' },
        writer: 'direct',
        inheritUserContent: false,
        hotReload: true,
      },
      global: {
        supported: true,
        destination: { root: 'agents-standard', relativePath: '' },
        writer: 'projection',
        hotReload: true,
      },
    },
    {
      id: 'instructions',
      storeKind: 'instructions',
      composition: { mechanism: 'file-block', layering: 'inline' },
      session: {
        supported: true,
        destination: { root: 'view', relativePath: 'AGENTS.md' },
        writer: 'direct',
        inheritUserContent: true,
      },
      global: {
        supported: true,
        destination: { root: 'config', relativePath: 'AGENTS.md' },
        writer: 'projection',
      },
    },
    {
      id: 'agents',
      storeKind: 'agents',
      composition: { mechanism: 'dir-merge', mode: 'symlink' },
      session: { supported: false, reason: 'Codex subagents require raw TOML mappings' },
      global: { supported: false, reason: 'Codex subagents require raw TOML mappings' },
    },
    {
      id: 'mcp',
      storeKind: 'mcp',
      composition: {
        mechanism: 'config-keys',
        format: 'toml',
        style: 'keyed',
        keyPath: ['mcp_servers'],
        substitutePlaceholders: true,
      },
      session: {
        supported: true,
        destination: { root: 'view', relativePath: 'config.toml' },
        writer: 'direct',
        inheritUserContent: true,
      },
      global: {
        supported: true,
        destination: { root: 'config', relativePath: 'config.toml' },
        writer: 'projection',
      },
    },
  ],
  rawMappings: [
    {
      id: 'codex-agents',
      storeRelativePath: 'agents',
      session: {
        supported: true,
        destination: { root: 'view', relativePath: 'agents' },
        writer: 'direct',
        inheritUserContent: true,
      },
      global: {
        supported: true,
        destination: { root: 'config', relativePath: 'agents' },
        writer: 'projection',
      },
    },
  ],
};

/** Is `v` a plain (non-array) object? */
function isObject(v: unknown): v is Record<string, JsonValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A string that is EXACTLY a single `${VAR}` placeholder → the variable name, else null. */
function wholePlaceholderVar(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const m = /^\$\{\s*([^}]+?)\s*\}$/.exec(s);
  return m ? m[1]! : null;
}

/**
 * Record every string subfield shaped like `${VAR}` as a secret placeholder, keyed
 * by its dot-joined subpath WITHIN the injected value (e.g. `url` or `env.TOKEN`).
 * Mirrors the Claude adapter's collector EXACTLY (same escape convention) so the
 * dot-paths round-trip through `substituteSecretFields`/`restoreSecrets`. Run on
 * the FINAL Codex-shaped value: the native indirections have already compiled the
 * common placeholders away, so only genuinely-embedded secrets are flagged here.
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
 * Shape one canonical `mcp/servers.yaml` server (D6) into Codex's `[mcp_servers.<name>]`
 * table, preferring NATIVE INDIRECTIONS over any secret in the file:
 *
 *   stdio → `{ command, args?, env?, env_vars? }`
 *     - an `env` entry `KEY: "${KEY}"` (whole value is the placeholder AND names the
 *       same var) → moved to the `env_vars` allowlist (Codex forwards the process
 *       env var); no secret, no placeholder left.
 *     - any other `env` entry (a literal, a renamed `${OTHER}`, or `"${X} tail"`)
 *       stays in `env` verbatim — a remaining `${VAR}` is flagged for the substitute
 *       rung.
 *   http/sse → `{ url, bearer_token_env_var?, http_headers?, env_http_headers? }`
 *     - `auth.bearer_env: VAR` → `bearer_token_env_var = "VAR"` (native).
 *     - a `headers` entry whose WHOLE value is `${VAR}` → `env_http_headers.<H> = "VAR"`
 *       (native: Codex sources the header from the env var).
 *     - any other `headers` entry (literal or `"Bearer ${VAR}"`) stays in
 *       `http_headers` verbatim — a remaining `${VAR}` is flagged.
 *     - a `${VAR}` inside `url` has no indirection → stays and is flagged.
 *
 * A bespoke/unknown transport is passed through unchanged (fail-soft — never
 * corrupt a user's authored entry).
 */
function shapeCodexServer(
  def: unknown,
  name: string,
  warn: (message: string) => void,
): JsonValue {
  if (!isObject(def)) return def as JsonValue;

  // A HAND-AUTHORED harness-shaped entry (no `transport`, a `type`) is honoured exactly
  // as the other three adapters honour it: `type` IS the transport hint. Without this,
  // `{ type: websocket, url }` — which Claude/Cursor/OpenCode all pass through as bespoke
  // — would silently compile to a plain Codex HTTP table here (F5/2, F6/2).
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
    if (isObject(def.env)) {
      const env: Record<string, JsonValue> = {};
      const envVars: string[] = [];
      for (const [key, val] of Object.entries(def.env)) {
        if (wholePlaceholderVar(val) === key) envVars.push(key);
        else env[key] = val;
      }
      if (Object.keys(env).length > 0) out.env = env;
      if (envVars.length > 0) out.env_vars = envVars;
    } else if (def.env !== undefined) {
      out.env = def.env;
    }
    return out;
  }

  if (transport === 'http' || transport === 'sse') {
    const out: Record<string, JsonValue> = {};
    if (def.url !== undefined) out.url = def.url;
    const auth = def.auth;
    // SECURITY (F6/3): an `Authorization` header SHADOWS the bearer — it is what the
    // server will actually receive. Emitting `bearer_token_env_var` beside it would have
    // Codex keep authenticating with a credential the user may believe they replaced, in
    // a harness they were not looking at. Refuse, and say why.
    const shadowedBy =
      isObject(def.headers) && def.headers.Authorization !== undefined ? 'headers' : null;
    if (isObject(auth) && typeof auth.bearer_env === 'string') {
      if (shadowedBy !== null) {
        warn(
          `agentenv: MCP server '${name}' — canonical auth.bearer_env (${auth.bearer_env}) is ` +
            `SHADOWED by an Authorization header, so codex's bearer_token_env_var was NOT ` +
            `written; the header is what codex will send. Remove one of the two in ` +
            `mcp/servers.yaml to settle it.`,
        );
      } else {
        out.bearer_token_env_var = auth.bearer_env;
      }
    }
    if (isObject(def.headers)) {
      const httpHeaders: Record<string, JsonValue> = {};
      const envHeaders: Record<string, JsonValue> = {};
      for (const [name, val] of Object.entries(def.headers)) {
        const varName = wholePlaceholderVar(val);
        if (varName !== null) envHeaders[name] = varName;
        else httpHeaders[name] = val;
      }
      if (Object.keys(httpHeaders).length > 0) out.http_headers = httpHeaders;
      if (Object.keys(envHeaders).length > 0) out.env_http_headers = envHeaders;
    }
    return out;
  }

  // Unknown transport: pass the user's authored def through untouched.
  return def as JsonValue;
}

/** Codex-only keys the un-shape TRANSLATES away (they have canonical counterparts). */
const CODEX_NATIVE_KEYS = [
  'env_vars',
  'bearer_token_env_var',
  'http_headers',
  'env_http_headers',
] as const;

/**
 * The canonical keys each {@link shapeCodexServer} branch emits (FAMILY-AWARE, see the
 * Claude adapter's note): the stdio branch never writes `url`/`headers`, so it may not
 * delete them, and vice versa. Unlike the other adapters, `auth` is unconditional on the
 * remote branch: Codex's `bearer_token_env_var` is an EXACT bidirectional mapping with no
 * header shadowing it, so its absence really does mean the bearer was removed.
 */
const CODEX_STDIO_SUPERSEDES = ['type', 'command', 'args', 'env'] as const;
const CODEX_REMOTE_SUPERSEDES = ['type', 'url', 'headers'] as const;

/**
 * The inverse of {@link shapeCodexServer}, as an OVERLAY over the prior canonical def
 * (see `mcp-canonical.ts`): the native indirections (`env_vars`, `bearer_token_env_var`,
 * `env_http_headers`) translated back to canonical `env`/`auth`/`headers` with `${VAR}`
 * restored, and every OTHER field of the drifted table carried over verbatim, so a field
 * the user added in `config.toml` reaches the store rather than being dropped by a
 * whitelist (F5/3). Codex's table cannot distinguish `http` from `sse` (both are just a
 * `url`), so the prior canonical `transport` is kept verbatim by the overlay (F5/4); a
 * bespoke `transport` the shaper passed through is never re-inferred (F5/1).
 */
function unshapeCodexServer(
  def: Record<string, JsonValue>,
  prior: unknown,
  ctx: UnshapeContext,
): UnshapedServer {
  // A `transport` — or a `type` naming a transport Codex has no table shape for — can
  // only have come from the shaper's bespoke passthrough, so the entry is already
  // canonical; never re-infer over it (F5/1, F6/2, symmetric with {@link shapeCodexServer}).
  if (typeof def.transport === 'string') return passthroughUnshape(def, prior);
  if (typeof def.type === 'string' && transportFamily(def.type) === 'bespoke') {
    return passthroughUnshape(def, prior);
  }

  if (def.command !== undefined) {
    const fields: Record<string, JsonValue> = {
      transport: 'stdio',
      ...omitKeys(def, [...CODEX_NATIVE_KEYS, 'env']),
    };
    const env: Record<string, JsonValue> = isObject(def.env) ? { ...def.env } : {};
    if (Array.isArray(def.env_vars)) {
      for (const v of def.env_vars) if (typeof v === 'string') env[v] = `\${${v}}`;
    }
    if (Object.keys(env).length > 0) fields.env = env;
    else if (def.env !== undefined && !isObject(def.env)) fields.env = def.env;
    return {
      fields,
      supersedes: CODEX_STDIO_SUPERSEDES,
      family: 'stdio',
      transportAuthority: 'native', // `stdio` is unambiguous — only a command compiles to one
    };
  }

  if (def.url !== undefined) {
    const fields: Record<string, JsonValue> = {
      transport: 'http',
      ...omitKeys(def, [...CODEX_NATIVE_KEYS, 'headers']),
    };
    const headers: Record<string, JsonValue> = isObject(def.http_headers)
      ? { ...def.http_headers }
      : {};
    if (isObject(def.env_http_headers)) {
      for (const [name, varName] of Object.entries(def.env_http_headers)) {
        if (typeof varName === 'string') headers[name] = `\${${varName}}`;
      }
    }
    if (Object.keys(headers).length > 0) fields.headers = headers;
    // `bearer_token_env_var` is EXACT, so it settles `auth` outright. Without one, the
    // question falls to the shared rule: a table whose Authorization header no longer
    // matches what agentenv compiled says nothing reliable about the bearer (F6/3+4).
    const auth = resolveAuthDrift({
      prior,
      header: headers.Authorization,
      bearerEnvFromHeader: () => null, // Codex has no Bearer-header convention
      nativeBearer: typeof def.bearer_token_env_var === 'string' ? def.bearer_token_env_var : null,
      foldsBearerIntoHeader: false,
      ctx,
    });
    if (auth.kind === 'set') fields.auth = { bearer_env: auth.bearerEnv };
    return {
      fields,
      supersedes:
        auth.kind === 'delete' ? [...CODEX_REMOTE_SUPERSEDES, 'auth'] : CODEX_REMOTE_SUPERSEDES,
      family: 'remote',
      // A Codex table is just a `url`: `http` and `sse` are indistinguishable, so the
      // `http` above is a GUESS the prior canonical transport overrides (F5/4).
      transportAuthority: 'inferred',
    };
  }

  // Unknown/bespoke Codex entry: carry the whole table over so a user's hand-authored
  // one is never corrupted on write-back.
  return passthroughUnshape(def, prior);
}

/** Run `codex --version`, resolving `true` only on a clean exit 0. Never throws. */
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

/** Point Codex at a private root (D15): the single `CODEX_HOME` override. */
function overrideEnv(root: string): Record<string, string> {
  return { [CONFIG_ROOT_ENV]: root };
}

/**
 * The Codex CLI adapter instance registered in {@link import('./index.js')}.
 */
export const codexAdapter: Adapter = {
  definition: codexDefinition,
  id: 'codex',
  binaryName: 'codex',

  sessionSupported: true,

  async detect(env) {
    const bin = await resolveBinaryOnPath('codex', env);
    if (!bin) return false;
    return versionExitsZero(bin);
  },

  configRootEnv: CONFIG_ROOT_ENV,
  overrideEnv,
  realConfigRoot(env) {
    const configured = env[CONFIG_ROOT_ENV];
    if (configured && configured.trim() !== '') return configured;
    return join(userHome(env), '.codex');
  },

  surfaces: SURFACES,

  classifyEntry(name): EntryBucket {
    // Bucket-2 surface targets are managed; EVERYTHING else — `auth.json` (the
    // single bucket-1 pass-through that keeps the view logged in), `hooks.json`,
    // `prompts/`, `agents/`, `tmp/`, caches, and any file a future Codex update
    // introduces — defaults to bucket-1 pass-through, the safe unknown.
    return MANAGED_ENTRIES.has(name) ? 'managed' : 'state';
  },

  async compileConfigKeys(
    surface: ConfigKeysSurface,
    ctx: ConfigKeysContext,
  ): Promise<ConfigKeysInjection[]> {
    if (surface.id !== 'mcp') return [];
    const injections: ConfigKeysInjection[] = [];
    // The shaper refuses to emit a SHADOWED bearer (F6/3) and must say so out loud.
    const warn = ctx.onWarn ?? ((m: string) => console.warn(m));

    const serversFile = join(ctx.envContentDir, 'mcp', 'servers.yaml');
    if (existsSync(serversFile)) {
      const parsed = parseYaml(await readFile(serversFile, 'utf8')) as
        | Record<string, unknown>
        | null
        | undefined;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [name, def] of Object.entries(parsed)) {
          const value = shapeCodexServer(def, name, warn);
          const secretFields: Record<string, string> = {};
          collectPlaceholders(value, '', secretFields);
          injections.push({
            style: 'keyed',
            keyPath: ['mcp_servers', name],
            value,
            ...(Object.keys(secretFields).length > 0 ? { secretFields } : {}),
          });
        }
      }
    }

    return injections;
  },

  async describeConfigKeysDrift(
    surface: ConfigKeysSurface,
    drift: ConfigKeysDrift,
    ctx: ConfigKeysContext,
  ): Promise<ConfigKeysDriftReport | null> {
    // Classify how one drifted Codex `[mcp_servers.<name>]` table disagrees with the
    // canonical D6 def in servers.yaml. `unshapeCodexServer` + the OVERLAY translate the
    // native indirections (`env_vars`, `bearer_token_env_var`, `env_http_headers`) back
    // to canonical `env`/`auth`/`headers`, so the report names CANONICAL fields — the
    // ones the user will edit. servers.yaml is READ here and never written.
    if (surface.id !== 'mcp' || drift.style !== 'keyed') return null;
    // The trust entry (`['projects', <root>]`) is launch-derived, not stored — it has no
    // canonical counterpart to disagree with, so there is nothing to report.
    if (drift.keyPath.length < 2 || drift.keyPath[0] !== 'mcp_servers') return null;
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
        unshape: unshapeCodexServer,
        server: name,
        adapterId: 'codex',
      }),
    };
  },

  async reverseConfigKeysDrift(surface, drift, ctx) {
    if (
      surface.id !== 'mcp' ||
      drift.style !== 'keyed' ||
      drift.keyPath.length < 2 ||
      drift.keyPath[0] !== 'mcp_servers'
    ) {
      return { kind: 'invalid', reason: 'retained key is not a canonical Codex MCP entry' };
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
      unshape: unshapeCodexServer,
      server: name,
      adapterId: 'codex',
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

  async selfCheck(viewRoot: string, ctx: SelfCheckContext): Promise<SelfCheckResult> {
    const bin = await ctx.resolveBinary();
    if (!bin) return { ok: false, detail: 'codex not found on PATH' };

    // Prove the child observes THIS root: `codex mcp list` reads `[mcp_servers.*]`
    // from `$CODEX_HOME/config.toml` and prints each server's NAME (live-verified),
    // regardless of connect/auth status — an offline, login-independent signal.
    const viewServers = await readViewMcpServerNames(viewRoot);

    const res = await ctx.capture(bin, ['mcp', 'list'], {
      ...ctx.env,
      ...overrideEnv(viewRoot),
    });
    const out = `${res.stdout}\n${res.stderr}`;

    if (viewServers.length === 0) {
      // Env contributed no MCP server to key off: fall back to a mechanism check —
      // the child ran `mcp list` against the view and returned cleanly.
      return res.code === 0
        ? { ok: true }
        : { ok: false, detail: `codex mcp list exited ${res.code} against ${viewRoot}` };
    }

    const seen = viewServers.some((name) =>
      new RegExp(`(^|\\n)\\s*${escapeRegExp(name)}\\b`).test(out),
    );
    return seen
      ? { ok: true }
      : {
          ok: false,
          detail: `child did not list any of the view's servers [${viewServers.join(', ')}] under ${viewRoot}`,
        };
  },
};

/** Read the `[mcp_servers.*]` table names from a view's `config.toml` (empty on any error). */
async function readViewMcpServerNames(viewRoot: string): Promise<string[]> {
  try {
    const raw = await readFile(join(viewRoot, 'config.toml'), 'utf8');
    const parsed = parseToml(raw) as { mcp_servers?: Record<string, unknown> };
    return isObject(parsed.mcp_servers) ? Object.keys(parsed.mcp_servers) : [];
  } catch {
    return [];
  }
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
