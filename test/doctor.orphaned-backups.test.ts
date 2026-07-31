import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backup } from '../src/backups.js';
import { run } from '../src/cli.js';
import { resolvePaths } from '../src/paths.js';
import { writeState, type ManifestItem, type StateManifest } from '../src/state.js';
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
 * Fixture: one referenced backup (a manifest item points at it) and one ORPHANED
 * backup (no manifest ref points at it) sitting under `~/.agentenv/backups/`. The
 * orphan is what a committed transaction leaves behind once its journal clears
 * (design D4) — doctor garbage-collects it, the referenced one it must keep.
 */
async function seed(th: TempHome): Promise<{ orphan: string; referenced: string }> {
  const paths = resolvePaths(th.env);
  mkdirSync(paths.base, { recursive: true });
  const realHome = join(th.home, 'real');
  mkdirSync(realHome, { recursive: true });

  // A referenced content backup: a manifest file-block item carries its ref.
  const userFile = join(realHome, 'INSTRUCTIONS.md');
  writeFileSync(userFile, '# user\n');
  const referencedRef = await backup(paths, userFile); // kind: content, hash
  const referencedHash = referencedRef.kind === 'content' ? referencedRef.hash : '';

  // An ORPHAN content backup: bytes copied into the store that nothing references.
  const strayFile = join(realHome, 'stray.txt');
  writeFileSync(strayFile, 'orphaned bytes that no manifest item references\n');
  const orphanRef = await backup(paths, strayFile);
  const orphanHash = orphanRef.kind === 'content' ? orphanRef.hash : '';

  const item: ManifestItem = {
    action: 'file-block',
    surface: 'file-block',
    path: userFile,
    key: 'writing',
    ownerEnv: 'writing',
    mode: 'inline',
    subBlocks: [],
    backupRef: referencedRef,
  } as unknown as ManifestItem;
  const manifest: StateManifest = { version: '1.0', items: [item], journal: null };
  await writeState(paths, manifest);

  return {
    orphan: join(paths.backups, orphanHash),
    referenced: join(paths.backups, referencedHash),
  };
}

describe('doctor: orphaned backups', () => {
  it('detects an orphaned backup and exits non-zero (read-only)', async () => {
    const th = home();
    const { orphan } = await seed(th);

    const res = await run(['doctor'], { env: th.env });
    expect(res.code).not.toBe(0);
    expect(`${res.stdout}${res.stderr ?? ''}`).toContain('backup');
    // Never mutates: the orphan is still on disk.
    expect(existsSync(orphan)).toBe(true);
  });

  it('--repair removes the orphan, keeps the referenced backup, re-run clean', async () => {
    const th = home();
    const { orphan, referenced } = await seed(th);

    const repair = await run(['doctor', '--repair'], { env: th.env });
    expect(repair.code).toBe(0);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(referenced)).toBe(true);

    const rerun = await run(['doctor'], { env: th.env });
    expect(rerun.code).toBe(0);
  });
});
