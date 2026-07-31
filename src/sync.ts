import type { Adapter } from './adapter.js';
import { adoptSweep, singular } from './adopt.js';
import { driftSweep } from './drift.js';
import { effectiveGlobalEnvs } from './engine.js';
import {
  clearConflictMarker,
  commitStore,
  describeFindings,
  type GitRunner,
  type PushResult,
  pullRebase,
  pushStore,
  rebaseInProgress,
  reconcileManifest,
  storeIsRepo,
  validatePulledStore,
  writeConflictMarker,
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
  /**
   * The pull hit a rebase conflict (D9, Task 2.2): 2.1 already `--abort`ed it so the
   * working tree stays usable, and a machine-local conflict marker is now set so
   * `agentenv status` surfaces "sync blocked" and `agentenv sync --resolve` can walk
   * the user through it. The local command still completes from the working tree.
   */
  conflicted: boolean;
  /**
   * A `sync --resolve` two-step is HELD in progress (a real `git rebase` sits on
   * disk across invocations) — so this invocation did NOT drift-commit / pull / push,
   * to keep the mid-rebase index untouched (D9, Task 2.2). The caller's OWN local
   * mutation still lands on disk; only the git index/commit/pull/push is skipped.
   * Only `sync --resolve` / `--abort` may ever advance a held rebase.
   */
  paused: boolean;
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
  /**
   * Suppress the per-invocation auto-adopt sweep (D10). Set by the commands that
   * manage adoption THEMSELVES (`capture`, `adopt`, `disown`) so the lifecycle
   * does not double-adopt behind them. Default (unset) → the sweep runs, which is
   * a fast no-op unless a surface was snapshotted (see {@link adoptSweep}).
   */
  skipAdopt?: boolean;
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
    return { synced: false, pulled: false, quarantined: false, conflicted: false, paused: false };
  }

  // A HELD rebase (a `sync --resolve` two-step in progress) must never be disturbed by
  // another store-touching command (D9, Task 2.2, criterion 11). Do NOT drift-commit /
  // pull / push: `commitStore`'s `git add -A` would stage the conflict-marker-laden
  // working tree and commit garbage that then pushes to the shared remote. Keep the
  // conflict marker set, flag the result `paused`, and let the caller's OWN local
  // mutation still land on disk — only the git index/commit/pull/push is skipped. Only
  // `sync --resolve` / `--abort` may ever advance a held rebase.
  if (await rebaseInProgress(paths)) {
    onNotice(
      'agentenv: sync paused mid-conflict — a `agentenv sync --resolve` is in progress. ' +
        'Finish it with `agentenv sync --resolve`, or cancel with `agentenv sync --abort`. ' +
        'Your change is saved locally in the store working tree.',
    );
    return { synced: true, pulled: false, quarantined: false, conflicted: true, paused: true };
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
          'Remove the secret (use a ${VAR} placeholder) so the drift can be committed. ' +
          'If it is a documented example, mark the line `agentenv:allow-secret`.',
      );
    }

    // 2b. Auto-adopt sweep (D10): a NEW item an agent created inside an activated
    //     managed dir since the last snapshot is moved into the store, symlinked
    //     back, owned, and committed under its OWN `agentenv: adopt <kind> <name>
    //     → <env>` message — run AFTER the `sync drift` commit so each adoption
    //     commit is isolated (the tree is clean between them). Guardrails apply in
    //     adoptSweep; the lifecycle sweep is NON-interactive, so secret-bearing
    //     items DECLINE (never silently adopted) — `agentenv capture` is the
    //     interactive path. Suppressed for commands that adopt themselves.
    if (!req.skipAdopt) {
      try {
        await adoptSweep({
          paths,
          note: onNotice,
          onAdopt: async (rec) => {
            try {
              const c = await commitStore(
                paths,
                env,
                `agentenv: adopt ${singular(rec.storeKind)} ${rec.name} → ${rec.ownerEnv}`,
                gitRun,
              );
              if (c.status === 'blocked') {
                onNotice(
                  `agentenv: adoption of '${rec.name}' NOT committed — a suspected secret is present:\n${describeFindings(c.findings ?? [])}`,
                );
              }
            } catch (err) {
              onNotice(
                `agentenv: adopted '${rec.name}' locally but the commit was skipped — ${(err as Error).message}`,
              );
            }
          },
        });
      } catch (err) {
        onNotice(`agentenv: auto-adopt sweep skipped — ${(err as Error).message}`);
      }
    }

    // 3. Pull (rebase, short timeout, silently skipped offline / no-remote).
    const pull = await pullRebase(paths, env, {
      ...(gitRun ? { run: gitRun } : {}),
      ...(req.pullTimeoutMs !== undefined ? { timeoutMs: req.pullTimeoutMs } : {}),
    });
    const conflicted = pull.status === 'conflict';
    if (conflicted) {
      // 2.1 already aborted the rebase so the tree stays usable; persist a
      // machine-local marker so `status` surfaces the blocked state and the local
      // command still completes (Task 2.2). NEVER auto-resolve.
      await writeConflictMarker(paths, pull.detail ?? 'store history diverged');
      onNotice(
        `agentenv: sync blocked by a conflict — ${pull.detail}. ` +
          'Your store still works locally from the working tree; run `agentenv sync --resolve` to finish syncing.',
      );
    } else if (pull.status === 'ok') {
      // A clean pull integrated remote history: any earlier conflict is now moot.
      await clearConflictMarker(paths);
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

    return { synced: true, pulled, quarantined, conflicted, paused: false };
  } catch (err) {
    // Fail-soft: sync is best-effort; the local command must still complete.
    onNotice(`agentenv: sync (pull phase) skipped — ${(err as Error).message}`);
    return { synced: true, pulled: false, quarantined: false, conflicted: false, paused: false };
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
 * a repo/remote. Returns the {@link PushResult} (or `undefined` on no-repo / a
 * fail-soft error) so a reporting caller like `agentenv sync` can say what happened.
 */
export async function endStoreSync(req: SyncAfterRequest): Promise<PushResult | undefined> {
  const { paths, env, onNotice, gitRun, now } = req;
  if (!(await storeIsRepo(paths))) return undefined;
  // Symmetric to {@link beginStoreSync}'s held-rebase guard (D9, Task 2.2): never
  // push while a `sync --resolve` two-step is HELD in progress. No garbage commit can
  // exist (commitStore refuses mid-rebase), and the completing `sync --resolve` runs
  // its own push AFTER the rebase finishes — so this skip only suppresses a pointless
  // non-fast-forward attempt, never the legitimate post-resolve push.
  if (await rebaseInProgress(paths)) return undefined;
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
    return push;
  } catch (err) {
    onNotice(`agentenv: push skipped — ${(err as Error).message}`);
    return undefined;
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
