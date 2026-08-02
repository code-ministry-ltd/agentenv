import { describe, expect, it } from 'vitest';
import {
  beginMigrationBackup,
  beginMigrationImport,
  beginMigrationProbes,
  beginMigrationRollback,
  completeMigrationBackup,
  completeMigrationImport,
  completeMigrationRollback,
  createMigrationState,
  openMigrationGate,
} from '../src/migration-state.js';

describe('version-neutral migration gate lifecycle', () => {
  it('keeps the gate closed through backup, import, and probes, then opens once', () => {
    let migration = createMigrationState('migration-1', 'cm-v1');
    expect(migration.gate).toBe('closed');
    migration = beginMigrationBackup(migration);
    migration = completeMigrationBackup(migration, 'backup:sha256:abc');
    migration = beginMigrationImport(migration);
    migration = completeMigrationImport(migration);
    migration = beginMigrationProbes(migration);
    expect(migration.gate).toBe('closed');
    migration = openMigrationGate(migration);
    expect(migration).toMatchObject({ phase: 'opened', gate: 'open', commitPoint: true });
    expect(() => beginMigrationRollback(migration, 'too late')).toThrow(/commit point/i);
  });

  it('cannot import until a durable backup is recorded', () => {
    const migration = beginMigrationBackup(createMigrationState('migration-1', 'jj-v1'));
    expect(() => beginMigrationImport(migration)).toThrow(/backed-up/i);
  });

  it('rolls back idempotently while the gate remains closed before cutover', () => {
    let migration = beginMigrationBackup(createMigrationState('migration-1', 'jj-v1'));
    migration = completeMigrationBackup(migration, 'backup:sha256:abc');
    migration = beginMigrationImport(migration);
    migration = beginMigrationRollback(migration, 'import fault');
    expect(migration.gate).toBe('closed');
    migration = completeMigrationRollback(migration);
    expect(migration).toMatchObject({ phase: 'rolled-back', gate: 'closed', commitPoint: false });
    expect(completeMigrationRollback(migration)).toEqual(migration);
  });

  it('does not open from an unproven import', () => {
    let migration = beginMigrationBackup(createMigrationState('migration-1', 'cm-v1'));
    migration = completeMigrationBackup(migration, 'backup:sha256:abc');
    migration = beginMigrationImport(migration);
    migration = completeMigrationImport(migration);
    expect(() => openMigrationGate(migration)).toThrow(/probing/i);
  });
});
