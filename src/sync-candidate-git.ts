import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  publishStagedBundle,
  recoverPendingFilesystemBundles,
  type StagedBundleEntry,
} from './filesystem-bundle.js';
import {
  getRemoteUrl,
  gitContext,
  headCommit,
  redactRemoteUrl,
  type GitRunResult,
  type GitRunner,
} from './git.js';
import type { Paths } from './paths.js';
import { capturePathIdentity, identitiesEqual } from './path-identity.js';
import { readState } from './state.js';
import { createSyncCandidate, type SyncCandidate } from './sync-candidate.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 3_000;

export type PrepareCandidateResult =
  | { status: 'nothing' | 'no-remote' }
  | { status: 'offline' | 'error'; detail: string }
  | { status: 'conflict'; candidate: SyncCandidate; detail: string }
  | { status: 'prepared'; candidate: SyncCandidate; expectedHead: string; revision: string };

interface PrepareCandidateRequest {
  paths: Paths;
  env: NodeJS.ProcessEnv;
  id: string;
  fetchedAt: number;
  run?: GitRunner;
  timeoutMs?: number;
  /** Persist the fetched identity before worktree construction or validation. */
  onFetched(candidate: SyncCandidate): Promise<void>;
}

function firstLine(text: string): string {
  return text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
}

function runAt(
  req: Pick<PrepareCandidateRequest, 'paths' | 'env' | 'run'>,
  cwd: string,
  args: readonly string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<GitRunResult> {
  return gitContext(req.paths, req.env, req.run).run(args, { cwd, env: req.env, timeoutMs });
}

async function deleteRef(req: PrepareCandidateRequest, ref: string): Promise<void> {
  await runAt(req, req.paths.store, ['update-ref', '-d', ref]);
}

/**
 * Fetch and rebase remote history in a detached worktree. The canonical store
 * branch and working tree remain untouched until a separately validated
 * candidate is promoted.
 */
export async function prepareSyncCandidate(
  req: PrepareCandidateRequest,
): Promise<PrepareCandidateResult> {
  if (!(await getRemoteUrl(req.paths, req.env, req.run))) return { status: 'no-remote' };
  const expectedHead = await headCommit(req.paths, req.env, req.run);
  if (!expectedHead) return { status: 'nothing' };

  const branchResult = await runAt(req, req.paths.store, ['branch', '--show-current']);
  const branch = branchResult.stdout.trim() || 'main';
  const ref = `refs/agentenv/candidates/${req.id}`;
  const fetch = await runAt(
    req,
    req.paths.store,
    ['fetch', '--no-tags', 'origin', `refs/heads/${branch}:${ref}`],
    req.timeoutMs ?? FETCH_TIMEOUT_MS,
  );
  if (fetch.code !== 0) {
    await deleteRef(req, ref);
    if (fetch.timedOut) return { status: 'offline', detail: 'network timeout' };
    return {
      status: 'offline',
      detail: redactRemoteUrl(firstLine(fetch.stderr)) || 'remote fetch failed',
    };
  }

  // If the fetched remote revision is already in local history, local is equal
  // or ahead and there is no candidate to validate or promote.
  const incorporated = await runAt(req, req.paths.store, ['merge-base', '--is-ancestor', ref, 'HEAD']);
  if (incorporated.code === 0) {
    await deleteRef(req, ref);
    return { status: 'nothing' };
  }

  const worktree = join(req.paths.live, 'candidates', req.id);
  let candidate = createSyncCandidate({
    id: req.id,
    ref,
    worktree,
    fetchedAt: req.fetchedAt,
    touchedCanonicalPaths: [],
  });
  await req.onFetched(candidate);

  await mkdir(dirname(worktree), { recursive: true });
  await rm(worktree, { recursive: true, force: true });
  const added = await runAt(req, req.paths.store, ['worktree', 'add', '--detach', worktree, expectedHead]);
  if (added.code !== 0) {
    return {
      status: 'error',
      detail: `could not construct isolated candidate worktree (${firstLine(added.stderr) || 'git worktree add failed'})`,
    };
  }

  const rebased = await runAt(req, worktree, ['rebase', ref]);
  if (rebased.code !== 0) {
    const detail = `${rebased.stdout}\n${rebased.stderr}`;
    if (/CONFLICT|could not apply|Resolve all conflicts|needs merge/i.test(detail)) {
      await runAt(req, worktree, ['rebase', '--abort']);
      return {
        status: 'conflict',
        candidate,
        detail: 'store history diverged — run `agentenv sync --resolve`',
      };
    }
    return {
      status: 'error',
      detail: `could not prepare isolated candidate (${firstLine(rebased.stderr) || 'git rebase failed'})`,
    };
  }

  const revisionResult = await runAt(req, worktree, ['rev-parse', '--verify', 'HEAD']);
  const revision = revisionResult.stdout.trim();
  if (revisionResult.code !== 0 || revision === '') {
    return { status: 'error', detail: 'could not identify isolated candidate revision' };
  }
  const changed = await runAt(
    req,
    req.paths.store,
    ['diff', '--name-only', '-z', expectedHead, revision],
  );
  const touchedCanonicalPaths = changed.stdout.split('\0').filter((path) => path !== '').sort();
  candidate = {
    ...candidate,
    touchedCanonicalPaths,
    expectedCanonicalRevision: expectedHead,
    candidateRevision: revision,
  };

  // The durable private ref names the fully integrated candidate, not merely
  // the remote tip, so retry/promotion is stable and needs no network.
  const updated = await runAt(req, req.paths.store, ['update-ref', ref, revision]);
  if (updated.code !== 0) {
    return { status: 'error', detail: 'could not retain isolated candidate revision' };
  }
  return { status: 'prepared', candidate, expectedHead, revision };
}

export interface PromoteCandidateResult {
  status: 'promoted' | 'deferred' | 'error';
  blocker?: string;
  detail?: string;
}

export interface PromoteCandidateRequest {
  paths: Paths;
  env: NodeJS.ProcessEnv;
  id: string;
  worktree: string;
  touchedCanonicalPaths: readonly string[];
  expectedHead: string;
  revision: string;
  run?: GitRunner;
  /** Fault injection after one canonical path has been applied. */
  afterApply?: (entry: StagedBundleEntry) => Promise<void>;
}

function containedBy(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep);
}

async function advanceCandidateHead(req: PromoteCandidateRequest): Promise<void> {
  const current = await headCommit(req.paths, req.env, req.run);
  if (current !== req.expectedHead && current !== req.revision) {
    throw new Error('candidate Git bookkeeping found an unexpected canonical HEAD');
  }
  const reset = await runAt(req, req.paths.store, ['reset', '--mixed', req.revision]);
  if (reset.code !== 0) {
    throw new Error(
      `candidate promotion Git bookkeeping failed (${firstLine(reset.stderr) || 'git reset --mixed failed'})`,
    );
  }
  const advanced = await headCommit(req.paths, req.env, req.run);
  const status = await runAt(req, req.paths.store, ['status', '--porcelain']);
  if (advanced !== req.revision || status.code !== 0 || status.stdout.trim() !== '') {
    throw new Error('candidate promotion Git bookkeeping did not produce the validated clean revision');
  }
}

async function verifyCandidateWorktree(req: PromoteCandidateRequest): Promise<void> {
  const revision = await runAt(req, req.worktree, ['rev-parse', '--verify', 'HEAD']);
  if (revision.code !== 0 || revision.stdout.trim() !== req.revision) {
    throw new Error('retained candidate worktree no longer has its validated revision');
  }
  const status = await runAt(req, req.worktree, ['status', '--porcelain']);
  if (status.code !== 0 || status.stdout.trim() !== '') {
    throw new Error('retained candidate worktree changed after validation');
  }
}

/** Promote only if the canonical branch still has the identity we prepared from. */
export async function promoteSyncCandidate(
  req: PromoteCandidateRequest,
): Promise<PromoteCandidateResult> {
  const transactionId = `candidate-${req.id}`;
  const existing = (await readState(req.paths)).commands.find(
    (plan) => plan.transactionId === transactionId,
  );
  if (existing) {
    if (existing.kind !== 'filesystem-bundle') {
      return { status: 'error', detail: 'candidate transaction id belongs to another command' };
    }
    await recoverPendingFilesystemBundles(
      req.paths,
      () => advanceCandidateHead(req),
      transactionId,
    );
    if (existing.commitPoint) return { status: 'promoted' };
  }

  const current = await headCommit(req.paths, req.env, req.run);
  if (current === req.revision) {
    const status = await runAt(req, req.paths.store, ['status', '--porcelain']);
    return status.code === 0 && status.stdout.trim() === ''
      ? { status: 'promoted' }
      : { status: 'error', detail: 'canonical store changed after candidate HEAD advanced' };
  }
  if (current !== req.expectedHead) {
    return { status: 'deferred', blocker: 'canonical-head-changed' };
  }
  const dirty = await runAt(req, req.paths.store, ['status', '--porcelain']);
  if (dirty.code !== 0) return { status: 'error', detail: 'could not inspect canonical store' };
  if (dirty.stdout.trim() !== '') return { status: 'deferred', blocker: 'canonical-worktree-dirty' };
  await verifyCandidateWorktree(req);

  const stagingRoot = join(req.paths.live, 'commands', transactionId);
  await mkdir(stagingRoot, { recursive: true });
  try {
    const entries: StagedBundleEntry[] = [];
    const sources: Array<{ path: string; staged: string }> = [];
    const paths = [...new Set(req.touchedCanonicalPaths)].sort();
    for (const [index, path] of paths.entries()) {
      const target = resolve(req.paths.store, path);
      const source = resolve(req.worktree, path);
      if (!containedBy(req.paths.store, target) || !containedBy(req.worktree, source)) {
        throw new Error(`candidate path escapes its isolated or canonical store: '${path}'`);
      }
      const staged = join(stagingRoot, `candidate-${index}`);
      const sourceBefore = await capturePathIdentity(source);
      if (sourceBefore.kind !== 'absent') {
        await cp(source, staged, {
          recursive: true,
          dereference: false,
          errorOnExist: true,
          force: false,
          preserveTimestamps: true,
        });
      }
      const sourceAfter = await capturePathIdentity(source);
      const stagedIdentity = await capturePathIdentity(staged);
      if (
        !identitiesEqual(sourceBefore, sourceAfter) ||
        !identitiesEqual(sourceBefore, stagedIdentity)
      ) {
        throw new Error(`candidate path changed or was not staged byte-for-byte: '${path}'`);
      }
      entries.push({ id: `candidate-${index}`, target, staged });
      sources.push({ path: source, staged });
    }
    await verifyCandidateWorktree(req);
    for (const source of sources) {
      if (
        !identitiesEqual(
          await capturePathIdentity(source.path),
          await capturePathIdentity(source.staged),
        )
      ) {
        throw new Error('candidate source changed after its canonical copy was staged');
      }
    }
    await publishStagedBundle({
      paths: req.paths,
      transactionId,
      stagingRoot,
      entries,
      gitBookkeeping: () => advanceCandidateHead(req),
      ...(req.afterApply ? { afterApply: req.afterApply } : {}),
    });
    return { status: 'promoted' };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

/** Resolve the normal Paths facade against an isolated store worktree. */
export function candidatePaths(paths: Paths, store: string): Paths {
  const environments = join(store, 'environments');
  return {
    ...paths,
    store,
    environments,
    storeReadme: join(store, 'README.md'),
    envDir: (name: string) => join(environments, name),
    envYaml: (name: string) => join(environments, name, 'env.yaml'),
  };
}
