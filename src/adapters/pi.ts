import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Adapter,
  ConfigKeysContext,
  ConfigKeysInjection,
  ConfigKeysSurface,
  EntryBucket,
  SelfCheckContext,
  SelfCheckResult,
  SurfaceDeclaration,
} from '../adapter.js';
import type { JsonValue } from '../config-keys.js';
import { userHome, type AdapterV2 } from '../adapter-v2.js';
import { resolveBinaryOnPath } from '../session/resolve.js';

/**
 * The Pi adapter (`@earendil-works/pi-coding-agent`, pi.dev — Task 4.3). Every
 * declaration below is re-verified LIVE against `pi` 0.80.3 (see `docs/harness-pi.md`);
 * nothing here is engine logic — only Pi's surface declarations and format quirks,
 * dispatched by the shared composer/launch.
 *
 * Config root: **`~/.pi/agent/`** (NOT `~/.pi/` — a bare `~/.pi/skills/` is dead
 * weight), relocated wholesale by `PI_CODING_AGENT_DIR` (confirmed live: `pi list`
 * reads `settings.json.packages` from the relocated root). Two-bucket split (D15):
 * `auth.json` + `trust.json` are the bucket-1 pass-throughs that keep the view
 * authenticated and its project-trust records intact; the surface targets
 * (`skills`/`prompts`/`AGENTS.md`/`settings.json`) are bucket-2 managed; every other
 * entry (`extensions/`, session state, `SYSTEM.md`, caches, and anything a future Pi
 * update introduces) defaults to bucket-1 pass-through — the safe unknown.
 *
 * Surfaces:
 *   - **skills** → dir-merge into the in-root `skills/` (symlinks live-verified to be
 *     followed AND loaded; env skills go in-root, NEVER `~/.agents/skills/`, D15).
 *   - **instructions** → file-block **inline** on `AGENTS.md` (Pi has no include
 *     syntax; drift in the inline block writes back to the store, D2).
 *   - **prompts** → dir-merge into `prompts/` (filename = `/command`), fed by the
 *     canonical `commands/` store content.
 *   - **settings** → config-keys **array-element** on `settings.json`'s resource
 *     arrays (`packages`/`extensions`/`skills`/`prompts`/`themes`) — element-level
 *     ownership, by value, order-independent (D3).
 *   - **mcp** → **UNSUPPORTED**: Pi has no native MCP (explicit design stance). The
 *     surface is declared `supported: false` so `status` reports it per harness
 *     rather than pretending (D6); the composer/engine skip it.
 */

/** The config-root env var that relocates Pi's entire config root (D15). */
const CONFIG_ROOT_ENV = 'PI_CODING_AGENT_DIR';

/** How long to wait for `pi --version` in {@link detect} before giving up (ms). */
const DETECT_TIMEOUT_MS = 5000;

/**
 * The Pi settings.json resource arrays agentenv owns element-by-element (D3). Each is
 * a top-level array of resource references; ownership is surface + array path + exact
 * value, so removal matches by value and a harness reorder is harmless.
 */
const PI_SETTINGS_ARRAYS = ['packages', 'extensions', 'skills', 'prompts', 'themes'] as const;

/**
 * The real-config-root entries Pi composes privately (bucket-2, D15). Every one is a
 * surface target below; anything NOT here classifies `state` (pass-through), the
 * contract's safe default for unknown entries. `MCP_SENTINEL` is included ONLY to
 * satisfy the frozen `validateAdapter` invariant that EVERY surface target — even an
 * unsupported one — must classify `managed`; it names no real Pi file (Pi has no MCP),
 * so classifying it managed has zero runtime effect. See the interface-gap note in
 * `docs/harness-pi.md`.
 */
const MCP_SENTINEL = '.agentenv-mcp-unsupported';
const MANAGED_ENTRIES = new Set<string>([
  'skills',
  'prompts',
  'AGENTS.md',
  'settings.json',
  MCP_SENTINEL,
]);

/** Pi's managed surfaces (see the module doc for the mapping). */
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
    // Inline AGENTS.md (Pi has no @import syntax): the managed region layers the
    // user's content and the env's, drift writes back to the store (D2).
    id: 'instructions',
    storeKind: 'instructions',
    supported: true,
    mechanism: 'file-block',
    rootRelativePath: 'AGENTS.md',
    layering: 'inline',
  },
  {
    // Pi's slash-command prompts live in prompts/*.md (filename = /command), fed by
    // the canonical `commands/` store content.
    id: 'prompts',
    storeKind: 'commands',
    supported: true,
    mechanism: 'dir-merge',
    rootRelativePath: 'prompts',
    mode: 'symlink',
  },
  {
    // settings.json resource ARRAYS, element-level ownership (D3, array-element).
    // keyPath is nominal for array-element (the authoritative array path travels on
    // each injection); compileConfigKeys emits one injection per element per array.
    id: 'settings',
    storeKind: 'files',
    supported: true,
    mechanism: 'config-keys',
    rootRelativePath: 'settings.json',
    format: 'json',
    style: 'array-element',
    keyPath: ['packages'],
  },
  {
    // Pi has NO native MCP (verified zero SDK refs). Declared unsupported so `status`
    // says so per harness (D6); skipped by the composer/engine. rootRelativePath is a
    // sentinel that names no real Pi file (see MANAGED_ENTRIES).
    id: 'mcp',
    storeKind: 'mcp',
    supported: false,
    unsupportedReason: 'Pi has no native MCP (use ~/.agentenv MCP on another harness, or a Pi extension)',
    mechanism: 'config-keys',
    rootRelativePath: MCP_SENTINEL,
    format: 'json',
    style: 'keyed',
    keyPath: ['mcpServers'],
  },
];

export const piDefinition: AdapterV2 = {
  version: 2,
  id: 'pi',
  binaryName: 'pi',
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
      id: 'prompts',
      storeKind: 'commands',
      composition: { mechanism: 'dir-merge', mode: 'symlink' },
      session: {
        supported: true,
        destination: { root: 'view', relativePath: 'prompts' },
        writer: 'direct',
        hotReload: true,
        adopt: true,
      },
      global: {
        supported: true,
        destination: { root: 'config', relativePath: 'prompts' },
        writer: 'projection',
        hotReload: true,
        adopt: true,
      },
    },
    {
      id: 'settings',
      storeKind: 'files',
      composition: {
        mechanism: 'config-keys',
        format: 'json',
        style: 'array-element',
        keyPath: ['packages'],
      },
      session: {
        supported: true,
        destination: { root: 'view', relativePath: 'settings.json' },
        writer: 'direct',
        inheritUserContent: true,
      },
      global: {
        supported: true,
        destination: { root: 'config', relativePath: 'settings.json' },
        writer: 'projection',
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
      session: { supported: false, reason: 'Pi has no native MCP support' },
      global: { supported: false, reason: 'Pi has no native MCP support' },
    },
  ],
  rawMappings: [],
};

/** Is `v` a plain (non-array) object? */
function isObject(v: unknown): v is Record<string, JsonValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Run `pi --version`, resolving `true` only on a clean exit 0. Never throws. */
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

/** Point Pi at a private root (D15): the single `PI_CODING_AGENT_DIR` override. */
function overrideEnv(root: string): Record<string, string> {
  return { [CONFIG_ROOT_ENV]: root };
}

/** Read the canonical settings-array store file for an env (`{}` on any error/absence). */
async function readEnvSettings(envContentDir: string): Promise<Record<string, JsonValue>> {
  const settingsFile = join(envContentDir, 'files', 'settings.json');
  if (!existsSync(settingsFile)) return {};
  const parsed = JSON.parse(await readFile(settingsFile, 'utf8')) as unknown;
  return isObject(parsed) ? parsed : {};
}

/**
 * The Pi adapter instance registered in {@link import('./index.js')}.
 */
export const piAdapter: Adapter = {
  id: 'pi',
  binaryName: 'pi',
  definition: piDefinition,

  sessionSupported: true,

  async detect(env) {
    const bin = await resolveBinaryOnPath('pi', env);
    if (!bin) return false;
    return versionExitsZero(bin);
  },

  configRootEnv: CONFIG_ROOT_ENV,
  overrideEnv,
  realConfigRoot(env) {
    const configured = env[CONFIG_ROOT_ENV];
    if (configured && configured.trim() !== '') return configured;
    // Config root is ~/.pi/agent/, NOT ~/.pi/ (the bare ~/.pi/skills/ is not a load
    // location — live-verified against 0.80.3).
    return join(userHome(env), '.pi', 'agent');
  },

  surfaces: SURFACES,

  classifyEntry(name): EntryBucket {
    // Bucket-2 surface targets are managed; EVERYTHING else — `auth.json` (login),
    // `trust.json` (project-trust records agentenv does NOT manage — pure pass-through,
    // D15), `extensions/`, `SYSTEM.md`/`APPEND_SYSTEM.md`, session state, caches, and
    // any file a future Pi update introduces — defaults to bucket-1 pass-through.
    return MANAGED_ENTRIES.has(name) ? 'managed' : 'state';
  },

  async compileConfigKeys(
    surface: ConfigKeysSurface,
    ctx: ConfigKeysContext,
  ): Promise<ConfigKeysInjection[]> {
    // Only the settings surface compiles (MCP is unsupported and never reaches here).
    if (surface.id !== 'settings') return [];
    const settings = await readEnvSettings(ctx.envContentDir);
    const out: ConfigKeysInjection[] = [];
    // One array-element injection per element of each owned resource array. The value
    // is a plain store reference (a package/skill/prompt path) — no secret, no
    // transform — so array-element by-value ownership needs no secretFields (D3/D6).
    for (const arrName of PI_SETTINGS_ARRAYS) {
      const arr = settings[arrName];
      if (!Array.isArray(arr)) continue;
      for (const value of arr) {
        out.push({ style: 'array-element', arrayPath: [arrName], value });
      }
    }
    return out;
  },

  // NO `describeConfigKeysDrift`. Pi's only config-keys surface is `settings`, which is
  // array-element: ownership is BY VALUE, so a drifted element reads as ABSENT rather
  // than as a mutated value and `config-keys.syncBack` never reports drift for it (see
  // its `mode === 'array-element'` branch). There is therefore no drift for this adapter
  // to classify. Pi's MCP surface is declared unsupported (no native MCP), so the MCP
  // report path does not apply either.

  async selfCheck(viewRoot: string, ctx: SelfCheckContext): Promise<SelfCheckResult> {
    const bin = await ctx.resolveBinary();
    if (!bin) return { ok: false, detail: 'pi not found on PATH' };

    // Learn what the VIEW declares so the probe proves the child observes THIS root.
    // Live-verified: `pi list` prints one indented line per package in the relocated
    // root's `settings.json.packages`, offline and without mutating the file — the Pi
    // analog of Claude's `claude mcp list`. We match a package NAME, never health.
    const viewPackages = await readViewPackages(viewRoot);

    const res = await ctx.capture(bin, ['list', '--no-approve'], {
      ...ctx.env,
      ...overrideEnv(viewRoot),
      // Offline-robust: never let a probe reach the network (M3 hard-time still applies).
      PI_OFFLINE: '1',
    });
    const out = `${res.stdout}\n${res.stderr}`;

    if (viewPackages.length === 0) {
      // No local package to key off (env contributed no settings packages): fall back
      // to a mechanism check — the child ran `pi list` against the view and returned.
      return res.code === 0
        ? { ok: true }
        : { ok: false, detail: `pi list exited ${res.code} against ${viewRoot}` };
    }

    const seen = viewPackages.some((name) => out.includes(name));
    return seen
      ? { ok: true }
      : {
          ok: false,
          detail: `child did not list any of the view's packages [${viewPackages.join(', ')}] under ${viewRoot}`,
        };
  },
};

/** Read the `settings.json` `packages` array from a view root (empty on any error). */
async function readViewPackages(viewRoot: string): Promise<string[]> {
  try {
    const raw = await readFile(join(viewRoot, 'settings.json'), 'utf8');
    const parsed = JSON.parse(raw) as { packages?: unknown };
    return Array.isArray(parsed.packages)
      ? parsed.packages.filter((p): p is string => typeof p === 'string')
      : [];
  } catch {
    return [];
  }
}
