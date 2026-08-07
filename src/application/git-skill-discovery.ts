import { rm, stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateSkillDir } from '../content-items.js';
import type { GitRunner } from '../git.js';
import {
  fetchSkillSource,
  hashDir,
  resolveSkillSource,
  scanSkillDirs,
} from '../skill-source.js';

export interface GitSkillDiscoveryInput {
  source: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  offline: boolean;
  gitRun?: GitRunner;
  onPhase?: (phase: GitSkillDiscoveryPhase) => void;
}

export type GitSkillDiscoveryPhase = 'resolving' | 'fetching' | 'scanning';

export interface GitSkillDiscoverySource {
  repo: string;
  ref: string;
  commit: string;
}

export type GitSkillCandidateValidation =
  | { status: 'valid' }
  | { status: 'invalid'; message: string };

/** Browser-safe candidate metadata. Its private checkout path stays on the lease. */
export interface GitSkillCandidate {
  name: string;
  description: string;
  repoPath: string;
  validation: GitSkillCandidateValidation;
  /** Private exact-content identity; candidate HTTP projections deliberately omit it. */
  contentHash: string;
}

/**
 * A private, exact checkout and its candidates. Callers must release it; candidate
 * directory lookup requires the original candidate object, preventing path
 * substitution at the shared application boundary.
 */
export class GitSkillDiscovery {
  readonly source: GitSkillDiscoverySource;
  readonly candidates: readonly GitSkillCandidate[];
  readonly rootCandidate: GitSkillCandidate | undefined;
  readonly #cloneDir: string;
  readonly #directories: ReadonlyMap<GitSkillCandidate, string>;
  #released = false;

  constructor(input: {
    source: GitSkillDiscoverySource;
    sourceSubpath: string;
    cloneDir: string;
    candidates: ReadonlyArray<{ candidate: GitSkillCandidate; directory: string }>;
  }) {
    this.source = Object.freeze({ ...input.source });
    const pairs = input.candidates.map(({ candidate, directory }) => ({
      candidate: Object.freeze({
        ...candidate,
        validation: Object.freeze({ ...candidate.validation }),
      }),
      directory,
    }));
    this.candidates = Object.freeze(pairs.map(({ candidate }) => candidate));
    this.rootCandidate = this.candidates.find(
      (candidate) => candidate.repoPath === input.sourceSubpath,
    );
    this.#cloneDir = input.cloneDir;
    this.#directories = new Map(
      pairs.map(({ candidate, directory }) => [candidate, directory]),
    );
  }

  candidateDirectory(candidate: GitSkillCandidate): string {
    if (this.#released) throw new Error('Git skill discovery has been released');
    const directory = this.#directories.get(candidate);
    if (directory === undefined) throw new Error('Git skill candidate does not belong to this discovery');
    return directory;
  }

  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    await rm(this.#cloneDir, { recursive: true, force: true });
  }
}

export type GitSkillDiscoveryResult =
  | { status: 'ready'; discovery: GitSkillDiscovery }
  | {
      status: 'failure';
      kind: 'offline' | 'invalid-source' | 'fetch-failed';
      message: string;
    };

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Convert a raw local repository path (optionally suffixed with `@ref`) to file://. */
async function localSourceUrl(source: string, cwd: string): Promise<string | undefined> {
  const direct = resolve(cwd, source);
  if (await directoryExists(direct)) return pathToFileURL(direct).href;

  const ref = /@([^@/]+)$/.exec(source);
  if (ref === null) return undefined;
  const withoutRef = resolve(cwd, source.slice(0, ref.index));
  if (!(await directoryExists(withoutRef))) return undefined;
  return `${pathToFileURL(withoutRef).href}@${ref[1]}`;
}

/** POSIX-style path of a discovered skill within the original repository. */
export function gitSkillRepoPath(
  sourceSubpath: string,
  scanRoot: string,
  skillDirectory: string,
): string {
  const discovered = relative(scanRoot, skillDirectory).split(sep).join('/');
  return [sourceSubpath, discovered].filter((part) => part !== '').join('/');
}

/** Fetch and scan one supported Git source without mutating an environment. */
export async function discoverGitSkills(
  input: GitSkillDiscoveryInput,
): Promise<GitSkillDiscoveryResult> {
  input.onPhase?.('resolving');
  const local = await localSourceUrl(input.source, input.cwd);
  const sourceText = local ?? input.source;
  if (input.offline && local === undefined && !sourceText.trim().startsWith('file://')) {
    return {
      status: 'failure',
      kind: 'offline',
      message: 'network git sources are disabled by --offline',
    };
  }

  const source = await resolveSkillSource(sourceText);
  if ('error' in source) {
    return { status: 'failure', kind: 'invalid-source', message: source.error };
  }
  input.onPhase?.('fetching');
  const fetched = await fetchSkillSource(source, {
    env: input.env,
    ...(input.gitRun === undefined ? {} : { gitRun: input.gitRun }),
  });
  if ('error' in fetched) {
    return { status: 'failure', kind: 'fetch-failed', message: fetched.error };
  }

  try {
    input.onPhase?.('scanning');
    const scanned = await scanSkillDirs(fetched.scanDir);
    const candidates = await Promise.all(scanned.map(async (candidate) => {
      const validation = await validateSkillDir(candidate.dir);
      const contentHash = await hashDir(candidate.dir);
      const metadata: GitSkillCandidate = {
        name: candidate.name,
        description: candidate.description,
        repoPath: gitSkillRepoPath(source.subpath, fetched.scanDir, candidate.dir),
        validation: 'error' in validation
          ? { status: 'invalid', message: validation.error }
          : { status: 'valid' },
        contentHash,
      };
      return { candidate: metadata, directory: candidate.dir };
    }));
    return {
      status: 'ready',
      discovery: new GitSkillDiscovery({
        source: { repo: source.repo, ref: fetched.ref, commit: fetched.commit },
        sourceSubpath: source.subpath,
        cloneDir: fetched.cloneDir,
        candidates,
      }),
    };
  } catch (error) {
    await rm(fetched.cloneDir, { recursive: true, force: true });
    return {
      status: 'failure',
      kind: 'fetch-failed',
      message: error instanceof Error ? error.message : 'Git skill discovery failed',
    };
  }
}
