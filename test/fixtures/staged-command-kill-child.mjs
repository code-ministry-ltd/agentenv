import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePaths } from '../../dist/paths.js';
import {
  publishStagedCommand,
  recoverPendingStagedCommands,
} from '../../dist/staged-command.js';
import { emptyManifest, writeState } from '../../dist/state.js';

const paths = resolvePaths(process.env);
const transactionId = 'staged-subprocess';
const root = join(paths.base, 'staged-effects');
const targets = [join(root, 'a.txt'), join(root, 'b.txt')];
const stagingRoot = join(paths.live, 'commands', transactionId);
const gitMarker = join(root, 'git-complete');

const gitBookkeeping = () => writeFile(gitMarker, 'complete\n');
const label = (plan) =>
  `${plan.phase}|${plan.operations.map((operation) => operation.state).join(',')}`;
const afterPersist = async (plan) => {
  const current = label(plan);
  if (current !== process.env.KILL_LABEL) return;
  process.stdout.write(`READY ${current}\n`);
  await new Promise(() => {});
};

if (process.env.MODE === 'recover') {
  await recoverPendingStagedCommands(paths, gitBookkeeping, transactionId);
} else {
  await mkdir(root, { recursive: true });
  await writeFile(targets[0], 'old-a\n');
  await writeFile(targets[1], 'old-b\n');
  const manifest = emptyManifest();
  manifest.inventory = ['old'];
  await writeState(paths, manifest);
  await mkdir(stagingRoot, { recursive: true });
  const staged = [join(stagingRoot, 'a.txt'), join(stagingRoot, 'b.txt')];
  await writeFile(staged[0], 'new-a\n');
  await writeFile(staged[1], 'new-b\n');
  await publishStagedCommand({
    paths,
    transactionId,
    kind: process.env.COMMAND_KIND ?? 'staged-kill-test',
    stagingRoot,
    allowedRoots: [root],
    entries: targets.map((target, index) => ({ id: `path-${index}`, target, staged: staged[index] })),
    statePatch: { inventory: ['new'] },
    gitSteps: [{ id: 'commit', message: 'staged kill test', paths: [join(paths.store, 'placeholder')] }],
    gitBookkeeping,
    afterPersist,
    afterApply: async (operationId) => {
      if (operationId === 'path-1' && process.env.FAIL_FORWARD === '1') {
        throw new Error('injected staged publication failure');
      }
    },
  });
}
