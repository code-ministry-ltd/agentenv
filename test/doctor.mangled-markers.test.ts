import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { materialise as fbMaterialise, openMarker } from '../src/file-block.js';
import { resolvePaths } from '../src/paths.js';
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
 * Fixture: a well-formed managed region materialised through the real mechanism,
 * then its markers BROKEN on disk (a duplicated open marker) as a harness rewrite
 * would (design D4). The manifest still records a region that is no longer
 * well-formed — repair restores the original + re-materialises a clean region.
 */
async function seedMangled(th: TempHome): Promise<{ target: string }> {
  const paths = resolvePaths(th.env);
  const realHome = join(th.home, 'real');
  mkdirSync(realHome, { recursive: true });
  const target = join(realHome, 'INSTRUCTIONS.md');
  writeFileSync(target, '# user notes\n\nkeep me\n');

  const instrDir = join(paths.envDir('writing'), 'instructions');
  mkdirSync(instrDir, { recursive: true });
  const base = join(instrDir, 'base.md');
  writeFileSync(base, 'writing base instructions\n');

  await fbMaterialise(paths, {
    target,
    env: 'writing',
    mode: 'inline',
    sources: [{ source: 'base.md', storePath: base }],
  });

  // Break the markers: duplicate the open marker so the region no longer matches
  // the manifest (three markers claim the env where two are expected → conflict).
  const open = openMarker('writing', 'base.md');
  const clean = readFileSync(target, 'utf8');
  writeFileSync(target, clean.replace(open, `${open}\n${open}`));
  return { target };
}

describe('doctor: mangled marker regions', () => {
  it('detects broken markers and exits non-zero (read-only)', async () => {
    const th = home();
    const { target } = await seedMangled(th);
    const before = readFileSync(target, 'utf8');

    const res = await run(['doctor'], { env: th.env });
    expect(res.code).not.toBe(0);
    expect(`${res.stdout}${res.stderr ?? ''}`).toContain('marker');
    // Never mutates: the file is still mangled.
    expect(readFileSync(target, 'utf8')).toBe(before);
  });

  it('--repair restores a well-formed region, keeps user content, re-run clean', async () => {
    const th = home();
    const { target } = await seedMangled(th);

    const repair = await run(['doctor', '--repair'], { env: th.env });
    expect(repair.code).toBe(0);

    const fixed = readFileSync(target, 'utf8');
    // User content survives; exactly one well-formed open marker; store body present.
    expect(fixed).toContain('keep me');
    expect(fixed).toContain('writing base instructions');
    const open = openMarker('writing', 'base.md');
    expect(fixed.split(open).length - 1).toBe(1);

    const rerun = await run(['doctor'], { env: th.env });
    expect(rerun.code).toBe(0);
  });
});
