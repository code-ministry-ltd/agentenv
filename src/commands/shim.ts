import { resolveAdapter } from '../adapter.js';
import { adapters as realAdapters } from '../adapters/index.js';
import type { Command, RunOptions, RunResult } from '../command.js';
import type { Paths } from '../paths.js';
import { confirmDefault } from '../prompt.js';
import { defaultExecHarness } from '../session/exec.js';
import { launchHarness, type LaunchResult } from '../session/launch.js';
import { resolveProjectRoot, resolveSessionBinding } from '../session/registry.js';
import { resolveBinaryOnPath, sanitisePath } from '../session/resolve.js';
import { environmentExists } from '../store.js';

/**
 * `agentenv __shim <harness> -- <args…>` — the Node side of the PATH shim (D15).
 * The generated shim delegates here; this resolves the shell's binding, composes
 * a view when bound, and execs the real harness. It fails OPEN: an unknown
 * harness, an unreadable registry, or any compose error launches the real binary
 * untouched (the failure paths are the launch core's — see {@link launchHarness}).
 *
 * Internal: users never type it. Hidden from `--help`.
 */
export const shimCommand: Command = {
  name: '__shim',
  usage: '<harness> -- [args…]',
  summary: 'Internal: PATH shim entrypoint',
  hidden: true,

  async run({ args, paths, env, cwd, options }) {
    const binaryName = args[0];
    if (!binaryName) {
      return { stdout: '', stderr: 'agentenv __shim: missing harness name\n', code: 2 };
    }
    const sep = args.indexOf('--');
    const harnessArgs = sep === -1 ? args.slice(1) : args.slice(sep + 1);

    const adapters = options.adapters ?? realAdapters;
    const adapter = resolveAdapter(adapters, binaryName);

    // Unknown harness (no adapter registered): fail open — real binary untouched.
    if (!adapter) {
      return execUnmanaged(paths, binaryName, harnessArgs, env, cwd, options);
    }

    const notices: string[] = [];
    const session = env.AGENTENV_SESSION;
    let envs: string[] | null = null;
    try {
      const projectRoot = await resolveProjectRoot(cwd);
      // A `.agentenv` default (D16) needs a one-time approval to apply. The seam
      // is the shared confirm prompt (real TTY → asks; non-TTY/pipe/agent →
      // declines), so an unapproved file is skipped, never auto-approved.
      const approve = async (req: { file: string; envs: string[] }): Promise<boolean> => {
        const confirm = options.confirm ?? confirmDefault;
        return confirm(
          `agentenv: apply this project's .agentenv default [${req.envs.join(', ')}] (from ${req.file})? ` +
            'One-time approval for this folder. [y/N] ',
        );
      };
      const resolved = await resolveSessionBinding({ paths, session, projectRoot, env, approve, now: options.now });
      if (resolved.note) notices.push(`agentenv: ${resolved.note}`);
      const b = resolved.binding;
      // An explicit `use` binding OR an approved `.agentenv` both compose a view.
      // Neither is global, both run the same missing-env validation below.
      const bindable = resolved.source === 'explicit' || resolved.source === 'agentenv-file';
      if (bindable && b && !b.global && appliesToHarness(b.harnesses, adapter)) {
        // Validate the bound envs — one may have been `rm`'d since the binding was
        // written. Drop a missing env with a notice naming it (D16); if none
        // survive, launch unbound rather than silently composing an empty view.
        const kept: string[] = [];
        for (const e of b.envs) {
          if (await environmentExists(paths, e)) kept.push(e);
          else notices.push(`agentenv: bound environment '${e}' no longer exists — dropping it from this session`);
        }
        if (kept.length > 0) {
          envs = kept;
        } else {
          notices.push(`agentenv: no bound environments remain — launching ${binaryName} unbound`);
          envs = null;
        }
      }
    } catch (err) {
      // Unreadable session registry → fail open: launch unbound (D15).
      notices.push(
        `agentenv: session registry unreadable (${(err as Error).message}) — launching ${binaryName} unbound`,
      );
    }

    let result: LaunchResult;
    try {
      result = await launchHarness({
        paths,
        adapter,
        envs,
        session: session ?? 'no-session',
        args: harnessArgs,
        env,
        cwd,
        execHarness: options.execHarness,
        capture: options.capture,
        now: options.now,
      });
    } catch (err) {
      // Belt-and-suspenders (M2): launchHarness already fails open internally, but
      // ANY unexpected throw at this outermost seam must STILL run the user's real
      // binary untouched — the shim must never brick the tool.
      notices.push(
        `agentenv: launch failed (${(err as Error).message}) — launching ${binaryName} untouched`,
      );
      const passthrough = await execUnmanaged(paths, binaryName, harnessArgs, env, cwd, options);
      const stderr = `${[...notices].join('\n')}\n${passthrough.stderr ?? ''}`;
      return { ...passthrough, stderr };
    }
    return toRunResult(result, notices);
  },
};

/** Whether a binding's optional --harness scoping includes this harness. */
function appliesToHarness(harnesses: string[] | undefined, adapter: { id: string; binaryName: string }): boolean {
  if (!harnesses || harnesses.length === 0) return true;
  return harnesses.includes(adapter.id) || harnesses.includes(adapter.binaryName);
}

/** Exec a harness we have no adapter for: real binary, untouched, shims off PATH. */
async function execUnmanaged(
  paths: Paths,
  binaryName: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  options: RunOptions,
): Promise<RunResult> {
  const exec = options.execHarness ?? defaultExecHarness;
  const bin = await resolveBinaryOnPath(binaryName, env, [paths.shims]);
  if (!bin) {
    return { stdout: '', stderr: `agentenv: '${binaryName}' not found on PATH\n`, code: 127 };
  }
  const sanitisedEnv: NodeJS.ProcessEnv = { ...env, PATH: sanitisePath(env.PATH ?? '', [paths.shims]) };
  const code = await exec({ binaryPath: bin, args, env: sanitisedEnv, cwd });
  return { stdout: '', stderr: '', code };
}

/** Fold a {@link LaunchResult} (+ command-level notices) into a {@link RunResult}. */
export function toRunResult(result: LaunchResult, extraNotices: readonly string[] = []): RunResult {
  const lines = [...extraNotices, ...result.notices];
  return { stdout: '', stderr: lines.length > 0 ? `${lines.join('\n')}\n` : '', code: result.code };
}
