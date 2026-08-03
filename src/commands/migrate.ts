import { parseArgs } from '../args.js';
import type { Command, RunResult } from '../command.js';
import { adapters as realAdapters } from '../adapters/index.js';
import { migrateV1, rollbackMigration } from '../migration.js';

export const migrateCommand: Command = {
  name: 'migrate',
  usage: '[--rollback]',
  summary: 'Safely migrate a pinned CM or JJ v1 installation',

  async run({ args, paths, options }): Promise<RunResult> {
    const parsed = parseArgs(args, { booleans: ['rollback'] });
    if (parsed.unknown.length > 0 || parsed.positionals.length > 0) {
      const unexpected = parsed.unknown[0] ?? parsed.positionals[0];
      return {
        stdout: '',
        stderr: `migrate: unexpected argument '${unexpected}'\nUsage: agentenv migrate [--rollback]\n`,
        code: 1,
      };
    }
    try {
      if (parsed.booleans.has('rollback')) {
        await rollbackMigration(paths);
        return { stdout: `Migration rolled back safely; the v1 root is active again.\n`, code: 0 };
      }
      const result = await migrateV1({
        paths,
        adapters: options.adapters ?? realAdapters,
        ...options.migration,
      });
      const verb = result.status === 'already-opened' ? 'Already migrated' : `Migrated ${result.sourceFormat}`;
      return {
        stdout: `${verb}; the schema 2 gate is open. Retained backup: ${result.backup}\n`,
        code: 0,
      };
    } catch (error) {
      return {
        stdout: '',
        stderr: `migrate: ${(error as Error).message}\n`,
        code: 1,
      };
    }
  },
};
