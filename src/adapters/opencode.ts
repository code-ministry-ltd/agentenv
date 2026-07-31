import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type {
  Adapter,
  ConfigKeysContext,
  ConfigKeysDrift,
  ConfigKeysInjection,
  ConfigKeysStoreMutation,
  ConfigKeysSurface,
  EntryBucket,
  OverrideEnv,
  SelfCheckContext,
  SelfCheckResult,
  SurfaceDeclaration,
} from '../adapter.js';
import type { JsonValue } from '../config-keys.js';
import { resolveBinaryOnPath } from '../session/resolve.js';

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
 * `mcp.<name>` object. IDEMPOTENT: an entry already in OpenCode's shape (`type`
 * present, no canonical `transport`) passes through unchanged — this is what makes
 * {@link syncBackConfigKeys}'s verbatim write-back round-trip stably
 * (`compile(syncBack(v)) === v`).
 *
 * Mappings from the canonical model:
 *   stdio → `{ type:'local', command:[command, ...args], enabled:true, env? }`
 *     (OpenCode's `command` is a SINGLE array combining command + args).
 *   http/sse → `{ type:'remote', url, enabled:true, headers? }`, with
 *     `auth.bearer_env: VAR` folded into `Authorization: 'Bearer {env:VAR}'`.
 * `${VAR}` in any string becomes `{env:VAR}` (OpenCode's native passthrough form).
 * A bespoke/unknown transport is passed through (fail-soft), still var-converted.
 */
function shapeOpenCodeServer(def: unknown): JsonValue {
  if (!isObject(def)) return def as JsonValue;
  // Already OpenCode-shaped (has `type`, not the canonical `transport`): idempotent.
  if ('type' in def && !('transport' in def)) return def;

  const transport =
    typeof def.transport === 'string'
      ? def.transport
      : def.command !== undefined
        ? 'stdio'
        : def.url !== undefined
          ? 'http'
          : undefined;

  if (transport === 'stdio') {
    const out: Record<string, JsonValue> = { type: 'local' };
    const command = toCommandArray(def.command, def.args);
    if (command.length > 0) out.command = command;
    out.enabled = true;
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
    out.enabled = true;
    if (Object.keys(headers).length > 0) out.headers = headers;
    return convertVarsDeep(out);
  }

  // Unknown transport: pass the user's authored def through (var-converted only).
  return convertVarsDeep(def);
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

  async syncBackConfigKeys(
    surface: ConfigKeysSurface,
    drift: ConfigKeysDrift,
    ctx: ConfigKeysContext,
  ): Promise<ConfigKeysStoreMutation[]> {
    // Inverse of compileConfigKeys (spec criterion 4), consistent with Claude's D6
    // decision: fold the one drifted server (keyPath ['mcp', <name>]) back into
    // servers.yaml, siblings untouched. `canonicalValue` already has secret
    // {env:VAR} placeholders restored (D6). It is written in OpenCode's normalised
    // shape; because shapeOpenCodeServer is idempotent on that shape, a subsequent
    // compile reproduces it exactly — round-trip stable. Instructions are
    // array-element (identity IS the value), so they carry no drift to sync back.
    if (surface.id !== 'mcp' || drift.style !== 'keyed') return [];
    // A server injection is always keyPath ['mcp', <name>] (length 2); a length-1
    // keyPath would fold a bogus `mcp` "server" into the store.
    if (drift.keyPath.length < 2) return [];
    const name = drift.keyPath[drift.keyPath.length - 1];
    if (typeof name !== 'string') return [];
    const serversFile = join(ctx.envContentDir, 'mcp', 'servers.yaml');
    const existing = existsSync(serversFile)
      ? ((parseYaml(await readFile(serversFile, 'utf8')) as Record<string, unknown> | null) ?? {})
      : {};
    existing[name] = drift.canonicalValue;
    return [{ storeRelativePath: join('mcp', 'servers.yaml'), content: stringifyYaml(existing) }];
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
