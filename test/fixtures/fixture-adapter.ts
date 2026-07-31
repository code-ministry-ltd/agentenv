import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type {
  Adapter,
  ConfigKeysInjection,
  ConfigKeysSurface,
  EntryBucket,
  SelfCheckContext,
  SelfCheckResult,
  SurfaceDeclaration,
} from '../../src/adapter.js';
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
}

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
  },
];

/** The real-config-root entries the fixture treats as bucket-2 (managed). */
const MANAGED_ENTRIES = new Set(['skills', 'INSTRUCTIONS.md', 'config.json']);

/**
 * The fixture adapter (Task 1.6, Deliver B): a full {@link Adapter} implementation
 * over the fake harness, so the session machinery is testable with no real
 * harness. Exercises all three surface mechanisms (skills→dir-merge,
 * instructions→file-block inline, mcp→config-keys keyed) and both buckets.
 */
export function makeFixtureAdapter(opts: FixtureAdapterOptions = {}): Adapter {
  const id = opts.id ?? 'fixture';
  const sessionSupported = opts.sessionSupported ?? true;

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

    surfaces: SURFACES,

    classifyEntry(name): EntryBucket {
      return MANAGED_ENTRIES.has(name) ? 'managed' : 'state';
    },

    async compileConfigKeys(
      surface: ConfigKeysSurface,
      envContentDir: string,
    ): Promise<ConfigKeysInjection[]> {
      if (surface.id !== 'mcp') return [];
      const serversFile = join(envContentDir, 'mcp', 'servers.yaml');
      if (!existsSync(serversFile)) return [];
      const parsed = parseYaml(readFileSync(serversFile, 'utf8')) as
        | Record<string, unknown>
        | null
        | undefined;
      if (!parsed || typeof parsed !== 'object') return [];
      // One keyed injection per server, owned independently under mcpServers (D3/D6).
      return Object.entries(parsed).map(([name, def]) => ({
        style: 'keyed' as const,
        keyPath: ['mcpServers', name],
        value: def as JsonValue,
      }));
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
