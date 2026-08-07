/* global process */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { moveContent } from '../../dist/application/content-transfer.js';
import { createContentTransferRuntime } from '../../dist/application/content-transfer-runtime.js';
import { resolvePaths } from '../../dist/paths.js';
import { recoverPendingStagedCommands } from '../../dist/staged-command.js';

const paths = resolvePaths(process.env);
const source = join(paths.envDir('source'), 'commands', 'safe.md');
const gitMarker = join(paths.base, 'content-move-git-complete');
const gitBookkeeping = async () => writeFile(gitMarker, 'complete\n');

const boundary = (plan) => {
  const destinationOperation = plan.operations.find((operation) =>
    operation.id === 'destination-environment');
  const sourceOperation = plan.operations.find((operation) =>
    operation.id === 'source-environment');
  if (plan.phase === 'planned') return 'planned';
  if (plan.phase === 'committed') return 'committed';
  if (plan.phase === 'git-pending') return 'git-pending';
  if (plan.phase === 'applying') {
    if (sourceOperation?.state === 'applying') return 'source-applying';
    if (sourceOperation?.state === 'applied') return 'source-applied';
    if (destinationOperation?.state === 'applying') return 'destination-applying';
    if (destinationOperation?.state === 'applied') return 'destination-applied';
  }
  if (plan.phase === 'rolling-back') {
    if (destinationOperation?.state === 'undoing') return 'rollback-destination-undoing';
    if (destinationOperation?.state === 'undone') return 'rollback-destination-undone';
    if (sourceOperation?.state === 'undoing') return 'rollback-source-undoing';
    if (sourceOperation?.state === 'undone') return 'rollback-source-undone';
  }
  return undefined;
};

if (process.env.MODE === 'recover') {
  await recoverPendingStagedCommands(paths, gitBookkeeping);
} else {
  for (const environment of ['source', 'destination']) {
    await mkdir(paths.envDir(environment), { recursive: true });
    await writeFile(paths.envYaml(environment), 'version: "1.0"\ndescription: test\n');
  }
  await mkdir(join(paths.envDir('source'), 'commands'));
  await writeFile(source, 'source bytes\n');
  let stopped = false;
  const result = await moveContent({
    paths,
    source: { kind: 'command', environment: 'source', name: 'safe' },
    destination: { kind: 'command', environment: 'destination', name: 'safe' },
    runtime: createContentTransferRuntime({ paths, gitBookkeeping }),
    faults: {
      afterApply: async (operationId) => {
        if (process.env.FAIL_AFTER_SOURCE === '1' && operationId === 'source-environment') {
          throw new Error('injected source failure');
        }
      },
      afterPersist: async (plan) => {
        const current = boundary(plan);
        if (stopped || current !== process.env.KILL_BOUNDARY) return;
        stopped = true;
        process.stdout.write(`READY ${current}\n`);
        await new Promise(() => {});
      },
    },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
