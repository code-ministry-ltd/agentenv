import type { Adapter, SelfCheckContext } from '../adapter.js';
import type { Paths } from '../paths.js';
import { readState } from '../state.js';
import { composeView, type SurfaceSkip } from './composer.js';
import { defaultCapture, defaultExecHarness, type CaptureFn, type ExecHarness } from './exec.js';
import { resolveBinaryOnPath, sanitisePath } from './resolve.js';

/**
 * The launch core (D15) shared by `agentenv run` and the shim's `__shim` command.
 * It takes an already-resolved adapter and an already-decided binding (the
 * registry lookup lives in the shim command; `run` supplies the env stack
 * directly), and decides HOW to launch:
 *
 * - **unbound** (no env stack) → exec the real binary completely untouched.
 * - **session-unsupported adapter** (Cursor) → exec untouched + a `--global` notice.
 * - **fail-open** — ANY agentenv-side error (corrupt state.json, missing store,
 *   a compose failure) → one-line warning + exec untouched with ZERO overrides.
 *   The user's daily tools must never be bricked by agentenv's own state.
 * - **fail-closed for APPLYING** — after composing, the adapter's self-check must
 *   prove the child observes the intended root; if it can't, treat the harness as
 *   session-unsupported FOR THIS LAUNCH (exec untouched + notice). Never a
 *   half-applied view.
 * - **applied** — compose the view and exec the real binary with the adapter's
 *   config-root overrides.
 */

export type LaunchMode =
  | 'applied'
  | 'unbound'
  | 'session-unsupported'
  | 'self-check-failed'
  | 'fail-open';

export interface LaunchResult {
  /** The child's exit code (127 if the real binary could not be found/executed). */
  code: number;
  /** How the launch was decided. */
  mode: LaunchMode;
  /** Whether config-root overrides were applied. */
  applied: boolean;
  /** The composed view root, when one was built. */
  viewRoot?: string;
  /** The resolved real binary, when found. */
  binaryPath?: string;
  /** Surfaces skipped during composition (for `status`). */
  skipped: SurfaceSkip[];
  /** One-line notices/warnings the caller should print to stderr. */
  notices: string[];
}

export interface LaunchRequest {
  paths: Paths;
  adapter: Adapter;
  /** The env stack to compose, or `null`/empty for an unbound launch. */
  envs: readonly string[] | null;
  /** The `live/<session>/` key the view is published under. */
  session: string;
  /** Args to pass through to the harness. */
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Seams (injected in tests). */
  execHarness?: ExecHarness;
  capture?: CaptureFn;
  now?: () => number;
}

export async function launchHarness(req: LaunchRequest): Promise<LaunchResult> {
  const { paths, adapter, args, env, cwd } = req;
  const execHarness = req.execHarness ?? defaultExecHarness;
  const capture = req.capture ?? defaultCapture;
  const notices: string[] = [];

  // The child always runs with agentenv's shim dirs stripped from PATH, so it
  // resolves the REAL binary (never re-enters the shim) — bound or not.
  const sanitisedEnv: NodeJS.ProcessEnv = {
    ...env,
    PATH: sanitisePath(env.PATH ?? '', [paths.shims]),
  };

  const binaryPath = await resolveBinaryOnPath(adapter.binaryName, env, [paths.shims]);
  if (!binaryPath) {
    notices.push(`agentenv: '${adapter.binaryName}' not found on PATH — cannot launch`);
    return { code: 127, mode: 'unbound', applied: false, skipped: [], notices };
  }

  const execUntouched = async (mode: LaunchMode): Promise<LaunchResult> => {
    const code = await execHarness({ binaryPath, args, env: sanitisedEnv, cwd });
    return { code, mode, applied: false, binaryPath, skipped: [], notices };
  };

  const bound = req.envs && req.envs.length > 0;
  if (!bound) return execUntouched('unbound');

  // A harness that cannot inherit a shell environment (Cursor) has no session
  // path: launch untouched and point the user at global mode (D11/D15).
  if (!adapter.sessionSupported) {
    notices.push(
      `agentenv: ${adapter.id} does not support session mode` +
        `${adapter.sessionUnsupportedReason ? ` (${adapter.sessionUnsupportedReason})` : ''} — ` +
        `launching without an environment; use 'agentenv use … --global' to activate globally`,
    );
    return execUntouched('session-unsupported');
  }

  // — the APPLYING path — anything broken here fails OPEN (never brick the tool).
  let viewRoot: string;
  let skipped: SurfaceSkip[];
  try {
    // Reading state.json here is both the --global dedup source and a health
    // probe: a corrupt manifest throws → caught below → fail-open.
    const manifest = await readState(paths);
    const ownedRealPaths = new Set(manifest.items.map((i) => i.path));
    const realConfigRoot = adapter.realConfigRoot(env);

    const composed = await composeView({
      paths,
      adapter,
      envs: req.envs!,
      session: req.session,
      realConfigRoot,
      // The launch cwd is the project root an adapter keys project-scoped config
      // by (Codex trust); thread it through to config-keys compilation (H3).
      projectRoot: cwd,
      isGloballyOwned: (p) => ownedRealPaths.has(p),
      // The shell env resolves the substitute rung's ${VAR} over secrets.env (D6).
      env,
      now: req.now,
      onWarn: (m) => notices.push(m),
    });
    viewRoot = composed.viewRoot;
    skipped = composed.skipped;
  } catch (err) {
    notices.push(
      `agentenv: could not compose a session view (${(err as Error).message}) — ` +
        `launching ${adapter.binaryName} without overrides`,
    );
    return execUntouched('fail-open');
  }

  // Fail-closed: prove the child observes the intended root before applying.
  const ctx: SelfCheckContext = {
    resolveBinary: () => resolveBinaryOnPath(adapter.binaryName, env, [paths.shims]),
    capture,
    env: sanitisedEnv,
  };
  let check;
  try {
    check = await adapter.selfCheck(viewRoot, ctx);
  } catch (err) {
    notices.push(
      `agentenv: ${adapter.id} self-check errored (${(err as Error).message}) — ` +
        `launching without overrides`,
    );
    return execUntouched('fail-open');
  }
  if (!check.ok) {
    notices.push(
      `agentenv: ${adapter.id} could not be proven session-safe` +
        `${check.detail ? ` (${check.detail})` : ''} — launching without overrides; use --global`,
    );
    return execUntouched('self-check-failed');
  }

  // Applied: exec the real binary pointed at the private view.
  const execEnv: NodeJS.ProcessEnv = { ...sanitisedEnv, ...adapter.overrideEnv(viewRoot) };
  const code = await execHarness({ binaryPath, args, env: execEnv, cwd });
  return { code, mode: 'applied', applied: true, viewRoot, binaryPath, skipped, notices };
}
