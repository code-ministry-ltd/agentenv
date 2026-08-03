import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backup } from '../src/backups.js';
import { run } from '../src/cli.js';
import { resolvePaths } from '../src/paths.js';
import { readState, writeState, type JournalEntry, type ManifestItem } from '../src/state.js';
import { FIXTURE_CONFIG_ENV, makeFixtureAdapter } from './fixtures/fixture-adapter.js';
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

/** Persist an aborted transaction: a pending journal whose effect was applied but never committed. */
async function persistPendingJournal(paths: ReturnType<typeof resolvePaths>, entry: JournalEntry): Promise<void> {
  const manifest = await readState(paths);
  manifest.items = [];
  manifest.journal = [entry];
  await writeState(paths, manifest);
}

describe('engine: crash recovery', () => {
  it('AC: a pending dir-merge add (stray symlink) is rolled back by the next command', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const realHome = join(th.home, 'real');
    mkdirSync(join(realHome, 'skills'), { recursive: true });
    // The interrupted effect: a symlink placed but never committed to the manifest.
    const strayLink = join(realHome, 'skills', 'w-skill');
    symlinkSync(join(paths.envDir('writing'), 'skills', 'w-skill'), strayLink);
    expect(lstatSync(strayLink).isSymbolicLink()).toBe(true);

    const item: ManifestItem = {
      surface: 'dir-merge',
      action: 'symlink',
      path: strayLink,
      ownerEnv: 'writing',
    } as unknown as ManifestItem;
    await persistPendingJournal(paths, {
      op: 'add',
      item,
      undo: { path: strayLink, backupRef: { kind: 'absent' } },
    });

    const env: NodeJS.ProcessEnv = { ...th.env, [FIXTURE_CONFIG_ENV]: realHome };
    const res = await run(['drop', '--global'], { env, adapters: [makeFixtureAdapter()] });
    expect(res.code).toBe(0);

    // recoverState rolled back the aborted add: the stray symlink is gone, the
    // journal is cleared, and the manifest is consistent (nothing owned).
    expect(existsSync(strayLink)).toBe(false);
    const after = await readState(paths);
    expect(after.journal ?? null).toBeNull();
    expect(after.items).toEqual([]);
  });

  it('AC: a pending config-file mutation is restored from its backup on the next command', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const realHome = join(th.home, 'real');
    mkdirSync(realHome, { recursive: true });
    const cfgPath = join(realHome, 'config.json');
    const original = '{\n  "mcpServers": {}\n}\n';
    writeFileSync(cfgPath, original);

    // Back up the original (populates the content store), then apply a half-write.
    const backupRef = await backup(paths, cfgPath);
    writeFileSync(cfgPath, '{\n  "mcpServers": { "linear": { "url": "x" } }\n}\n');

    const item: ManifestItem = {
      surface: 'config-keys',
      action: 'config-key',
      path: cfgPath,
      ownerEnv: 'writing',
    } as unknown as ManifestItem;
    await persistPendingJournal(paths, { op: 'add', item, undo: { path: cfgPath, backupRef } });

    const env: NodeJS.ProcessEnv = { ...th.env, [FIXTURE_CONFIG_ENV]: realHome };
    const res = await run(['drop', '--global'], { env, adapters: [makeFixtureAdapter()] });
    expect(res.code).toBe(0);

    expect(readFileSync(cfgPath, 'utf8')).toBe(original); // restored byte-for-byte
    const after = await readState(paths);
    expect(after.journal ?? null).toBeNull();
  });
});
