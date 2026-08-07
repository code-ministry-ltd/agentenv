import { randomBytes } from 'node:crypto';
import {
  discoverGitSkills,
  type GitSkillCandidate as DiscoveredGitSkill,
  type GitSkillDiscovery,
  type GitSkillDiscoveryInput,
  type GitSkillDiscoveryResult,
} from './git-skill-discovery.js';
import type {
  ApiError,
  CandidateId,
  CandidateSetId,
  ContentName,
  GitCandidate,
  GitCandidateSet,
  GitDiscoveryPhase,
} from '../ui/contract.js';
import type { ExactGitSkillImport } from './git-skill-import.js';

const DEFAULT_IDLE_MS = 15 * 60 * 1_000;

export type GitCandidateDiscoveryFunction = (
  input: GitSkillDiscoveryInput,
) => Promise<GitSkillDiscoveryResult>;

export interface GitCandidateStoreOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  offline: boolean;
  gitRun?: GitSkillDiscoveryInput['gitRun'];
  discover?: GitCandidateDiscoveryFunction;
  idleMs?: number;
  now?: () => number;
}

export interface GitCandidateService {
  start(source: string): Extract<GitCandidateSet, { status: 'PENDING' }>;
  poll(id: string, page: number, pageSize: number): GitCandidateSet | undefined;
  discard(id: string): Promise<boolean>;
  take(
    id: string,
    selections: readonly GitCandidateSelection[],
  ): GitCandidateClaimResult;
  shutdown(): Promise<void>;
}

export interface GitCandidateSelection {
  candidateId: string;
  collision: 'skip' | 'overwrite';
}

export interface ClaimedGitCandidates {
  imports: readonly ExactGitSkillImport[];
  release(): Promise<void>;
}

export type GitCandidateClaimResult =
  | { status: 'ready'; claim: ClaimedGitCandidates }
  | { status: 'pending' }
  | { status: 'failed'; error: ApiError }
  | { status: 'invalid-selection' }
  | { status: 'not-found' };

interface CandidateEntry {
  source: DiscoveredGitSkill;
  contract: GitCandidate;
}

interface CandidateRecord {
  id: CandidateSetId;
  phase: GitDiscoveryPhase;
  status: 'pending' | 'ready' | 'failed';
  lastAccess: number;
  timer?: ReturnType<typeof setTimeout>;
  discarded: boolean;
  promise: Promise<void>;
  discovery?: GitSkillDiscovery;
  candidates?: readonly CandidateEntry[];
  error?: ApiError;
}

function opaqueId<Name extends 'CandidateSetId' | 'CandidateId'>():
  Name extends 'CandidateSetId' ? CandidateSetId : CandidateId {
  return randomBytes(24).toString('base64url') as
    Name extends 'CandidateSetId' ? CandidateSetId : CandidateId;
}

function safeFailure(result: Extract<GitSkillDiscoveryResult, { status: 'failure' }>): ApiError {
  if (result.kind === 'offline') {
    return { code: 'VALIDATION_FAILED', message: 'Network Git sources are disabled offline.' };
  }
  if (result.kind === 'invalid-source') {
    return {
      code: 'VALIDATION_FAILED',
      message: 'The Git skill source is invalid or unavailable.',
    };
  }
  return { code: 'INTERNAL_ERROR', message: 'The Git skill source could not be fetched.' };
}

/** Owns private Git checkouts and exposes only opaque, paginated candidate metadata. */
export class GitCandidateStore implements GitCandidateService {
  readonly #cwd: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #offline: boolean;
  readonly #gitRun: GitSkillDiscoveryInput['gitRun'];
  readonly #discover: GitCandidateDiscoveryFunction;
  readonly #idleMs: number;
  readonly #now: () => number;
  readonly #records = new Map<CandidateSetId, CandidateRecord>();
  #closed = false;

  constructor(options: GitCandidateStoreOptions) {
    this.#cwd = options.cwd;
    this.#env = options.env;
    this.#offline = options.offline;
    this.#gitRun = options.gitRun;
    this.#discover = options.discover ?? discoverGitSkills;
    this.#idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.#now = options.now ?? Date.now;
  }

  start(source: string): Extract<GitCandidateSet, { status: 'PENDING' }> {
    if (this.#closed) throw new Error('Git candidate store is closed');
    const id = opaqueId<'CandidateSetId'>();
    const record: CandidateRecord = {
      id,
      phase: 'resolving',
      status: 'pending',
      lastAccess: this.#now(),
      discarded: false,
      promise: Promise.resolve(),
    };
    this.#records.set(id, record);
    this.#touch(record);
    record.promise = this.#complete(record, source);
    return { status: 'PENDING', candidateSetId: id, phase: record.phase };
  }

  poll(id: string, page: number, pageSize: number): GitCandidateSet | undefined {
    const record = this.#records.get(id as CandidateSetId);
    if (record === undefined || record.discarded) return undefined;
    this.#touch(record);
    if (record.status === 'pending') {
      return { status: 'PENDING', candidateSetId: record.id, phase: record.phase };
    }
    if (record.status === 'failed') {
      return {
        status: 'FAILED',
        candidateSetId: record.id,
        error: record.error ?? {
          code: 'INTERNAL_ERROR',
          message: 'The Git skill source could not be discovered.',
        },
      };
    }
    const entries = record.candidates ?? [];
    const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
    if (page > totalPages) throw new RangeError('Git candidate page is out of range');
    const offset = (page - 1) * pageSize;
    return {
      status: 'READY',
      candidateSetId: record.id,
      candidates: entries.slice(offset, offset + pageSize).map((entry) => entry.contract),
      page: {
        page,
        pageSize,
        totalItems: entries.length,
        totalPages,
      },
    };
  }

  async discard(id: string): Promise<boolean> {
    const record = this.#records.get(id as CandidateSetId);
    if (record === undefined) return false;
    this.#records.delete(record.id);
    record.discarded = true;
    if (record.timer !== undefined) clearTimeout(record.timer);
    await record.promise.catch(() => undefined);
    const discovery = record.discovery;
    record.discovery = undefined;
    if (discovery !== undefined) await discovery.release();
    return true;
  }

  take(
    id: string,
    selections: readonly GitCandidateSelection[],
  ): GitCandidateClaimResult {
    const record = this.#records.get(id as CandidateSetId);
    if (record === undefined || record.discarded) return { status: 'not-found' };
    this.#touch(record);
    if (record.status === 'pending') return { status: 'pending' };
    if (record.status === 'failed') {
      return {
        status: 'failed',
        error: record.error ?? {
          code: 'INTERNAL_ERROR',
          message: 'The Git skill source could not be discovered.',
        },
      };
    }
    const candidates = record.candidates ?? [];
    const ids = new Set<string>();
    const chosen: Array<{ entry: CandidateEntry; collision: 'skip' | 'overwrite' }> = [];
    for (const selection of selections) {
      if (ids.has(selection.candidateId)) return { status: 'invalid-selection' };
      ids.add(selection.candidateId);
      const entry = candidates.find(
        (candidate) => candidate.contract.candidateId === selection.candidateId,
      );
      if (entry === undefined) return { status: 'invalid-selection' };
      chosen.push({ entry, collision: selection.collision });
    }
    const discovery = record.discovery;
    if (discovery === undefined) return { status: 'failed', error: {
      code: 'INTERNAL_ERROR',
      message: 'The Git candidate set is unavailable.',
    } };

    this.#records.delete(record.id);
    record.discarded = true;
    if (record.timer !== undefined) clearTimeout(record.timer);
    record.discovery = undefined;
    let released = false;
    return {
      status: 'ready',
      claim: {
        imports: chosen.map(({ entry, collision }) => ({
          candidateId: entry.contract.candidateId,
          candidate: entry.source,
          sourceDirectory: discovery.candidateDirectory(entry.source),
          source: discovery.source,
          collision,
        })),
        release: async () => {
          if (released) return;
          released = true;
          await discovery.release();
        },
      },
    };
  }

  async sweepExpired(): Promise<void> {
    const cutoff = this.#now() - this.#idleMs;
    const expired = [...this.#records.values()]
      .filter((record) => record.lastAccess <= cutoff)
      .map((record) => record.id);
    await Promise.all(expired.map((id) => this.discard(id)));
  }

  async shutdown(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.all([...this.#records.keys()].map((id) => this.discard(id)));
  }

  async #complete(record: CandidateRecord, source: string): Promise<void> {
    let result: GitSkillDiscoveryResult;
    try {
      result = await this.#discover({
        source,
        cwd: this.#cwd,
        env: this.#env,
        offline: this.#offline,
        ...(this.#gitRun === undefined ? {} : { gitRun: this.#gitRun }),
        onPhase: (phase) => {
          if (!record.discarded && record.status === 'pending') record.phase = phase;
        },
      });
    } catch {
      result = {
        status: 'failure',
        kind: 'fetch-failed',
        message: 'Git skill discovery failed',
      };
    }
    if (result.status === 'failure') {
      if (!record.discarded) {
        record.status = 'failed';
        record.error = safeFailure(result);
      }
      return;
    }

    record.discovery = result.discovery;
    if (record.discarded) {
      await result.discovery.release();
      record.discovery = undefined;
      return;
    }
    const valid = result.discovery.candidates.filter(
      (candidate) => candidate.validation.status === 'valid',
    );
    if (valid.length === 0) {
      await result.discovery.release();
      record.discovery = undefined;
      record.status = 'failed';
      record.error = {
        code: 'VALIDATION_FAILED',
        message: 'No valid skills were found in this Git source.',
      };
      return;
    }
    record.candidates = valid.map((candidate): CandidateEntry => ({
      source: candidate,
      contract: {
        candidateId: opaqueId<'CandidateId'>(),
        name: candidate.name as ContentName,
        description: candidate.description.slice(0, 1_000),
        repository: result.discovery.source.repo,
        repositoryPath: candidate.repoPath,
        ref: result.discovery.source.ref,
        commit: result.discovery.source.commit,
        shortCommit: result.discovery.source.commit.slice(0, 7),
      },
    }));
    record.status = 'ready';
  }

  #touch(record: CandidateRecord): void {
    record.lastAccess = this.#now();
    if (record.timer !== undefined) clearTimeout(record.timer);
    record.timer = setTimeout(() => {
      void this.sweepExpired();
    }, this.#idleMs);
    record.timer.unref?.();
  }
}
