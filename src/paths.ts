import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Absolute filesystem locations that make up an agentenv installation.
 *
 * Every path derives from a single base directory ({@link Paths.base}) so that
 * tests can point the whole tree at a temp dir via `AGENTENV_HOME` and never
 * touch the user's real `~/.agentenv`. Later tasks own most of these entries
 * (state.json — 1.2; secrets.env — 2.4; backups/, live/, shims/ — 1.6/1.7);
 * they are declared here so the resolver stays the one place base paths live.
 */
export interface Paths {
  /** The agentenv base directory: `$AGENTENV_HOME` or `~/.agentenv`. */
  base: string;
  /** The git-synced store repo (`base/store`). */
  store: string;
  /** Where per-environment directories live (`store/environments`). */
  environments: string;
  /** The generated human-facing store README (`store/README.md`). */
  storeReadme: string;
  /** Machine-local write-ahead journal + manifest (task 1.2). */
  state: string;
  /** Serialises the tool's own store/global mutations (task 1.2, design D11). */
  lock: string;
  /** Machine-local `${VAR}` values, never synced (task 2.4). */
  secrets: string;
  /** Content-addressed pre-mutation backups, never synced (task 1.6). */
  backups: string;
  /** Private composed session config roots, derived (task 1.6/1.7). */
  live: string;
  /** PATH shims for supported harness binaries (task 1.7). */
  shims: string;
  /** Directory for a single environment. */
  envDir(name: string): string;
  /** The `env.yaml` manifest for a single environment. */
  envYaml(name: string): string;
}

/**
 * Resolve the agentenv base directory and every path derived from it.
 *
 * `env.AGENTENV_HOME` wins when set to a non-blank value (resolved to an
 * absolute path); otherwise the default is `~/.agentenv`. Pure — it computes
 * strings and never creates or reads anything on disk. `env` is injected
 * (defaulting to `process.env`) so unit tests stay hermetic without mutating
 * global process state.
 */
export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const configured = env.AGENTENV_HOME;
  const base =
    configured && configured.trim() !== ''
      ? resolve(configured.trim())
      : join(homedir(), '.agentenv');

  const store = join(base, 'store');
  const environments = join(store, 'environments');

  return {
    base,
    store,
    environments,
    storeReadme: join(store, 'README.md'),
    state: join(base, 'state.json'),
    lock: join(base, 'lock'),
    secrets: join(base, 'secrets.env'),
    backups: join(base, 'backups'),
    live: join(base, 'live'),
    shims: join(base, 'shims'),
    envDir: (name: string) => join(environments, name),
    envYaml: (name: string) => join(environments, name, 'env.yaml'),
  };
}
