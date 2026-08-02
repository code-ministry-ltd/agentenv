import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backup } from '../src/backups.js';
import { run } from '../src/cli.js';
import { resolvePaths } from '../src/paths.js';
import { emptyManifest, readState, writeState, type JournalEntry, type StateManifest } from '../src/state.js';
import { makeTempHome, type TempHome } from './helpers.js';

const homes: TempHome[] = [];
function home(): TempHome {
  const h = makeTempHome();
  homes.push(h);
  return h;
}
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
});

/**
 * Fixture: a state.json carrying a pending journal — an interrupted transaction,
 * exactly what a crash mid-`--global` activation leaves behind (spec criterion 6,
 * design D4). The journal's `undo` restores `path` to the pre-mutation bytes.
 *
 * Here the mutation ADDED a file (`marker.txt`) whose pre-state was `absent`; the
 * journal undo therefore deletes it, returning the surface to consistency.
 */
async function seedPendingJournal(th: TempHome): Promise<{ marker: string }> {
  const paths = resolvePaths(th.env);
  mkdirSync(paths.base, { recursive: true });
  const realHome = join(th.home, 'real');
  mkdirSync(realHome, { recursive: true });
  const marker = join(realHome, 'marker.txt');
  writeFileSync(marker, 'half-applied surface\n');

  // The pre-mutation state of `marker` was "absent" (the activation created it).
  const undoRef = await backup(paths, join(realHome, 'never-existed'));
  const entry: JournalEntry = {
    op: 'add',
    item: {
      action: 'symlink',
      surface: 'dir-merge',
      path: marker,
      target: join(paths.envDir('writing'), 'skills', 'x'),
      ownerEnv: 'writing',
    },
    undo: { path: marker, backupRef: undoRef },
  };
  const manifest: StateManifest = { ...emptyManifest(), journal: [entry] };
  await writeState(paths, manifest);
  return { marker };
}

describe('doctor: journal inconsistencies (interrupted transaction)', () => {
  it('detects a pending journal and exits non-zero without repairing (read-only)', async () => {
    const th = home();
    await seedPendingJournal(th);
    const paths = resolvePaths(th.env);

    const res = await run(['doctor'], { env: th.env });
    expect(res.code).not.toBe(0);
    expect(`${res.stdout}${res.stderr ?? ''}`).toContain('journal');

    // doctor (no flag) never mutates: the journal is still pending.
    const manifest = await readState(paths);
    expect(manifest.journal).not.toBeNull();
    expect(manifest.journal?.length).toBe(1);
  });

  it('--repair rolls the journal back and a re-run reports clean (exit 0)', async () => {
    const th = home();
    const { marker } = await seedPendingJournal(th);
    const paths = resolvePaths(th.env);

    const repair = await run(['doctor', '--repair'], { env: th.env });
    expect(repair.code).toBe(0);

    // The journal is cleared and the half-applied surface was rolled back.
    const manifest = await readState(paths);
    expect(manifest.journal ?? null).toBeNull();
    const { existsSync } = await import('node:fs');
    expect(existsSync(marker)).toBe(false);

    // Idempotent: a second doctor run is clean.
    const rerun = await run(['doctor'], { env: th.env });
    expect(rerun.code).toBe(0);
  });
});
