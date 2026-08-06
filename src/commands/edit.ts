import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from '../args.js';
import type { Command, RunResult } from '../command.js';
import { launchEditorDefault } from '../editor.js';
import { parseEnvConfig } from '../env-config.js';
import { capturePathIdentity } from '../path-identity.js';
import { environmentExists, validateEnvName } from '../store.js';
import { publishWithPendingNotice } from './staged-publication.js';
import {
  closeStoreSync,
  commitRequiredSteps,
  openStoreSync,
  withNotices,
} from './store-sync.js';

function configuredEditor(env: NodeJS.ProcessEnv): string | undefined {
  const visual = env.VISUAL?.trim();
  if (visual) return visual;
  const editor = env.EDITOR?.trim();
  if (editor) return editor;
  return undefined;
}

export const editCommand: Command = {
  name: 'edit',
  usage: '<name> [--print-path]',
  summary: "Edit an environment's manifest in $EDITOR",

  async run({ args, paths, env, options }): Promise<RunResult> {
    const parsed = parseArgs(args, { booleans: ['print-path'] });
    if (parsed.unknown.length > 0) {
      return { stdout: '', stderr: `edit: unknown option '${parsed.unknown[0]}'\n`, code: 1 };
    }
    const name = parsed.positionals[0];
    if (name === undefined) {
      return { stdout: '', stderr: 'edit: missing environment name\nUsage: agentenv edit <name> [--print-path]\n', code: 1 };
    }
    if (parsed.positionals.length > 1) {
      return {
        stdout: '',
        stderr: `edit: unexpected argument '${parsed.positionals[1]}'\nUsage: agentenv edit <name> [--print-path]\n`,
        code: 1,
      };
    }
    // Validate before any path join, so `edit ../../x` can't open a file outside the store.
    const nameError = validateEnvName(name);
    if (nameError) {
      return { stdout: '', stderr: `edit: ${nameError}\n`, code: 1 };
    }
    if (!(await environmentExists(paths, name))) {
      return { stdout: '', stderr: `edit: environment '${name}' does not exist\n`, code: 1 };
    }

    const file = paths.envYaml(name);

    if (parsed.booleans.has('print-path')) {
      return { stdout: `${file}\n`, code: 0 };
    }

    const editor = configuredEditor(env);
    const [command, ...editorArgs] = editor ? editor.split(/\s+/).filter(Boolean) : [];
    if (command === undefined) {
      return {
        stdout: `No $VISUAL or $EDITOR set. Edit this file directly:\n${file}\n`,
        code: 0,
      };
    }

    const notices: string[] = [];
    const ctx = { paths, env, options };
    await openStoreSync(ctx, notices);
    if (!(await environmentExists(paths, name))) {
      await closeStoreSync(ctx, notices);
      return withNotices(
        { stdout: '', stderr: `edit: environment '${name}' does not exist\n`, code: 1 },
        notices,
      );
    }
    const expectedPreIdentity = await capturePathIdentity(file);
    const transactionId = `edit-${name}-${randomUUID()}`;
    const stagingRoot = join(paths.live, 'commands', transactionId);
    const draft = join(stagingRoot, 'env.yaml');
    await mkdir(stagingRoot, { recursive: true });
    await cp(file, draft);

    const launch = options.launchEditor ?? launchEditorDefault;
    const exitCode = await launch(command, [...editorArgs, draft]);
    if (exitCode !== 0) {
      await closeStoreSync(ctx, notices);
      return withNotices({
        stdout: '',
        stderr: `edit: editor exited with code ${exitCode}; draft retained at ${draft}\n`,
        code: exitCode,
      }, notices);
    }

    try {
      parseEnvConfig(await readFile(draft, 'utf8'), draft);
    } catch (error) {
      await closeStoreSync(ctx, notices);
      return withNotices({
        stdout: '',
        stderr: `edit: ${(error as Error).message}; draft retained at ${draft}\n`,
        code: 1,
      }, notices);
    }

    const gitSteps = [{
      id: 'edit-environment',
      message: `agentenv: edit env ${name}`,
      paths: [file],
    }];
    try {
      const publication = await publishWithPendingNotice({
        paths,
        transactionId,
        kind: 'environment-edit',
        stagingRoot,
        allowedRoots: [paths.store],
        entries: [{ id: 'env-yaml', target: file, staged: draft, expectedPreIdentity }],
        gitSteps,
        gitBookkeeping: () => commitRequiredSteps(ctx, gitSteps, notices, transactionId),
      }, notices);
      if (publication === 'complete') await closeStoreSync(ctx, notices);
    } catch (error) {
      await closeStoreSync(ctx, notices);
      return withNotices({
        stdout: '',
        stderr: `edit: ${(error as Error).message}; draft retained at ${draft}\n`,
        code: 1,
      }, notices);
    }
    return withNotices({ stdout: '', code: 0 }, notices);
  },
};
