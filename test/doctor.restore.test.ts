import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { materialise as fbMaterialise } from '../src/file-block.js';
import { resolvePaths } from '../src/paths.js';
import { readState } from '../src/state.js';
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
 * Materialise a region so agentenv captures a content backup of the file's
 * ORIGINAL bytes (design D4: back up before first mutation), then return that
 * backup's id so `doctor --restore <id>` can be exercised.
 */
async function seedBackup(th: TempHome): Promise<{ target: string; backupId: string }> {
  const paths = resolvePaths(th.env);
  const realHome = join(th.home, 'real');
  mkdirSync(realHome, { recursive: true });
  const target = join(realHome, 'INSTRUCTIONS.md');
  writeFileSync(target, '# original user content\nkeep me\n');

  const instrDir = join(paths.envDir('writing'), 'instructions');
  mkdirSync(instrDir, { recursive: true });
  const base = join(instrDir, 'base.md');
  writeFileSync(base, 'writing base\n');
  await fbMaterialise(paths, {
    target,
    env: 'writing',
    mode: 'inline',
    sources: [{ source: 'base.md', storePath: base }],
  });

  const manifest = await readState(paths);
  const fb = manifest.items.find((i) => i.surface === 'file-block');
  const ref = (fb as { backupRef?: { kind: string; hash?: string } }).backupRef;
  const backupId = ref?.kind === 'content' ? (ref.hash ?? '') : '';
  return { target, backupId };
}

describe('doctor: --restore <backup>', () => {
  it('restores a content-addressed backup to its recorded path', async () => {
    const th = home();
    const { target, backupId } = await seedBackup(th);
    expect(backupId).not.toBe('');

    // A harness clobbers the file.
    writeFileSync(target, 'CLOBBERED\n');

    const res = await run(['doctor', '--restore', backupId], { env: th.env });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(target);
    // The original bytes are back.
    expect(readFileSync(target, 'utf8')).toBe('# original user content\nkeep me\n');
  });

  it('errors clearly for a backup id no manifest item references', async () => {
    const th = home();
    await seedBackup(th);

    const res = await run(['doctor', '--restore', 'deadbeef-not-a-real-backup'], { env: th.env });
    expect(res.code).toBe(1);
    expect(res.stderr ?? '').toContain('no manifest item references');
  });

  it('rejects --restore with no id', async () => {
    const th = home();
    const res = await run(['doctor', '--restore'], { env: th.env });
    expect(res.code).toBe(1);
    expect(res.stderr ?? '').toContain('requires a backup id');
  });
});
