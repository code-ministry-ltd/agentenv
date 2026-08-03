import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type {
  Adapter,
  ConfigKeysContext,
  ConfigKeysDrift,
  ConfigKeysDriftReport,
  ConfigKeysInjection,
  ConfigKeysSurface,
  EntryBucket,
  SelfCheckContext,
  SelfCheckResult,
  SurfaceDeclaration,
} from '../../src/adapter.js';
import {
  describeCanonicalDrift,
  passthroughUnshape,
  reverseCanonicalServer,
} from '../../src/adapters/mcp-canonical.js';
import type { JsonValue } from '../../src/config-keys.js';
import { resolveBinaryOnPath } from '../../src/session/resolve.js';

/** Absolute path to the fake harness node script this fixture launches. */
export const FAKE_HARNESS_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'fake-harness.mjs');

/** The command name the fixture harness is invoked as (shim'd / resolved on PATH). */
export const FIXTURE_BINARY = 'fixture-harness';

/** The env var the fixture harness reads for its config root. */
export const FIXTURE_CONFIG_ENV = 'FIXTURE_CONFIG_DIR';

/**
 * Install an executable `fixture-harness` into `binDir` (a small shell wrapper
 * that execs `node fake-harness.mjs`), so the real PATH-resolution / exec path
 * is exercised end-to-end. Returns the wrapper path; add `binDir` to `PATH`.
 */
export function installFixtureHarness(binDir: string): string {
  mkdirSync(binDir, { recursive: true });
  const wrapper = join(binDir, FIXTURE_BINARY);
  writeFileSync(wrapper, `#!/bin/sh\nexec node ${JSON.stringify(FAKE_HARNESS_SCRIPT)} "$@"\n`);
  chmodSync(wrapper, 0o755);
  return wrapper;
}

export interface FixtureAdapterOptions {
  /** Override the id (default `fixture`). */
  id?: string;
  /** Whether the harness supports session mode (default `true`; `false` mimics Cursor). */
  sessionSupported?: boolean;
  /**
   * Force the self-check result regardless of the composed view — for exercising
   * the fail-closed (no-overrides) launch path. When unset, the self-check runs
   * the real fake harness and compares the observed root.
   */
  forceSelfCheck?: SelfCheckResult;
  /**
   * Mark the MCP config-keys surface as the *substitute* rung (D6, rung 3): a
   * harness that cannot interpolate `${VAR}` itself, so materialisation substitutes
   * literals from secrets.env/the shell into the real config while the manifest keeps
   * the placeholder. Default `false` — passthrough (rung 1), mimicking Claude.
   */
  substituteMcp?: boolean;
}

function makeSurfaces(substituteMcp: boolean): readonly SurfaceDeclaration[] {
  return [
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
      supported: true,
      mechanism: 'file-block',
      rootRelativePath: 'INSTRUCTIONS.md',
      layering: 'inline',
    },
    {
      id: 'mcp',
      storeKind: 'mcp',
      supported: true,
      mechanism: 'config-keys',
      rootRelativePath: 'config.json',
      format: 'json',
      style: 'keyed',
      keyPath: ['mcpServers'],
      // rung selector (D6): true → substitute literals at materialisation.
      ...(substituteMcp ? { substitutePlaceholders: true } : {}),
    },
  ];
}

/** The real-config-root entries the fixture treats as bucket-2 (managed). */
const MANAGED_ENTRIES = new Set(['skills', 'INSTRUCTIONS.md', 'config.json']);

/**
 * Record every string subfield shaped like `${VAR}` as a secret placeholder, keyed
 * by its dot-joined subpath WITHIN the injected value (e.g. `env.TOKEN`). Mirrors a
 * real adapter flagging passthrough secrets so drift write-back restores the
 * placeholder rather than a baked literal (D6).
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
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      // Escape a literal `.`/`\` in the key so the dotted path round-trips through
      // the escape-aware split on BOTH consumers (substitute + restore) — mirrors
      // the real adapter (secret-safety fix).
      const seg = k.replace(/\\/g, '\\\\').replace(/\./g, '\\.');
      collectPlaceholders(v, prefix === '' ? seg : `${prefix}.${seg}`, out);
    }
  }
}

/**
 * The fixture adapter (Task 1.6, Deliver B): a full {@link Adapter} implementation
 * over the fake harness, so the session machinery is testable with no real
 * harness. Exercises all three surface mechanisms (skills→dir-merge,
 * instructions→file-block inline, mcp→config-keys keyed) and both buckets.
 */
export function makeFixtureAdapter(opts: FixtureAdapterOptions = {}): Adapter {
  const id = opts.id ?? 'fixture';
  const sessionSupported = opts.sessionSupported ?? true;
  const surfaces = makeSurfaces(opts.substituteMcp ?? false);

  const overrideEnv = (root: string): Record<string, string> => ({ [FIXTURE_CONFIG_ENV]: root });

  return {
    id,
    binaryName: FIXTURE_BINARY,
    storeToken: 'fixture',
    sessionSupported,
    sessionUnsupportedReason: sessionSupported
      ? undefined
      : 'fixture: session mode disabled (mimics a GUI app) — use --global',

    async detect(env) {
      return (await resolveBinaryOnPath(FIXTURE_BINARY, env)) !== null;
    },

    configRootEnv: FIXTURE_CONFIG_ENV,
    overrideEnv,
    realConfigRoot(env) {
      const configured = env[FIXTURE_CONFIG_ENV];
      if (configured && configured.trim() !== '') return configured;
      return join(homedir(), '.fixture-harness');
    },

    surfaces,

    classifyEntry(name): EntryBucket {
      return MANAGED_ENTRIES.has(name) ? 'managed' : 'state';
    },

    async compileConfigKeys(
      surface: ConfigKeysSurface,
      ctx: ConfigKeysContext,
    ): Promise<ConfigKeysInjection[]> {
      if (surface.id !== 'mcp') return [];
      const serversFile = join(ctx.envContentDir, 'mcp', 'servers.yaml');
      if (!existsSync(serversFile)) return [];
      const parsed = parseYaml(readFileSync(serversFile, 'utf8')) as
        | Record<string, unknown>
        | null
        | undefined;
      if (!parsed || typeof parsed !== 'object') return [];
      // One keyed injection per server, owned independently under mcpServers (D3/D6).
      // A string value shaped like `${VAR}` is a secret placeholder → flag its subpath
      // so drift write-back restores the placeholder, never a baked literal (D6).
      return Object.entries(parsed).map(([name, def]) => {
        const secretFields: Record<string, string> = {};
        collectPlaceholders(def, '', secretFields);
        return {
          style: 'keyed' as const,
          keyPath: ['mcpServers', name],
          value: def as JsonValue,
          ...(Object.keys(secretFields).length > 0 ? { secretFields } : {}),
        };
      });
    },

    async describeConfigKeysDrift(
      surface: ConfigKeysSurface,
      drift: ConfigKeysDrift,
      ctx: ConfigKeysContext,
    ): Promise<ConfigKeysDriftReport | null> {
      // Classify how one drifted server (keyPath ['mcpServers', <name>]) disagrees with
      // the env's canonical servers.yaml — READ ONLY, exactly like a real adapter. The
      // fixture's compile is the identity, so its un-shape is the passthrough.
      if (surface.id !== 'mcp' || drift.style !== 'keyed') return null;
      const name = drift.keyPath[drift.keyPath.length - 1];
      if (typeof name !== 'string') return null;
      const serversFile = join(ctx.envContentDir, 'mcp', 'servers.yaml');
      const existing = existsSync(serversFile)
        ? ((parseYaml(readFileSync(serversFile, 'utf8')) as Record<string, unknown> | null) ?? {})
        : {};
      return {
        entry: name,
        storeRelativePath: join('mcp', 'servers.yaml'),
        changes: describeCanonicalDrift({
          prior: existing[name],
          drifted: drift.canonicalValue,
          unshape: passthroughUnshape,
          server: name,
          adapterId: 'fixture',
        }),
      };
    },

    async reverseConfigKeysDrift(surface, drift, ctx) {
      if (surface.id !== 'mcp' || drift.style !== 'keyed' || drift.keyPath.length < 2) {
        return { kind: 'invalid', reason: 'retained key is not a fixture MCP entry' };
      }
      const name = drift.keyPath.at(-1);
      if (typeof name !== 'string') return { kind: 'invalid', reason: 'MCP entry name is invalid' };
      const serversFile = join(ctx.envContentDir, 'mcp', 'servers.yaml');
      const existing = existsSync(serversFile)
        ? ((parseYaml(readFileSync(serversFile, 'utf8')) as Record<string, unknown> | null) ?? {})
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
        unshape: passthroughUnshape,
        server: name,
        adapterId: 'fixture',
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
      if (opts.forceSelfCheck) return opts.forceSelfCheck;
      const bin = await ctx.resolveBinary();
      if (!bin) return { ok: false, detail: 'fixture harness not found on PATH' };
      const res = await ctx.capture(bin, ['--print-config-root'], {
        ...ctx.env,
        ...overrideEnv(viewRoot),
      });
      const seen = res.stdout.trim();
      return seen === viewRoot
        ? { ok: true }
        : { ok: false, detail: `child observed '${seen}', expected '${viewRoot}'` };
    },
  };
}
