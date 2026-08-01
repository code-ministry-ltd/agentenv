import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
import type { JsonValue } from '../config-keys.js';
import { resolveBinaryOnPath } from '../session/resolve.js';
import {
  describeCanonicalDrift,
  omitKeys,
  hasConflictingDiscriminators,
  passthroughUnshape,
  resolveAuthDrift,
  noteConflictingTransport,
  type UnshapeContext,
  type UnshapedServer,
} from './mcp-canonical.js';

/**
 * The Claude Code adapter — the first real implementation of the frozen
 * {@link Adapter} contract (Task 1.8). Every declaration below is re-verified LIVE
 * against `claude` 2.1.220 (see `docs/harness-claude.md`); the Phase-0 spike
 * (`spike/FINDINGS.md`) proved the isolation and auth-pass-through the composer
 * relies on. Nothing here is engine logic — only Claude's surface declarations and
 * format quirks, dispatched by the shared composer/launch.
 *
 * Config root: `~/.claude/` (relocated wholesale — INCLUDING `.claude.json` — by
 * `CLAUDE_CONFIG_DIR`, confirmed live: an empty root drops the user's `context7`
 * server from `claude mcp list`). Two-bucket split (D15): `.credentials.json` is the
 * single bucket-1 pass-through that keeps the view logged in; the surface targets
 * (`skills`/`agents`/`commands`/`rules`/`.claude.json`) are bucket-2 managed; every
 * other entry (history, projects, todos, caches, plugins, shell-snapshots, …)
 * defaults to bucket-1 pass-through — the safe unknown.
 */

/** The config-root env var that relocates Claude's entire config root (D15). */
const CONFIG_ROOT_ENV = 'CLAUDE_CONFIG_DIR';

/** How long to wait for `claude --version` in {@link detect} before giving up (ms). */
const DETECT_TIMEOUT_MS = 5000;

/**
 * The real-config-root entries Claude composes privately (bucket-2, D15). Every
 * one is also a surface target below; anything NOT here classifies `state`
 * (pass-through), which is the contract's safe default for unknown entries.
 */
const MANAGED_ENTRIES = new Set(['skills', 'agents', 'commands', 'rules', '.claude.json']);

/**
 * Claude's managed surfaces. Skills/agents/commands/rules are per-item dir-merge
 * (rules officially supports symlinks → global instructions need ZERO mutation of
 * the user's CLAUDE.md, D2). MCP is config-keys into `.claude.json`'s top-level
 * `mcpServers` object, keyed style — `.claude.json` is an internal mixed file, so
 * the composer touches only `mcpServers`, seeded from the real file (D15).
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
    // Global instructions go in as a SYMLINK into rules/, not a file-block on
    // CLAUDE.md (D2) — the user's CLAUDE.md is never touched.
    id: 'instructions',
    storeKind: 'instructions',
    supported: true,
    mechanism: 'dir-merge',
    rootRelativePath: 'rules',
    mode: 'symlink',
  },
  {
    id: 'mcp',
    storeKind: 'mcp',
    supported: true,
    mechanism: 'config-keys',
    rootRelativePath: '.claude.json',
    format: 'json',
    style: 'keyed',
    keyPath: ['mcpServers'],
  },
];

/** Is `v` a plain (non-array) object? */
function isObject(v: unknown): v is Record<string, JsonValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Record every string subfield shaped like `${VAR}` as a secret placeholder, keyed
 * by its dot-joined subpath WITHIN the injected value (e.g. `env.GITHUB_TOKEN` or
 * `headers.Authorization`). Mirrors the fixture: Claude interpolates `${VAR}`
 * natively (rung-1 passthrough, D6), so the placeholder is kept and flagged, and
 * drift write-back restores the placeholder rather than a baked literal.
 */
function collectPlaceholders(value: unknown, prefix: string, out: Record<string, string>): void {
  if (typeof value === 'string') {
    if (prefix !== '' && /\$\{[^}]+\}/.test(value)) out[prefix] = value;
    return;
  }
  // Descend ARRAYS too (canonical MCP `args: [...]` holds `${VAR}` as an element):
  // emit a numeric index segment so an array-nested placeholder is flagged and can
  // be restored on write-back, not left as a baked literal (secret-safety fix).
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      collectPlaceholders(v, prefix === '' ? String(i) : `${prefix}.${i}`, out);
    });
    return;
  }
  if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      // Escape a literal `.`/`\` in the key so the dotted path round-trips through
      // the escape-aware split on BOTH consumers (substitute + restore) — a key name
      // containing a dot must not navigate as two segments (secret-safety fix).
      const seg = k.replace(/\\/g, '\\\\').replace(/\./g, '\\.');
      collectPlaceholders(v, prefix === '' ? seg : `${prefix}.${seg}`, out);
    }
  }
}

/**
 * Shape one canonical `mcp/servers.yaml` server (D6) into Claude's `.claude.json`
 * `mcpServers.<name>` object. `servers.yaml` is ALWAYS D6-canonical (F1: every
 * adapter's {@link syncBackConfigKeys} writes canonical, never its harness shape), so
 * the input normally carries `transport`.
 *
 * A HAND-AUTHORED harness-shaped entry (no `transport`, a Claude `type`) is still
 * honoured: `type` is the transport hint, so `{ type: sse, url }` compiles to an SSE
 * server rather than being re-inferred to `http` from the bare `url` (F5/2A — calling
 * an SSE endpoint as HTTP breaks it).
 *
 * Mappings from the canonical model:
 *   stdio → `{ type:'stdio', command, args?, env? }`
 *   http/sse → `{ type, url, headers? }`, with `auth.bearer_env: VAR` folded into an
 *   `Authorization: Bearer ${VAR}` header (rung-1 `${VAR}` passthrough — Claude
 *   interpolates it, no secret leaves the env). A bespoke/unknown transport is
 *   passed through unchanged (fail-soft, never corrupt the user's authored entry).
 */
function shapeClaudeServer(def: unknown): JsonValue {
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
    const out: Record<string, JsonValue> = { type: 'stdio' };
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
    if (isObject(auth) && typeof auth.bearer_env === 'string' && headers.Authorization === undefined) {
      headers.Authorization = `Bearer \${${auth.bearer_env}}`;
    }
    if (Object.keys(headers).length > 0) out.headers = headers;
    return out;
  }

  // Unknown transport: pass the user's authored def through untouched.
  return def;
}

/**
 * A header value shaped `Bearer ${VAR}` → the var name, else null. Tolerant of
 * surrounding/inner whitespace (`Bearer  ${ X }`), which a user's hand-edit easily
 * introduces and which must not silently cost them their `auth.bearer_env`.
 */
function bearerEnvFromHeader(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = /^\s*Bearer\s+\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\s*$/.exec(value);
  return m ? m[1]! : null;
}

/**
 * The canonical keys each {@link shapeClaudeServer} BRANCH emits, so their absence from a
 * drifted entry is a real user deletion. The lists are FAMILY-AWARE (F6/6): the stdio
 * branch never writes `url`/`headers`, so it may not delete them, and the remote branch
 * never writes `command`/`args`/`env`, so it may not delete those. A genuine family change
 * is handled by the overlay, which drops the departed family's keys wholesale. Every OTHER
 * canonical field (`enabled`, `timeout`, anything a future release adds) is preserved from
 * the prior def. `auth` is added conditionally (see below).
 */
const CLAUDE_STDIO_SUPERSEDES = ['type', 'command', 'args', 'env'] as const;

/** The `type` values {@link shapeClaudeServer}'s non-passthrough branches emit. */
const CLAUDE_SHAPER_TYPES = new Set(['stdio', 'http', 'sse']);
const CLAUDE_REMOTE_SUPERSEDES = ['type', 'url', 'headers'] as const;

/**
 * The inverse of {@link shapeClaudeServer}, as an OVERLAY over the prior canonical def
 * (see `mcp-canonical.ts`): translate Claude's `type`/`headers` shape back to canonical
 * `transport`/`auth` and carry EVERY other field of the drifted entry over verbatim, so
 * a field the user added in `.claude.json` reaches the store instead of being dropped by
 * a whitelist (F5/3). What Claude cannot express is preserved from the prior def, and a
 * bespoke `transport` the shaper passed through is never re-inferred (F5/1).
 */
function unshapeClaudeServer(
  def: Record<string, JsonValue>,
  prior: unknown,
  ctx: UnshapeContext,
): UnshapedServer {
  // A `transport` in `.claude.json` can only have come from the shaper's bespoke
  // passthrough, so the entry is already canonical — never re-infer over it (F5/1)…
  const conflicting = hasConflictingDiscriminators(def, CLAUDE_SHAPER_TYPES);
  if (typeof def.transport === 'string' && !conflicting) return passthroughUnshape(def, prior);
  // …unless it sits beside a `type` the passthrough would never have written, in which
  // case the two disagree and the transport is unknowable (F6/9).
  if (conflicting) noteConflictingTransport(ctx, def.transport as string, def.type as string);

  // Claude records the http/sse distinction NATIVELY in `type`, so a `type` the user
  // edited must PROPAGATE — preserving the prior canonical transport here would rewrite
  // their edit back on the next `use` (F6/1). Only a `type`-less entry is a guess.
  const nativeType = typeof def.type === 'string';
  const type = nativeType
    ? (def.type as string)
    : def.command !== undefined
      ? 'stdio'
      : def.url !== undefined
        ? 'http'
        : undefined;

  if (type === 'stdio') {
    return {
      fields: { transport: 'stdio', ...omitKeys(def, ['type', 'transport']) },
      supersedes: CLAUDE_STDIO_SUPERSEDES,
      family: 'stdio',
      // `stdio` is unambiguous in every direction — nothing else compiles to a `command`.
      transportAuthority: conflicting ? 'ambiguous' : 'native',
    };
  }
  if (type === 'http' || type === 'sse') {
    const fields: Record<string, JsonValue> = {
      transport: type,
      ...omitKeys(def, ['type', 'transport', 'headers']),
    };
    const headers = isObject(def.headers) ? { ...def.headers } : undefined;
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
    } else if (def.headers !== undefined) {
      fields.headers = def.headers; // not an object — carry verbatim, never guess
    }
    return {
      fields,
      supersedes:
        auth.kind === 'delete' ? [...CLAUDE_REMOTE_SUPERSEDES, 'auth'] : CLAUDE_REMOTE_SUPERSEDES,
      family: 'remote',
      transportAuthority: conflicting ? 'ambiguous' : nativeType ? 'native' : 'inferred',
    };
  }
  // Neither a Claude discriminator nor an inferable one: carry the whole entry over.
  return passthroughUnshape(def, prior);
}

/** Run `claude --version`, resolving `true` only on a clean exit 0. Never throws. */
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

/** Point Claude at a private root (D15): the single `CLAUDE_CONFIG_DIR` override. */
function overrideEnv(root: string): Record<string, string> {
  return { [CONFIG_ROOT_ENV]: root };
}

/**
 * The Claude Code adapter instance registered in {@link import('./index.js')}.
 */
export const claudeAdapter: Adapter = {
  id: 'claude-code',
  binaryName: 'claude',

  sessionSupported: true,

  async detect(env) {
    const bin = await resolveBinaryOnPath('claude', env);
    if (!bin) return false;
    return versionExitsZero(bin);
  },

  configRootEnv: CONFIG_ROOT_ENV,
  overrideEnv,
  realConfigRoot(env) {
    const configured = env[CONFIG_ROOT_ENV];
    if (configured && configured.trim() !== '') return configured;
    return join(homedir(), '.claude');
  },

  surfaces: SURFACES,

  classifyEntry(name): EntryBucket {
    // Bucket-2 surface targets are managed; EVERYTHING else — `.credentials.json`,
    // history, projects, todos, statsig, caches, plugins, shell-snapshots, and any
    // file a future Claude update introduces — defaults to bucket-1 pass-through.
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
      const value = shapeClaudeServer(def);
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
    // Classify how one drifted `.claude.json` server (keyPath ['mcpServers', <name>])
    // disagrees with the canonical D6 def in servers.yaml. `canonicalValue` already has
    // secret ${VAR} placeholders restored (D6); `unshapeClaudeServer` + the OVERLAY map
    // Claude's `type`/`headers` shape back onto canonical, so the report names CANONICAL
    // fields — the ones the user will edit. servers.yaml is READ here and never written.
    if (surface.id !== 'mcp' || drift.style !== 'keyed') return null;
    // A server injection is always keyPath ['mcpServers', <name>] (length 2); a
    // length-1 keyPath would describe a bogus `mcpServers` "server".
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
        unshape: unshapeClaudeServer,
        server: name,
        adapterId: 'claude-code',
      }),
    };
  },

  async selfCheck(viewRoot: string, ctx: SelfCheckContext): Promise<SelfCheckResult> {
    const bin = await ctx.resolveBinary();
    if (!bin) return { ok: false, detail: 'claude not found on PATH' };

    // Learn what the VIEW declares so the probe proves the child observes THIS root
    // (not the real one). Live-verified: `claude mcp list` prints one `<name>: …`
    // line per server in `.claude.json` mcpServers, regardless of connect status —
    // a fake stdio server still appears as "✘ Failed to connect", so we match the
    // NAME, never the health. The claude.ai account's remote MCP servers appear in
    // every authenticated view (auth-scoped, not config-scoped) — they are NOT in
    // `.claude.json` mcpServers, so they are correctly excluded from the match set.
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
        : { ok: false, detail: `claude mcp list exited ${res.code} against ${viewRoot}` };
    }

    const seen = viewServers.some((name) =>
      new RegExp(`(^|\\n)\\s*${escapeRegExp(name)}:`).test(out),
    );
    return seen
      ? { ok: true }
      : {
          ok: false,
          detail: `child did not list any of the view's servers [${viewServers.join(', ')}] under ${viewRoot}`,
        };
  },
};

/** Read the top-level `mcpServers` names from a view's `.claude.json` (empty on any error). */
async function readViewMcpServerNames(viewRoot: string): Promise<string[]> {
  try {
    const raw = await readFile(join(viewRoot, '.claude.json'), 'utf8');
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    return isObject(parsed.mcpServers) ? Object.keys(parsed.mcpServers) : [];
  } catch {
    return [];
  }
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
