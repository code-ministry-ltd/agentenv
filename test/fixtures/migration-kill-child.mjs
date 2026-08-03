import { migrateV1, rollbackMigration } from '../../dist/migration.js';
import { resolvePaths } from '../../dist/paths.js';

const paths = resolvePaths(process.env);

if (process.env.MODE === 'rollback') {
  await rollbackMigration(paths);
} else {
  const boundary = process.env.KILL_BOUNDARY;
  await migrateV1({
    paths,
    // No adapter behaviour is exercised before the gate-open commit point. The
    // identity is enough to make the migration install a real closed shim.
    adapters: [{ id: 'fixture', binaryName: 'fixture-harness' }],
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
