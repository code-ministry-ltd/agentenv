import { headCommit, getRemoteUrl } from '../../dist/git.js';
import { resolvePaths } from '../../dist/paths.js';
import { executeRemoteReplacement } from '../../dist/remote-transaction.js';

const paths = resolvePaths(process.env);
const oldHead = await headCommit(paths, process.env);
const oldUrl = await getRemoteUrl(paths, process.env);
if (!oldHead || !oldUrl || !process.env.NEW_REMOTE_URL) process.exit(2);

await executeRemoteReplacement({
  paths,
  env: process.env,
  oldHead,
  newHead: oldHead,
  oldUrl,
  newUrl: process.env.NEW_REMOTE_URL,
  afterPersist: async (plan) => {
    if (
      plan.phase === 'applying' &&
      plan.operations.map((operation) => operation.state).join(',') === 'applied,pending'
    ) {
      process.stdout.write('READY url-applied\n');
      await new Promise(() => {});
    }
  },
});
