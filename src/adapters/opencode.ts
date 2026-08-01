import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  Adapter,
  ConfigKeysContext,
  ConfigKeysDrift,
  ConfigKeysInjection,
  ConfigKeysDriftReport,
  ConfigKeysSurface,
  EntryBucket,
  OverrideEnv,
  SelfCheckContext,
  SelfCheckResult,
  SurfaceDeclaration,
} from '../adapter.js';
import type { JsonValue } from '../config-keys.js';
import { resolveBinaryOnPath } from '../session/resolve.js';
import {
  describeCanonicalDrift,
  isJsonObject,
  hasConflictingDiscriminators,
  omitKeys,
  passthroughUnshape,
  resolveAuthDrift,
  noteConflictingTransport,
  type UnshapeContext,
  type UnshapedServer,
} from './mcp-canonical.js';

/**
 * The OpenCode adapter (Task 4.2). Every declaration below is re-verified LIVE
 * against `opencode` 1.18.5 (see `docs/harness-opencode.md`); the matrix OpenCode
 * section was previously docs-only. Nothing here is engine logic — only OpenCode's
 * surface declarations and format quirks, dispatched by the shared composer/launch.
 *
 * Config relocation (D15) — the ONE place OpenCode does not fit the frozen contract:
 * OpenCode's only isolation lever is **`XDG_CONFIG_HOME`**, which points at the
 * PARENT of an `opencode`-named config dir (it reads `$XDG_CONFIG_HOME/opencode`).
 * `OPENCODE_CONFIG_DIR` does NOT isolate — live it merges as an extra layer and
 * LEAKS the real `~/.config/opencode` servers/instructions/plugins into the view.
 * `validateAdapter` (frozen) requires `overrideEnv(root)[configRootEnv] === root`,
 * so {@link overrideEnv} declares `OPENCODE_CONFIG_DIR: root` (satisfying it, a
 * verified-idempotent redundant re-merge of the SAME `viewRoot/opencode.json`) and
 * ALSO sets `XDG_CONFIG_HOME = dirname(root)` — the real lever. Correctness relies
 * on `basename(viewRoot) === 'opencode'`, which holds because the composer names
 * the view after {@link Adapter.id} and this adapter's id is `opencode`. See the
 * harness note's "Session override design" section.
 *
 * Auth lives OUTSIDE the config root (under `$XDG_DATA_HOME`, `~/.local/share/
 * opencode/`), so relocating `XDG_CONFIG_HOME` passes login through automatically —
 * no bucket-1 auth entry is needed under the config root (D15).
 */

/**
 * The env var the frozen contract records as the config-root override. OpenCode
 * honours it only as an additive merge layer (NOT isolation), so {@link overrideEnv}
 * pairs it with the real lever, `XDG_CONFIG_HOME` (see the file header).
 */
const CONFIG_ROOT_ENV = 'OPENCODE_CONFIG_DIR';

/** How long to wait for `opencode --version` in {@link detect} before giving up (ms). */
const DETECT_TIMEOUT_MS = 5000;

/**
 * The real-config-root entries OpenCode composes privately (bucket-2, D15) — the
 * surface targets. Everything NOT here classifies `state` (pass-through), the
 * contract's safe default for unknown entries: `node_modules` (plugin deps),
 * `AGENTS.md`/`CLAUDE.md` (the user's global instructions still apply in the view),
 * and any future state file all pass through.
 */
const MANAGED_ENTRIES = new Set(['skills', 'agents', 'commands', 'opencode.json']);

/**
 * OpenCode's managed surfaces. Skills/agents/commands are per-item dir-merge
 * (symlink — OpenCode follows symlinked skill dirs, live-verified). Instructions is
 * config-keys **array-element** on the `instructions` array of `opencode.json`
 * (append the store file's ABSOLUTE path — live-verified to load); no file-block on
 * AGENTS.md needed. MCP is config-keys **keyed** into the `mcp` object of the same
 * `opencode.json` (the composer groups both config-keys surfaces by that one file).
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
    id: 'agents',
    storeKind: 'agents',
    supported: true,
    mechanism: 'dir-merge',
    rootRelativePath: 'agents',
    mode: 'symlink',
  },
  {
    id: 'commands',
    storeKind: 'commands',
    supported: true,
    mechanism: 'dir-merge',
    rootRelativePath: 'commands',
    mode: 'symlink',
  },
  {
    // Global instructions: append the store instruction file's absolute path to the
    // `instructions` array (array-element, D3). Absolute paths load (live-verified),
    // the store file stays canonical, and edits write through — no file-block.
    id: 'instructions',
    storeKind: 'instructions',
    supported: true,
    mechanism: 'config-keys',
    rootRelativePath: 'opencode.json',
    format: 'json',
    style: 'array-element',
    keyPath: ['instructions'],
  },
  {
    id: 'mcp',
    storeKind: 'mcp',
    supported: true,
    mechanism: 'config-keys',
    rootRelativePath: 'opencode.json',
    format: 'json',
    style: 'keyed',
    keyPath: ['mcp'],
    // OpenCode interpolates `{env:VAR}` natively → rung-1 passthrough (D6): keep the
    // placeholder, never resolve a secret into the (derived) view.
    substitutePlaceholders: false,
  },
];

/** The store instruction files an env contributes, in load order (base then harness). */
const INSTRUCTION_STORE_FILES = ['base.md', 'opencode.md'] as const;

/** Is `v` a plain (non-array) object? */
function isObject(v: unknown): v is Record<string, JsonValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Recursively rewrite shell-style `${VAR}` placeholders to OpenCode's native
 * `{env:VAR}` syntax in every string (OpenCode does NOT substitute `${VAR}`). A
 * value already using `{env:VAR}` is left unchanged, so the transform is a no-op on
 * an already-OpenCode-shaped entry — what makes the write-back round-trip stable.
 */
function convertVarsDeep(value: JsonValue): JsonValue {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, '{env:$1}');
  }
  if (Array.isArray(value)) return value.map(convertVarsDeep);
  if (isObject(value)) {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value)) out[k] = convertVarsDeep(v);
    return out;
  }
  return value;
}

/**
 * Record every string subfield holding an `{env:VAR}` placeholder, keyed by its
 * dot-joined subpath WITHIN the injected value (e.g. `env.GITHUB_TOKEN`,
 * `headers.Authorization`, or `command.2` for an array element). Mirrors the Claude
 * adapter: OpenCode interpolates `{env:VAR}` natively (rung-1 passthrough, D6), so
 * the placeholder is kept and flagged, and drift write-back restores it rather than
 * a baked literal.
 */
function collectPlaceholders(value: unknown, prefix: string, out: Record<string, string>): void {
  if (typeof value === 'string') {
    if (prefix !== '' && /\{env:[^}]+\}/.test(value)) out[prefix] = value;
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

/** Combine a canonical `command` (string or array) + `args` into OpenCode's single `command` array. */
function toCommandArray(command: JsonValue | undefined, args: JsonValue | undefined): JsonValue[] {
  const out: JsonValue[] = [];
  if (Array.isArray(command)) out.push(...command);
  else if (command !== undefined) out.push(command);
  if (Array.isArray(args)) out.push(...args);
  return out;
}

/**
 * Shape one canonical `mcp/servers.yaml` server (D6) into OpenCode's `opencode.json`
 * `mcp.<name>` object. `servers.yaml` is ALWAYS D6-canonical (F1: every adapter's
 * {@link syncBackConfigKeys} writes canonical, never its harness shape), so the input
 * normally carries `transport`.
 *
 * A HAND-AUTHORED harness-shaped entry is still honoured: `type` is the transport hint
 * when there is no `transport` (so `{ type: sse, url }` compiles to a remote server
 * rather than being re-inferred), and an explicit `enabled: false` is CARRIED THROUGH —
 * a deliberately disabled server must never be silently switched back on (F5/2).
 *
 * Mappings from the canonical model:
 *   stdio → `{ type:'local', command:[command, ...args], enabled, env? }`
 *     (OpenCode's `command` is a SINGLE array combining command + args).
 *   http/sse → `{ type:'remote', url, enabled, headers? }`, with
 *     `auth.bearer_env: VAR` folded into `Authorization: 'Bearer {env:VAR}'`.
 * `enabled` defaults to `true` (OpenCode's own default) when canonical says nothing.
 * `${VAR}` in any string becomes `{env:VAR}` (OpenCode's native passthrough form).
 * A bespoke/unknown transport is passed through (fail-soft), still var-converted.
 */
function shapeOpenCodeServer(def: unknown): JsonValue {
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
  // Canonical `enabled` wins over the default; anything non-boolean is ignored rather
  // than written into OpenCode's schema-checked `enabled` field.
  const enabled = typeof def.enabled === 'boolean' ? def.enabled : true;

  if (transport === 'stdio') {
    const out: Record<string, JsonValue> = { type: 'local' };
    const command = toCommandArray(def.command, def.args);
    if (command.length > 0) out.command = command;
    out.enabled = enabled;
    if (def.env !== undefined) out.env = def.env;
    return convertVarsDeep(out);
  }

  if (transport === 'http' || transport === 'sse') {
    const out: Record<string, JsonValue> = { type: 'remote' };
    if (def.url !== undefined) out.url = def.url;
    const headers: Record<string, JsonValue> = isObject(def.headers) ? { ...def.headers } : {};
    const auth = def.auth;
    if (
      isObject(auth) &&
      typeof auth.bearer_env === 'string' &&
      headers.Authorization === undefined
    ) {
      headers.Authorization = `Bearer {env:${auth.bearer_env}}`;
    }
    out.enabled = enabled;
    if (Object.keys(headers).length > 0) out.headers = headers;
    return convertVarsDeep(out);
  }

  // Unknown transport: pass the user's authored def through (var-converted only).
  return convertVarsDeep(def);
}

/**
 * Inverse of {@link convertVarsDeep}: rewrite OpenCode `{env:VAR}` back to canonical
 * `${VAR}`. The `(?<!\$)` guard is load-bearing: without it the inner braces of
 * CURSOR's `${env:VAR}` also match, turning `"${env:FOO}"` into `"$${FOO}"` — a value
 * no harness interpolates (F5/9). A Cursor-shaped placeholder reaches OpenCode whenever
 * `servers.yaml` still carries one (e.g. written by a pre-F1 version).
 */
function convertVarsBack(value: JsonValue): JsonValue {
  if (typeof value === 'string') {
    return value.replace(/(?<!\$)\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, '${$1}');
  }
  if (Array.isArray(value)) return value.map(convertVarsBack);
  if (isObject(value)) {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value)) out[k] = convertVarsBack(v);
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

/** Deep JSON equality by canonical serialisation (key order is irrelevant here — both sides are arrays). */
function sameJson(a: JsonValue, b: JsonValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The canonical keys each {@link shapeOpenCodeServer} branch emits (FAMILY-AWARE, see the
 * Claude adapter's note). `enabled` is deliberately ABSENT from both: OpenCode's shape
 * always carries an `enabled`, so its value is only a user statement when it DIFFERS from
 * what the shaper emitted — see {@link enabledDrift}.
 */
const OPENCODE_LOCAL_SUPERSEDES = ['type', 'command', 'args', 'env'] as const;

/** The `type` values {@link shapeOpenCodeServer}'s non-passthrough branches emit. */
const OPENCODE_SHAPER_TYPES = new Set(['local', 'remote']);
const OPENCODE_REMOTE_SUPERSEDES = ['type', 'url', 'headers'] as const;

/**
 * What the drifted `enabled` says about canonical `enabled`. The shaper ALWAYS writes one
 * (defaulting to `true`), so a value equal to what it wrote carries no information — the
 * prior canonical `enabled` must survive untouched, including a non-boolean one a user
 * hand-authored (`enabled: maybe` would otherwise be destroyed, F5/12). Only a value that
 * DIFFERS from the compiled one is the user toggling the server.
 */
function enabledDrift(
  drifted: JsonValue | undefined,
  prior: Record<string, JsonValue> | undefined,
): { changed: false } | { changed: true; value: JsonValue } {
  // OpenCode treats an absent `enabled` as `true`, and so does the shaper's default.
  const current: JsonValue = drifted === undefined ? true : drifted;
  const compiled: JsonValue = typeof prior?.enabled === 'boolean' ? prior.enabled : true;
  return sameJson(current, compiled) ? { changed: false } : { changed: true, value: current };
}

/**
 * The inverse of {@link shapeOpenCodeServer}, as an OVERLAY over the prior canonical def
 * (see `mcp-canonical.ts`): `{env:VAR}` → `${VAR}`, `type:'local'|'remote'` translated to
 * `transport`, the single `command` array split back into `command` + `args` — and every
 * OTHER field of the drifted entry carried over verbatim, so a field the user added in
 * `opencode.json` reaches the store rather than being dropped by a whitelist (F5/3).
 *
 * Two places where OpenCode's shape is NOT injective are resolved from the prior def:
 *   - `type:'remote'` maps from BOTH `http` and `sse` — the overlay keeps the prior
 *     `transport` verbatim (F5/4);
 *   - `command:[cmd, ...args]` maps from BOTH `{command:'a', args:['b']}` and
 *     `{command:['a','b']}` — when the flattened array is UNCHANGED from what the prior
 *     def would produce, the prior split is kept verbatim rather than re-guessed.
 */
function unshapeOpenCodeServer(
  def: Record<string, JsonValue>,
  prior: unknown,
  ctx: UnshapeContext,
): UnshapedServer {
  const raw = convertVarsBack(def);
  const canon: Record<string, JsonValue> = isObject(raw) ? raw : {};
  // A `transport` in `opencode.json` can only have come from the shaper's bespoke
  // passthrough, so the entry is already canonical — never re-infer over it (F5/1) —
  // unless it sits beside a `type` the passthrough would never have written. Then the two
  // disagree, the transport is unknowable, and carrying the whole value over verbatim
  // would poison the store with BOTH shapes (a duplicated arg, a harness `type`) (F6/9).
  const conflicting = hasConflictingDiscriminators(canon, OPENCODE_SHAPER_TYPES);
  if (typeof canon.transport === 'string' && !conflicting) return passthroughUnshape(canon, prior);
  if (conflicting) noteConflictingTransport(ctx, canon.transport as string, canon.type as string);

  const priorDef = isJsonObject(prior) ? prior : undefined;
  const enabled = enabledDrift(canon.enabled, priorDef);

  const type =
    typeof canon.type === 'string'
      ? canon.type
      : canon.command !== undefined
        ? 'local'
        : canon.url !== undefined
          ? 'remote'
          : undefined;

  if (type === 'local') {
    const fields: Record<string, JsonValue> = {
      transport: 'stdio',
      ...omitKeys(canon, ['type', 'transport', 'enabled', 'command', 'args']),
    };
    const cmd = canon.command;
    if (
      Array.isArray(cmd) &&
      priorDef !== undefined &&
      sameJson(toCommandArray(priorDef.command, priorDef.args), cmd)
    ) {
      // The user did not touch the command line — keep the prior canonical split.
      if (priorDef.command !== undefined) fields.command = priorDef.command;
      if (priorDef.args !== undefined) fields.args = priorDef.args;
    } else if (Array.isArray(cmd)) {
      if (cmd.length > 0) fields.command = cmd[0]!;
      if (cmd.length > 1) fields.args = cmd.slice(1);
    } else if (cmd !== undefined) {
      fields.command = cmd;
    }
    if (enabled.changed) fields.enabled = enabled.value;
    return {
      fields,
      supersedes: OPENCODE_LOCAL_SUPERSEDES,
      family: 'stdio',
      // `type:'local'` means exactly `transport: stdio` — unless a hand-written
      // `transport` contradicts it, when nothing may be written (F6/9).
      transportAuthority: conflicting ? 'ambiguous' : 'native',
    };
  }

  if (type === 'remote') {
    const fields: Record<string, JsonValue> = {
      transport: 'http',
      ...omitKeys(canon, ['type', 'transport', 'enabled', 'headers']),
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
    if (enabled.changed) fields.enabled = enabled.value;
    return {
      fields,
      supersedes:
        auth.kind === 'delete'
          ? [...OPENCODE_REMOTE_SUPERSEDES, 'auth']
          : OPENCODE_REMOTE_SUPERSEDES,
      family: 'remote',
      // `type:'remote'` maps from BOTH `http` and `sse`, so the `http` above is a GUESS
      // the prior canonical transport overrides (F5/4).
      transportAuthority: conflicting ? 'ambiguous' : 'inferred',
    };
  }
  // Unknown/bespoke OpenCode entry: carry the whole (var-converted) entry over.
  return passthroughUnshape(canon, prior);
}

/** Run `opencode --version`, resolving `true` only on a clean exit 0. Never throws. */
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

/**
 * Point OpenCode at a private root (D15). `XDG_CONFIG_HOME = dirname(root)` is the
 * REAL isolation lever — OpenCode reads `$XDG_CONFIG_HOME/opencode`, and
 * `basename(root) === 'opencode'` (the composer names the view after the adapter
 * id). `OPENCODE_CONFIG_DIR = root` satisfies the frozen `validateAdapter` and is a
 * verified-idempotent redundant re-merge of the same `root/opencode.json`.
 */
function overrideEnv(root: string): OverrideEnv {
  return { [CONFIG_ROOT_ENV]: root, XDG_CONFIG_HOME: dirname(root) };
}

/**
 * The OpenCode adapter instance registered in {@link import('./index.js')}.
 */
export const opencodeAdapter: Adapter = {
  id: 'opencode',
  binaryName: 'opencode',

  sessionSupported: true,

  async detect(env) {
    const bin = await resolveBinaryOnPath('opencode', env);
    if (!bin) return false;
    return versionExitsZero(bin);
  },

  configRootEnv: CONFIG_ROOT_ENV,
  overrideEnv,
  realConfigRoot(env) {
    // OpenCode reads global config from `$XDG_CONFIG_HOME/opencode` (default
    // `~/.config/opencode`), live-confirmed by `opencode debug paths`. A user-set
    // `XDG_CONFIG_HOME` wins; `OPENCODE_CONFIG_DIR` is NOT a relocation, so it is
    // deliberately NOT consulted here.
    const xdg = env.XDG_CONFIG_HOME;
    const base = xdg && xdg.trim() !== '' ? xdg : join(homedir(), '.config');
    return join(base, 'opencode');
  },

  surfaces: SURFACES,

  classifyEntry(name): EntryBucket {
    // Bucket-2 surface targets are managed; EVERYTHING else — node_modules (plugin
    // deps), AGENTS.md/CLAUDE.md (the user's global instructions pass through so the
    // view keeps them), and any file a future OpenCode update introduces — defaults
    // to bucket-1 pass-through. Auth is outside the config root, so no auth case.
    return MANAGED_ENTRIES.has(name) ? 'managed' : 'state';
  },

  async compileConfigKeys(
    surface: ConfigKeysSurface,
    ctx: ConfigKeysContext,
  ): Promise<ConfigKeysInjection[]> {
    if (surface.id === 'mcp') {
      const serversFile = join(ctx.envContentDir, 'mcp', 'servers.yaml');
      if (!existsSync(serversFile)) return [];
      const parsed = parseYaml(await readFile(serversFile, 'utf8')) as
        | Record<string, unknown>
        | null
        | undefined;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
      // One keyed injection per server, owned independently under `mcp` (D3/D6).
      return Object.entries(parsed).map(([name, def]) => {
        const value = shapeOpenCodeServer(def);
        const secretFields: Record<string, string> = {};
        collectPlaceholders(value, '', secretFields);
        return {
          style: 'keyed' as const,
          keyPath: ['mcp', name],
          value,
          ...(Object.keys(secretFields).length > 0 ? { secretFields } : {}),
        };
      });
    }

    if (surface.id === 'instructions') {
      // Append each existing store instruction file's ABSOLUTE path to the
      // `instructions` array (array-element, D3). Absolute paths load (live-verified);
      // removal later matches by this exact value (order-independent).
      const dir = join(ctx.envContentDir, 'instructions');
      const out: ConfigKeysInjection[] = [];
      for (const name of INSTRUCTION_STORE_FILES) {
        const storePath = join(dir, name);
        if (existsSync(storePath)) {
          out.push({ style: 'array-element', arrayPath: ['instructions'], value: storePath });
        }
      }
      return out;
    }

    return [];
  },

  async describeConfigKeysDrift(
    surface: ConfigKeysSurface,
    drift: ConfigKeysDrift,
    ctx: ConfigKeysContext,
  ): Promise<ConfigKeysDriftReport | null> {
    // Classify how one drifted `opencode.json` server (keyPath ['mcp', <name>])
    // disagrees with the canonical D6 def in servers.yaml. `canonicalValue` already has
    // secret {env:VAR} placeholders restored (D6); `unshapeOpenCodeServer` + the OVERLAY
    // map OpenCode's `{env:}`/`type:'local'`/command-array shape back onto canonical, so
    // the report names CANONICAL fields — the ones the user will edit. servers.yaml is
    // READ here and never written. Instructions are array-element (identity IS the
    // value), so that surface never drifts and has nothing to describe.
    if (surface.id !== 'mcp' || drift.style !== 'keyed') return null;
    // A server injection is always keyPath ['mcp', <name>] (length 2); a length-1
    // keyPath would describe a bogus `mcp` "server".
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
        unshape: unshapeOpenCodeServer,
        server: name,
        adapterId: 'opencode',
      }),
    };
  },

  async selfCheck(viewRoot: string, ctx: SelfCheckContext): Promise<SelfCheckResult> {
    const bin = await ctx.resolveBinary();
    if (!bin) return { ok: false, detail: 'opencode not found on PATH' };

    // Learn what the VIEW declares so the probe proves the child observes THIS root.
    // Live-verified: `opencode mcp list` prints one `● ✓|✗ <name>` line per server in
    // `opencode.json` `mcp`, regardless of connect status — a fake local server still
    // appears as "✗ failed", so we match the NAME, never the health. Isolation is
    // real: a relocated view lists ONLY its own servers (the real ~/.config/opencode
    // servers do not leak), so a matched name proves the child read the view.
    const viewServers = await readViewMcpServerNames(viewRoot);

    const res = await ctx.capture(bin, ['mcp', 'list'], {
      ...ctx.env,
      ...overrideEnv(viewRoot),
    });
    const out = `${res.stdout}\n${res.stderr}`;

    if (viewServers.length === 0) {
      // No local server to key off (env contributed no MCP): fall back to a
      // mechanism check — the child ran `mcp list` against the view and returned.
      return res.code === 0
        ? { ok: true }
        : { ok: false, detail: `opencode mcp list exited ${res.code} against ${viewRoot}` };
    }

    const seen = viewServers.some((name) =>
      new RegExp(`(^|\\s)${escapeRegExp(name)}(\\s|$)`).test(out),
    );
    return seen
      ? { ok: true }
      : {
          ok: false,
          detail: `child did not list any of the view's servers [${viewServers.join(', ')}] under ${viewRoot}`,
        };
  },
};

/** Read the top-level `mcp` server names from a view's `opencode.json` (empty on any error). */
async function readViewMcpServerNames(viewRoot: string): Promise<string[]> {
  try {
    const raw = await readFile(join(viewRoot, 'opencode.json'), 'utf8');
    const parsed = JSON.parse(raw) as { mcp?: Record<string, unknown> };
    return isObject(parsed.mcp) ? Object.keys(parsed.mcp) : [];
  } catch {
    return [];
  }
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
