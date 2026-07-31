import type { Adapter } from './adapter.js';
import { driftSweep } from './drift.js';
import { effectiveGlobalEnvs } from './engine.js';
import {
  commitStore,
  describeFindings,
  type GitRunner,
  pullRebase,
  pushStore,
  reconcileManifest,
  storeIsRepo,
  validatePulledStore,
} from './git.js';
import type { Paths } from './paths.js';
import { readSessionRegistry } from './session/registry.js';
import { readState } from './state.js';

/**
 * The git-sync invocation lifecycle (design D9), composing {@link
 * import('./git.js') git plumbing} with the {@link driftSweep 1.7 drift sweep}.
 * Two hooks the command layer wires around a store-touching command:
 *
 * - {@link beginStoreSync} — at the START of an invocation: sweep mid-session
 *   drift, commit it as `agentenv: sync drift`, `git pull --rebase`, then run the
 *   post-pull safeguards (schema-validate + secret-scan + manifest-reconcile)
 *   BEFORE anything materialises.
 * - {@link endStoreSync} — at the END: ONE fail-soft push (queued on failure).
 *
 * Per-mutation commits between the two use {@link import('./git.js').commitStore}
 * directly. EVERYTHING is gated on the store being a git repo: with no repo (or no
 * remote) these are silent no-ops, so a non-synced install and the 400+ existing
 * tests see zero behaviour change.
 */

/** What the START-of-invocation sync did. */
export interface SyncBeforeResult {
  /** The store is a git repo — the sync actually ran. */
  synced: boolean;
  /** A `git pull --rebase` brought (or confirmed) remote history this invocation. */
  pulled: boolean;
  /**
   * The pulled tree is malformed or secret-bearing (D9) — the caller must NOT
   * materialise it onto real surfaces; it stays quarantined in the working tree.
   */
  quarantined: boolean;
}

export interface SyncBeforeRequest {
  paths: Paths;
  env: NodeJS.ProcessEnv;
  /** Adapters in scope, for the drift sweep's session pass + manifest reconcile. */
  adapters: readonly Adapter[];
  /** Sink for user-facing notices (warnings, pull/quarantine reports). */
  onNotice: (message: string) => void;
  /** Injected git runner (tests). Defaults to the real spawn-based runner. */
  gitRun?: GitRunner;
  /**
   * The caller already ran {@link driftSweep} (use/drop do, for non-git hash
   * reconciliation before (de)materialise) — skip the redundant sweep here.
   */
  alreadySwept?: boolean;
  /** Pull network budget (ms). Defaults to git.ts's ~3s. */
  pullTimeoutMs?: number;
}

/**
 * START of a store-touching invocation (design D9). No-op unless the store is a
 * git repo. Never fatal — any unexpected error degrades to a notice so an offline
 * or broken-git invocation still completes its local work.
 */
export async function beginStoreSync(req: SyncBeforeRequest): Promise<SyncBeforeResult> {
  const { paths, env, adapters, onNotice, gitRun } = req;
  if (!(await storeIsRepo(paths))) {
    return { synced: false, pulled: false, quarantined: false };
  }

  try {
    // 1. Sweep mid-session drift into the store working tree (D9), unless the
    //    caller already swept. The sweep writes back inline-block / config-key /
    //    session-view edits; symlink write-throughs are already on disk.
    if (!req.alreadySwept) {
      await driftSweep({ paths, adapters, env, onWarn: onNotice });
    }

    // 2. Commit ALL uncommitted store drift as one `agentenv: sync drift`, BEFORE
    //    pulling, so every mid-session change type is committed within one command.
    const drift = await commitStore(paths, env, 'agentenv: sync drift', gitRun);
    if (drift.status === 'blocked') {
      onNotice(
        'agentenv: BLOCKED committing store drift — a suspected secret is present:\n' +
          `${describeFindings(drift.findings ?? [])}\n` +
          'Remove the secret (use a ${VAR} placeholder) so the drift can be committed.',
      );
    }

    // 3. Pull (rebase, short timeout, silently skipped offline / no-remote).
    const pull = await pullRebase(paths, env, {
      ...(gitRun ? { run: gitRun } : {}),
      ...(req.pullTimeoutMs !== undefined ? { timeoutMs: req.pullTimeoutMs } : {}),
    });
    if (pull.status === 'conflict') {
      onNotice(`agentenv: sync halted — ${pull.detail}. Your store still works locally from the working tree.`);
    } else if (pull.status === 'error') {
      onNotice(`agentenv: pull skipped (${pull.detail ?? 'error'}); working offline from the local store.`);
    }
    const pulled = pull.status === 'ok';

    // 4. Post-pull safeguards, BEFORE anything materialises (D9). Only meaningful
    //    when a pull actually integrated remote history.
    let quarantined = false;
    if (pulled) {
      const validation = await validatePulledStore(paths);
      if (!validation.ok) {
        quarantined = true;
        const parts: string[] = [];
        if (validation.schemaProblems.length > 0) {
          parts.push(`  malformed manifest(s):\n${validation.schemaProblems.map((p) => `    ${p}`).join('\n')}`);
        }
        if (validation.secretFindings.length > 0) {
          parts.push(`  suspected secret(s):\n${describeFindings(validation.secretFindings)}`);
        }
        onNotice(
          'agentenv: QUARANTINED pulled changes — the remote store is malformed or secret-bearing and was ' +
            'NOT materialised (it stays in the working tree for inspection):\n' +
            parts.join('\n'),
        );
      }
      const active = await activeEnvNames(paths);
      const reconcile = await reconcileManifest(paths, active);
      for (const w of reconcile.warnings) onNotice(w);
    }

    return { synced: true, pulled, quarantined };
  } catch (err) {
    // Fail-soft: sync is best-effort; the local command must still complete.
    onNotice(`agentenv: sync (pull phase) skipped — ${(err as Error).message}`);
    return { synced: true, pulled: false, quarantined: false };
  }
}

export interface SyncAfterRequest {
  paths: Paths;
  env: NodeJS.ProcessEnv;
  onNotice: (message: string) => void;
  gitRun?: GitRunner;
  now?: () => number;
}

/**
 * END of a store-touching invocation (design D9): ONE push, after all commits.
 * `git push` sends every unpushed commit, so this also flushes a queue a prior
 * failed invocation left. Failure only queues a retry — never fatal. No-op without
 * a repo/remote.
 */
export async function endStoreSync(req: SyncAfterRequest): Promise<void> {
  const { paths, env, onNotice, gitRun, now } = req;
  if (!(await storeIsRepo(paths))) return;
  try {
    const push = await pushStore(paths, env, {
      ...(gitRun ? { run: gitRun } : {}),
      ...(now ? { now } : {}),
    });
    if (push.status === 'queued') {
      onNotice(
        `agentenv: push deferred (${push.detail ?? 'offline'}) — queued for the next invocation that reaches the remote.`,
      );
    }
  } catch (err) {
    onNotice(`agentenv: push skipped — ${(err as Error).message}`);
  }
}

/**
 * Every env active on this machine — the global stack ∪ manifest owners (D5/global)
 * plus every session-bound env — so {@link reconcileManifest} can warn when any of
 * them was deleted/renamed remotely (D9).
 */
async function activeEnvNames(paths: Paths): Promise<string[]> {
  const manifest = await readState(paths);
  const global = effectiveGlobalEnvs(manifest);
  let sessionEnvs: string[];
  try {
    const registry = await readSessionRegistry(paths);
    sessionEnvs = registry.bindings.flatMap((b) => b.envs);
  } catch {
    sessionEnvs = [];
  }
  return [...new Set([...global, ...sessionEnvs])];
}
