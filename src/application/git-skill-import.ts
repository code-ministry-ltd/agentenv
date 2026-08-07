import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { validateSkillDir } from '../content-items.js';
import {
  parseEnvConfig,
  upsertEnvSource,
  type SkillSourceRecord,
} from '../env-config.js';
import {
  capturePathIdentity,
  capturePathLocationIdentity,
  identitiesEqual,
} from '../path-identity.js';
import { assertNoFollowContainment } from '../path-containment.js';
import type { Paths } from '../paths.js';
import { hashDir } from '../skill-source.js';
import { readState } from '../state.js';
import {
  StagedCommandExpectedIdentityError,
  StagedCommandPreconditionError,
} from '../staged-command.js';
import { environmentExists, validateEnvName } from '../store.js';
import type { ContentTransferRuntime } from './content-transfer-runtime.js';
import type {
  GitSkillCandidate,
  GitSkillDiscoverySource,
} from './git-skill-discovery.js';

export interface ExactGitSkillImport {
  candidateId: string;
  candidate: GitSkillCandidate;
  sourceDirectory: string;
  source: GitSkillDiscoverySource;
  collision: 'skip' | 'overwrite';
}

export type GitSkillImportOutcome =
  | {
      candidateId: string;
      name: string;
      status: 'installed';
      publication: 'complete' | 'git-pending';
    }
  | {
      candidateId: string;
      name: string;
      status: 'skipped';
      reason: 'collision';
    }
  | {
      candidateId: string;
      name: string;
      status: 'failed';
      reason: 'candidate-changed' | 'validation' | 'destination-changed' | 'publication';
    };

export type GitSkillImportResult =
  | { status: 'complete'; outcomes: readonly GitSkillImportOutcome[] }
  | { status: 'invalid-environment' }
  | { status: 'environment-not-found' }
  | { status: 'pending-recovery'; transactionId: string }
  | { status: 'failure' };

export interface ImportGitSkillsInput {
  paths: Paths;
  environment: unknown;
  imports: readonly ExactGitSkillImport[];
  runtime: ContentTransferRuntime;
}

async function importOne(
  input: ImportGitSkillsInput,
  item: ExactGitSkillImport,
): Promise<GitSkillImportOutcome> {
  const name = item.candidate.name;
  if (await hashDir(item.sourceDirectory) !== item.candidate.contentHash) {
    return { candidateId: item.candidateId, name, status: 'failed', reason: 'candidate-changed' };
  }
  const sourceValidation = await validateSkillDir(item.sourceDirectory);
  if ('error' in sourceValidation || sourceValidation.name !== name) {
    return { candidateId: item.candidateId, name, status: 'failed', reason: 'validation' };
  }

  const environment = input.environment as string;
  const environmentPath = input.paths.envDir(environment);
  const skillPath = join(environmentPath, 'skills', name);
  const environmentIdentity = await capturePathIdentity(environmentPath);
  if (environmentIdentity.kind !== 'directory') {
    return { candidateId: item.candidateId, name, status: 'failed', reason: 'destination-changed' };
  }
  const containerIdentity = await capturePathLocationIdentity(input.paths.environments);
  if (containerIdentity.kind !== 'directory-location') {
    return { candidateId: item.candidateId, name, status: 'failed', reason: 'destination-changed' };
  }
  const existing = await capturePathIdentity(skillPath);
  if (existing.kind !== 'absent' && item.collision === 'skip') {
    return { candidateId: item.candidateId, name, status: 'skipped', reason: 'collision' };
  }

  const transactionId = `import-git-skill-${randomUUID()}`;
  const stagingRoot = join(input.paths.live, 'commands', transactionId);
  const stagedEnvironment = join(stagingRoot, 'environment');
  const stagedSkill = join(stagedEnvironment, 'skills', name);
  let retainStaging = false;
  try {
    await mkdir(stagingRoot, { recursive: true });
    await cp(environmentPath, stagedEnvironment, {
      recursive: true,
      verbatimSymlinks: true,
    });
    if (
      !identitiesEqual(await capturePathIdentity(environmentPath), environmentIdentity) ||
      !identitiesEqual(await capturePathIdentity(stagedEnvironment), environmentIdentity)
    ) {
      return { candidateId: item.candidateId, name, status: 'failed', reason: 'destination-changed' };
    }

    await rm(stagedSkill, { recursive: true, force: true });
    await mkdir(dirname(stagedSkill), { recursive: true });
    await cp(item.sourceDirectory, stagedSkill, {
      recursive: true,
      verbatimSymlinks: true,
    });
    const stagedValidation = await validateSkillDir(stagedSkill);
    if ('error' in stagedValidation || stagedValidation.name !== name) {
      return { candidateId: item.candidateId, name, status: 'failed', reason: 'validation' };
    }
    if (
      await hashDir(stagedSkill) !== item.candidate.contentHash ||
      await hashDir(item.sourceDirectory) !== item.candidate.contentHash
    ) {
      return { candidateId: item.candidateId, name, status: 'failed', reason: 'candidate-changed' };
    }

    const manifestPath = join(stagedEnvironment, 'env.yaml');
    const sourceRecord: SkillSourceRecord = {
      repo: item.source.repo,
      path: item.candidate.repoPath,
      ref: item.source.ref,
      commit: item.source.commit,
      hash: item.candidate.contentHash,
    };
    const manifest = upsertEnvSource(await readFile(manifestPath, 'utf8'), name, sourceRecord);
    parseEnvConfig(manifest, 'staged Git import manifest');
    await writeFile(manifestPath, manifest, 'utf8');

    if (!identitiesEqual(await capturePathIdentity(environmentPath), environmentIdentity)) {
      return { candidateId: item.candidateId, name, status: 'failed', reason: 'destination-changed' };
    }
    const publication = await input.runtime.publish({
      paths: input.paths,
      transactionId,
      kind: 'git-skill-import',
      stagingRoot,
      allowedRoots: [input.paths.store],
      entries: [{
        id: 'destination-environment',
        target: environmentPath,
        staged: stagedEnvironment,
        expectedPreIdentity: environmentIdentity,
      }],
      preconditions: [
        {
          id: 'environment-container',
          path: input.paths.environments,
          expectedIdentity: containerIdentity,
        },
        {
          id: 'destination-environment-snapshot',
          path: environmentPath,
          expectedIdentity: environmentIdentity,
        },
      ],
      gitSteps: [{
        id: 'import-git-skill',
        message: `agentenv: import Git skill ${name} into ${environment}`,
        paths: [skillPath, input.paths.envYaml(environment)],
      }],
      afterApply: async (operationId) => {
        const installedHash = await hashDir(skillPath);
        const installedConfig = parseEnvConfig(
          await readFile(input.paths.envYaml(environment), 'utf8'),
          'imported environment manifest',
        );
        if (
          installedHash !== item.candidate.contentHash ||
          installedConfig.sources?.[name]?.hash !== item.candidate.contentHash
        ) {
          throw new StagedCommandExpectedIdentityError(
            operationId,
            environmentPath,
            'pre-apply',
          );
        }
      },
    });
    if (publication.status === 'git-pending') retainStaging = true;
    return {
      candidateId: item.candidateId,
      name,
      status: 'installed',
      publication: publication.status,
    };
  } catch (error) {
    if (
      error instanceof StagedCommandExpectedIdentityError ||
      error instanceof StagedCommandPreconditionError
    ) {
      return { candidateId: item.candidateId, name, status: 'failed', reason: 'destination-changed' };
    }
    return { candidateId: item.candidateId, name, status: 'failed', reason: 'publication' };
  } finally {
    if (!retainStaging) await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Import selected exact candidates sequentially, preserving one Git commit per skill. */
export async function importGitSkills(
  input: ImportGitSkillsInput,
): Promise<GitSkillImportResult> {
  if (typeof input.environment !== 'string' || validateEnvName(input.environment) !== null) {
    return { status: 'invalid-environment' };
  }
  if (!(await environmentExists(input.paths, input.environment))) {
    return { status: 'environment-not-found' };
  }
  try {
    await assertNoFollowContainment(
      input.paths.environments,
      input.paths.envDir(input.environment),
      { includeCandidate: true, label: 'Git import environment' },
    );
    parseEnvConfig(
      await readFile(input.paths.envYaml(input.environment), 'utf8'),
      input.paths.envYaml(input.environment),
    );
    const pending = (await readState(input.paths)).commands[0];
    if (pending) return { status: 'pending-recovery', transactionId: pending.transactionId };
  } catch {
    return { status: 'failure' };
  }

  try {
    const opened = await input.runtime.open();
    if (opened.status === 'pending-recovery') return opened;
    if (opened.status !== 'ready') return { status: 'failure' };
  } catch {
    return { status: 'failure' };
  }

  const outcomes: GitSkillImportOutcome[] = [];
  try {
    for (let index = 0; index < input.imports.length; index += 1) {
      const outcome = await importOne(input, input.imports[index]!);
      outcomes.push(outcome);
      if (outcome.status === 'installed' && outcome.publication === 'git-pending') {
        for (const blocked of input.imports.slice(index + 1)) {
          outcomes.push({
            candidateId: blocked.candidateId,
            name: blocked.candidate.name,
            status: 'failed',
            reason: 'publication',
          });
        }
        break;
      }
    }
    return { status: 'complete', outcomes };
  } finally {
    await input.runtime.close().catch(() => undefined);
  }
}
