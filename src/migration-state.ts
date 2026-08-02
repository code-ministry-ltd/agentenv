export type LegacyStateFormat = 'cm-v1' | 'jj-v1';
export type MigrationPhase =
  | 'planned'
  | 'backing-up'
  | 'backed-up'
  | 'importing'
  | 'imported'
  | 'probing'
  | 'opened'
  | 'rolling-back'
  | 'rolled-back';

export interface MigrationState {
  schemaVersion: 2;
  id: string;
  sourceFormat: LegacyStateFormat;
  phase: MigrationPhase;
  gate: 'closed' | 'open';
  commitPoint: boolean;
  backupRef: string | null;
  failure: string | null;
}

export function createMigrationState(id: string, sourceFormat: LegacyStateFormat): MigrationState {
  return {
    schemaVersion: 2,
    id,
    sourceFormat,
    phase: 'planned',
    gate: 'closed',
    commitPoint: false,
    backupRef: null,
    failure: null,
  };
}

function requirePhase(migration: MigrationState, expected: MigrationPhase): void {
  if (migration.phase !== expected) {
    throw new Error(`migration must be ${expected}; it is ${migration.phase}`);
  }
}

export function beginMigrationBackup(migration: MigrationState): MigrationState {
  requirePhase(migration, 'planned');
  return { ...migration, phase: 'backing-up' };
}

export function completeMigrationBackup(
  migration: MigrationState,
  backupRef: string,
): MigrationState {
  requirePhase(migration, 'backing-up');
  if (!backupRef) throw new Error('migration backup reference is required');
  return { ...migration, phase: 'backed-up', backupRef };
}

export function beginMigrationImport(migration: MigrationState): MigrationState {
  requirePhase(migration, 'backed-up');
  return { ...migration, phase: 'importing' };
}

export function completeMigrationImport(migration: MigrationState): MigrationState {
  requirePhase(migration, 'importing');
  return { ...migration, phase: 'imported' };
}

export function beginMigrationProbes(migration: MigrationState): MigrationState {
  requirePhase(migration, 'imported');
  return { ...migration, phase: 'probing' };
}

/** Open is the irreversible migration commit point; reversal is a new forward migration. */
export function openMigrationGate(migration: MigrationState): MigrationState {
  requirePhase(migration, 'probing');
  return { ...migration, phase: 'opened', gate: 'open', commitPoint: true };
}

export function beginMigrationRollback(
  migration: MigrationState,
  failure: string,
): MigrationState {
  if (migration.commitPoint) throw new Error('cannot roll back after the migration commit point');
  if (migration.phase === 'rolled-back' || migration.phase === 'rolling-back') {
    throw new Error(`migration is already ${migration.phase}`);
  }
  return { ...migration, phase: 'rolling-back', gate: 'closed', failure };
}

export function completeMigrationRollback(migration: MigrationState): MigrationState {
  if (migration.phase === 'rolled-back') return migration;
  requirePhase(migration, 'rolling-back');
  return { ...migration, phase: 'rolled-back', gate: 'closed', commitPoint: false };
}
