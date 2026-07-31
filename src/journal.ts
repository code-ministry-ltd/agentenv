import { restore } from './backups.js';
import type { Paths } from './paths.js';
import type { JournalEntry, StateManifest } from './state.js';
import { addItem, readState, removeItem, writeState } from './state.js';

/**
 * A mutation the caller intends to perform, carrying everything needed to UNDO
 * it: the manifest change (`op` + `item`) applied at commit, and `undo` (restore
 * these pre-mutation bytes to this path — or, for an `absent` backup, delete the
 * path). Structurally identical to a persisted {@link JournalEntry}: a planned
 * mutation IS its journal entry.
 */
export type PlannedMutation = JournalEntry;

/** Outcome of {@link recoverState}. */
export interface RecoveryResult {
  /** Whether an unfinished journal was found and rolled back. */
  recovered: boolean;
  /** How many journalled mutations were rolled back. */
  rolledBack: number;
}

/**
 * A transaction over the state manifest. Lifecycle:
 *
 * 1. {@link beginTransaction} — snapshot the manifest, refuse if a journal is
 *    already pending (recover first).
 * 2. {@link Transaction.apply} per mutation — journal it to disk (write-ahead:
 *    persisted BEFORE the effect runs), then run the caller's effect.
 * 3. {@link Transaction.commit} — apply the net manifest change and clear the
 *    journal, in one atomic write. Or {@link Transaction.rollback} — undo every
 *    applied effect via its backup and clear the journal.
 *
 * A crash at any point leaves an uncommitted journal that {@link recoverState}
 * rolls back deterministically on the next invocation. The transaction does not
 * take the lock; task 1.7 composes {@link import('./lock.js').withLock} around
 * the whole plan → journal → apply → verify sequence.
 */
export interface Transaction {
  /**
   * Journal `mutation` (persisted to state.json before `effect` is invoked),
   * then run `effect`. If `effect` throws, the mutation is already journalled —
   * the throw propagates and the caller should {@link rollback}; even if the
   * process dies, {@link recoverState} will undo it.
   */
  apply(mutation: PlannedMutation, effect: () => Promise<void>): Promise<void>;
  /** Apply the net manifest change and clear the journal (atomic). */
  commit(): Promise<void>;
  /** Restore every applied mutation's backup (reverse order) and clear the journal. */
  rollback(): Promise<void>;
}

/** Restore each entry's backup in reverse order — the deterministic undo. */
async function rollbackEntries(paths: Paths, entries: JournalEntry[]): Promise<void> {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry) continue;
    await restore(paths, entry.undo.backupRef, entry.undo.path);
  }
}

/**
 * Begin a transaction. Reads the current manifest and refuses to start if an
 * unfinished journal is present — the caller must {@link recoverState} first, so
 * a stale journal is never silently discarded.
 */
export async function beginTransaction(paths: Paths): Promise<Transaction> {
  const manifest: StateManifest = await readState(paths);
  if (manifest.journal && manifest.journal.length > 0) {
    throw new Error(
      'agentenv: a previous transaction is unfinished — recover state before beginning a new one',
    );
  }
  manifest.journal = [];
  let committed = false;

  return {
    async apply(mutation, effect) {
      // A committed transaction is finished: applying again would push onto a
      // freshly-recreated journal (a phantom), so refuse rather than corrupt.
      if (committed) {
        throw new Error('agentenv: transaction already committed — cannot apply further mutations');
      }
      // Write-ahead: journal (with undo info) is durable before the effect runs.
      manifest.journal ??= [];
      manifest.journal.push(mutation);
      await writeState(paths, manifest);
      await effect();
    },
    async commit() {
      for (const entry of manifest.journal ?? []) {
        if (entry.op === 'add') {
          addItem(manifest, entry.item);
        } else {
          removeItem(manifest, entry.item);
        }
      }
      manifest.journal = null;
      await writeState(paths, manifest);
      committed = true;
    },
    async rollback() {
      await rollbackEntries(paths, manifest.journal ?? []);
      manifest.journal = null;
      await writeState(paths, manifest);
    },
  };
}

/**
 * Recover after a crash: if state.json carries an unfinished journal, roll it
 * back (restore each mutation's backup in reverse order) and clear it, leaving
 * the manifest in the consistent pre-transaction state. Reads everything from
 * disk, so it works in a fresh process with no in-memory transaction. A no-op
 * when no journal is pending.
 *
 * Read-modify-write: callers MUST run this under {@link import('./lock.js').withLock}
 * (design D11); it is not internally serialised against concurrent state writers.
 */
export async function recoverState(paths: Paths): Promise<RecoveryResult> {
  const manifest = await readState(paths);
  const journal = manifest.journal;
  if (!journal || journal.length === 0) {
    return { recovered: false, rolledBack: 0 };
  }
  await rollbackEntries(paths, journal);
  manifest.journal = null;
  await writeState(paths, manifest);
  return { recovered: true, rolledBack: journal.length };
}
