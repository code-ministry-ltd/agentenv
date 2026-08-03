import { migrateV1, rollbackMigration } from '../../dist/migration.js';
import { resolvePaths } from '../../dist/paths.js';

const paths = resolvePaths(process.env);

if (process.env.MODE === 'rollback') {
  await rollbackMigration(paths);
} else {
  const boundary = process.env.KILL_BOUNDARY;
  await migrateV1({
    paths,
    // This fixture exercises migration crash boundaries, not adapter probing.
    // Report the synthetic harness absent so the production probe correctly
    // skips it while the identity still installs a real closed shim.
    adapters: [{
      id: 'fixture',
      binaryName: 'fixture-harness',
      detect: async () => false,
    }],
    listHarnessProcesses: async () => [],
    now: () => 1_754_112_000_000,
    probe: async () => {},
    afterBoundary: async (observed) => {
      if (observed !== boundary) return;
      process.stdout.write(`READY ${observed}\n`);
      await new Promise(() => {});
    },
  });
}
