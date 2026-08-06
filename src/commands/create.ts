import { randomUUID } from 'node:crypto';
import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from '../args.js';
import type { Command, RunResult } from '../command.js';
import { parseEnvConfig, scaffoldEnvYaml } from '../env-config.js';
import { capturePathIdentity, identitiesEqual } from '../path-identity.js';
import { environmentExists, STORE_README, validateEnvName } from '../store.js';
import { commandIsPending, publishWithPendingNotice } from './staged-publication.js';
import {
  closeStoreSync,
  commitRequiredSteps,
  openStoreSync,
  withNotices,
} from './store-sync.js';

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

export const createCommand: Command = {
  name: 'create',
  usage: '<name> [--from <env>]',
  summary: 'Create a new environment',

  async run({ args, paths, env, options }): Promise<RunResult> {
    const parsed = parseArgs(args, { values: ['from'] });

    if (parsed.unknown.length > 0) {
      return { stdout: '', stderr: `create: unknown option '${parsed.unknown[0]}'\n`, code: 1 };
    }
    const name = parsed.positionals[0];
    if (name === undefined) {
      return { stdout: '', stderr: 'create: missing environment name\nUsage: agentenv create <name> [--from <env>]\n', code: 1 };
    }
    if (parsed.positionals.length > 1) {
      return {
        stdout: '',
        stderr: `create: unexpected argument '${parsed.positionals[1]}'\nUsage: agentenv create <name> [--from <env>]\n`,
        code: 1,
      };
    }
    const nameError = validateEnvName(name);
    if (nameError) {
      return { stdout: '', stderr: `create: ${nameError}\n`, code: 1 };
    }

    if (await environmentExists(paths, name)) {
      return { stdout: '', stderr: `create: environment '${name}' already exists\n`, code: 1 };
    }

    const from = parsed.values.get('from');
    if (from !== undefined) {
      const fromError = validateEnvName(from);
      if (fromError) {
        return { stdout: '', stderr: `create: --from: ${fromError}\n`, code: 1 };
      }
      if (!(await environmentExists(paths, from))) {
        return { stdout: '', stderr: `create: --from: environment '${from}' does not exist\n`, code: 1 };
      }
    }

    const notices: string[] = [];
    const syncCtx = { paths, env, options };
    await openStoreSync(syncCtx, notices);
    if (await environmentExists(paths, name)) {
      await closeStoreSync(syncCtx, notices);
      return withNotices(
        { stdout: '', stderr: `create: environment '${name}' already exists\n`, code: 1 },
        notices,
      );
    }

    const transactionId = `create-${name}-${randomUUID()}`;
    const stagingRoot = join(paths.live, 'commands', transactionId);
    const stagedEnv = join(stagingRoot, 'environment');
    const targetIdentity = await capturePathIdentity(paths.envDir(name));
    try {
      if (from !== undefined) {
        const sourceBefore = await capturePathIdentity(paths.envDir(from));
        await cp(paths.envDir(from), stagedEnv, { recursive: true });
        const sourceAfter = await capturePathIdentity(paths.envDir(from));
        if (!identitiesEqual(sourceBefore, sourceAfter)) {
          throw new Error(`source environment '${from}' changed while being copied`);
        }
      } else {
        await mkdir(stagedEnv, { recursive: true });
        await writeFile(join(stagedEnv, 'env.yaml'), scaffoldEnvYaml({ description: '' }), 'utf8');
      }
      parseEnvConfig(await readFile(join(stagedEnv, 'env.yaml'), 'utf8'), join(stagedEnv, 'env.yaml'));

      const entries = [{
        id: 'environment',
        target: paths.envDir(name),
        staged: stagedEnv,
        expectedPreIdentity: targetIdentity,
      }];
      if (!(await exists(paths.storeReadme))) {
        const stagedReadme = join(stagingRoot, 'README.md');
        await writeFile(stagedReadme, STORE_README, 'utf8');
        entries.push({
          id: 'store-readme',
          target: paths.storeReadme,
          staged: stagedReadme,
          expectedPreIdentity: { kind: 'absent' },
        });
      }
      const message = from !== undefined
        ? `agentenv: create env ${name} (from ${from})`
        : `agentenv: create env ${name}`;
      const gitSteps = [{ id: 'create-environment', message, paths: entries.map((entry) => entry.target) }];
      const publication = await publishWithPendingNotice({
        paths,
        transactionId,
        kind: 'environment-create',
        stagingRoot,
        allowedRoots: [paths.store],
        entries,
        gitSteps,
        gitBookkeeping: () => commitRequiredSteps(syncCtx, gitSteps, notices, transactionId),
      }, notices);
      if (publication === 'complete') await closeStoreSync(syncCtx, notices);
    } catch (error) {
      if (!(await commandIsPending(paths, transactionId))) {
        await rm(stagingRoot, { recursive: true, force: true });
      }
      await closeStoreSync(syncCtx, notices);
      return withNotices({ stdout: '', stderr: `create: ${(error as Error).message}\n`, code: 1 }, notices);
    }

    const stdout =
      from !== undefined
        ? `Created environment '${name}' (copied from '${from}').\n`
        : `Created environment '${name}'.\n`;
    return withNotices({ stdout, code: 0 }, notices);
  },
};
