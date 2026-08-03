import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCommandPlan } from '../../dist/command-plan.js';
import { executeCommandPlan, recoverCommandPlan } from '../../dist/command-wal.js';
import { capturePathIdentity } from '../../dist/path-identity.js';
import { resolvePaths } from '../../dist/paths.js';
import { ensureStore } from '../../dist/store.js';

const paths = resolvePaths(process.env);
const effectsDir = join(paths.base, 'wal-effects');
const gitMarker = join(effectsDir, 'git-complete');
const targets = {
  a: join(effectsDir, 'a.txt'),
  b: join(effectsDir, 'b.txt'),
};
const bodies = { a: 'effect-a\n', b: 'effect-b\n' };

await mkdir(effectsDir, { recursive: true });
await ensureStore(paths);

function fileIdentity(body) {
  return {
    kind: 'file',
    digest: createHash('sha256').update(body).digest('hex'),
    mode: 0o644,
  };
}

function effect(id) {
  return {
    observeIdentity: () => capturePathIdentity(targets[id]),
    apply: async () => {
      await writeFile(targets[id], bodies[id], { mode: 0o644 });
      if (id === 'b' && process.env.FAIL_FORWARD === '1') {
        throw new Error('injected apply failure');
      }
    },
    undo: () => rm(targets[id], { force: true }),
  };
}

const effects = new Map([
  ['a', effect('a')],
  ['b', effect('b')],
]);
const transactionId = 'tx-subprocess-kill';

function stateLabel(plan) {
  return `${plan.phase}|${plan.operations.map((operation) => operation.state).join(',')}`;
}

async function stopAtRequestedBoundary(plan) {
  const label = stateLabel(plan);
  if (label !== process.env.KILL_LABEL) return;
  process.stdout.write(`READY ${label}\n`);
  await new Promise(() => {});
}

const gitBookkeeping = () => writeFile(gitMarker, 'committed\n', { mode: 0o644 });

if (process.env.MODE === 'recover') {
  await recoverCommandPlan({ paths, transactionId, effects, gitBookkeeping });
} else {
  const plan = createCommandPlan({
    transactionId,
    kind: 'subprocess-kill-test',
    gitRequired: true,
    operations: Object.entries(targets).map(([id, path]) => ({
      id,
      kind: 'write-file',
      path,
      preIdentity: { kind: 'absent' },
      postIdentity: fileIdentity(bodies[id]),
    })),
  });
  await executeCommandPlan({
    paths,
    plan,
    effects,
    gitBookkeeping,
    afterPersist: stopAtRequestedBoundary,
  });
}
