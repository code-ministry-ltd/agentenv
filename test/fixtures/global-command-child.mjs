import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { materialiseGlobal } from '../../dist/engine.js';
import { recoverPendingGlobalCommands } from '../../dist/global-command.js';
import { resolvePaths } from '../../dist/paths.js';

const paths = resolvePaths(process.env);
const realRoot = join(paths.base, 'real-harness');

const adapter = {
  id: 'global-kill-fixture',
  binaryName: 'global-kill-fixture',
  storeToken: 'fixture',
  sessionSupported: true,
  realConfigRoot: () => realRoot,
  surfaces: [
    {
      id: 'skills',
      storeKind: 'skills',
      supported: true,
      mechanism: 'dir-merge',
      rootRelativePath: 'skills',
      mode: 'copy',
    },
  ],
  compileConfigKeys: async () => [],
};

if (process.env.MODE === 'recover') {
  await recoverPendingGlobalCommands(paths);
} else {
  const canonical = join(paths.envDir('writing'), 'skills', 'managed', 'SKILL.md');
  await mkdir(join(canonical, '..'), { recursive: true });
  await writeFile(paths.envYaml('writing'), 'version: 1.0\ndescription: writing\n', 'utf8');
  await writeFile(canonical, '# MANAGED\n', 'utf8');
  await mkdir(join(realRoot, 'skills', 'user'), { recursive: true });
  await writeFile(join(realRoot, 'skills', 'user', 'SKILL.md'), '# USER\n', 'utf8');

  const label = (plan) =>
    `${plan.phase}|${plan.operations.map((operation) => operation.state).join(',')}`;
  await materialiseGlobal({
    paths,
    adapters: [adapter],
    envs: ['writing'],
    env: process.env,
    commandHooks: {
      afterPersist: async (plan) => {
        const current = label(plan);
        if (current !== process.env.KILL_LABEL) return;
        process.stdout.write(`READY ${current}\n`);
        await new Promise(() => {});
      },
    },
  });
}
