import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { writeFileAtomic } from '../fs-atomic.js';
import { withLock } from '../lock.js';
import type { Paths } from '../paths.js';

/**
 * Per-project `.agentenv` approvals — the one-time trust record that a folder's
 * `.agentenv` default (D16) may apply on THIS machine, modelled on the `.mcp.json`
 * trust model. Machine-local and NEVER synced: a repo file must never be able to
 * rewrite machine-wide or real-file state, so a cloned repo's `.agentenv` stays
 * inert until the user approves it here. Kept out of the transactional `state.json`
 * manifest (it is neither an owned item nor a journalled mutation) and out of the
 * per-shell `sessions.json` (approval is per-project, not per-shell): its own small
 * machine-local file, following the derive-from-base pattern of the registry.
 */

/** The registry schema version, mirroring the other machine-local stores (D4). */
export const APPROVALS_VERSION = '1.0';

/** A problem reading approvals.json (corrupt JSON / wrong shape). Names the file. */
export class ApprovalsError extends Error {
  constructor(
    message: string,
    readonly file: string,
  ) {
    super(message);
    this.name = 'ApprovalsError';
  }
}

/** One approval record: when the project folder was trusted (ms epoch). */
export interface ProjectApproval {
  approvedAt: number;
}

/** The parsed approvals store: known fields typed, unknown top-level fields kept. */
export interface ApprovalsStore {
  version: string;
  /** Keyed by the canonical folder that declares the `.agentenv` (D16). */
  approvals: Record<string, ProjectApproval>;
  [key: string]: unknown;
}

/** The on-disk location of the approvals store (derived from the frozen base). */
export function approvalsPath(paths: Paths): string {
  return join(paths.base, 'approvals.json');
}

/**
 * Canonicalise a project-folder key so `default` (which writes at the project
 * root) and pickup (which keys by the folder containing the discovered file)
 * agree on one key for the same folder. Pure string resolution — no disk I/O.
 */
export function approvalKey(dir: string): string {
  return resolve(dir);
}

function emptyStore(): ApprovalsStore {
  return { version: APPROVALS_VERSION, approvals: {} };
}

/**
 * Read and validate approvals.json. A missing file yields an empty store (no
 * project approved yet). Throws {@link ApprovalsError} on corrupt JSON or a
 * malformed shape; callers that must never brick a launch use {@link isApproved}
 * (which swallows the error into a safe "not approved").
 */
export async function readApprovals(paths: Paths): Promise<ApprovalsStore> {
  const file = approvalsPath(paths);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore();
    throw err;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new ApprovalsError(`${file}: corrupt approvals.json (${(err as Error).message})`, file);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new ApprovalsError(`${file}: expected a JSON object at the top level`, file);
  }
  const obj = data as Record<string, unknown>;
  const rawApprovals = obj.approvals;
  if (rawApprovals !== undefined && (rawApprovals === null || typeof rawApprovals !== 'object' || Array.isArray(rawApprovals))) {
    throw new ApprovalsError(`${file}: 'approvals' must be an object`, file);
  }
  const approvals: Record<string, ProjectApproval> = {};
  for (const [key, value] of Object.entries((rawApprovals as Record<string, unknown>) ?? {})) {
    if (value !== null && typeof value === 'object' && typeof (value as ProjectApproval).approvedAt === 'number') {
      approvals[key] = { approvedAt: (value as ProjectApproval).approvedAt };
    }
  }
  return { ...obj, version: typeof obj.version === 'string' ? obj.version : APPROVALS_VERSION, approvals };
}

/**
 * Whether `dir` (a project folder) has been approved on this machine. Fail-safe:
 * ANY error reading the store resolves to `false` (not approved) rather than
 * throwing — an unreadable trust record must leave the `.agentenv` inert, never
 * auto-apply and never brick the launch (D16 / fail-open).
 */
export async function isApproved(paths: Paths, dir: string): Promise<boolean> {
  const key = approvalKey(dir);
  try {
    const store = await readApprovals(paths);
    return store.approvals[key] !== undefined;
  } catch {
    return false;
  }
}

/**
 * Record a one-time approval for `dir`, atomically and under the machine lock.
 * Idempotent (re-approving keeps the first `approvedAt`). A corrupt existing
 * store is reset rather than propagated — machine-local trust state is safe to
 * rebuild, and refusing to write would strand the user's explicit approval.
 */
export async function recordApproval(paths: Paths, dir: string, now: () => number = Date.now): Promise<void> {
  const key = approvalKey(dir);
  await withLock(paths, async () => {
    let store: ApprovalsStore;
    try {
      store = await readApprovals(paths);
    } catch {
      store = emptyStore();
    }
    if (store.approvals[key] === undefined) {
      store.approvals[key] = { approvedAt: now() };
    }
    const out = { ...store, version: APPROVALS_VERSION, approvals: store.approvals };
    await writeFileAtomic(approvalsPath(paths), `${JSON.stringify(out, null, 2)}\n`);
  });
}
