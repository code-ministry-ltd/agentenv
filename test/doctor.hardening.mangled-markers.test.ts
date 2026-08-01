import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { closeMarker, materialise as fbMaterialise, openMarker } from '../src/file-block.js';
import { resolvePaths, type Paths } from '../src/paths.js';
import {
  expectRealHomeUntouched,
  guardRealHome,
  makeTempHome,
  type RealHomeGuard,
  type TempHome,
} from './helpers.js';

/**
 * Task 5.1 — marker damage of the kinds a real editor, harness or merge inflicts,
 * beyond task 3.3's single "duplicated open marker" case:
 *
 *  - a git merge conflict that duplicates the whole region between `<<<<<<<`
 *    fences;
 *  - an editor rewriting the file with CRLF line endings, which breaks the exact
 *    `\n\n` separator the mechanism anchors sub-blocks on;
 *  - a truncated close marker (a merge or a chopped last line);
 *  - a harness deleting the managed block outright, AFTER the user has edited the
 *    rest of the file;
 *  - one env's region mangled in a file TWO envs own — the case `repairMangledMarkers`
 *    documented as out of scope until this task.
 *
 * Every test asserts the recovered file, not just that a detector fired.
 */

const homes: TempHome[] = [];
const guards: RealHomeGuard[] = [];

function home(): TempHome {
  guards.push(guardRealHome());
  const h = makeTempHome();
  homes.push(h);
  return h;
}

afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
  for (const g of guards.splice(0)) expectRealHomeUntouched(g);
});

const USER_CONTENT = '# user notes\n\nkeep me\n';

interface Fixture {
  paths: Paths;
  target: string;
  storeDir: (env: string) => string;
}

/** A real instruction file plus per-env store instruction sources. */
function seed(th: TempHome): Fixture {
  const paths = resolvePaths(th.env);
  const realHome = join(th.home, 'real');
  mkdirSync(realHome, { recursive: true });
  const target = join(realHome, 'INSTRUCTIONS.md');
  writeFileSync(target, USER_CONTENT);
  return {
    paths,
    target,
    storeDir: (env: string) => join(paths.envDir(env), 'instructions'),
  };
}

/** Write `sources` into an env's store and materialise them as one managed region. */
async function materialiseRegion(
  f: Fixture,
  env: string,
  sources: { name: string; body: string }[],
): Promise<void> {
  const dir = f.storeDir(env);
  mkdirSync(dir, { recursive: true });
  const specs = sources.map((s) => {
    const storePath = join(dir, s.name);
    writeFileSync(storePath, s.body);
    return { source: s.name, storePath };
  });
  await fbMaterialise(f.paths, { target: f.target, env, mode: 'inline', sources: specs });
}

/** How many times an env's open marker appears — exactly 1 in a healthy region. */
function openMarkerCount(text: string, env: string, source: string): number {
  return text.split(openMarker(env, source)).length - 1;
}

describe('doctor.hardening: mangled markers (editor / merge / harness damage)', () => {
  it('a git merge conflict duplicating the region is repaired to one clean region', async () => {
    const th = home();
    const f = seed(th);
    await materialiseRegion(f, 'writing', [{ name: 'base.md', body: 'writing base\n' }]);

    // A merge left BOTH sides of the region plus the conflict fences in the file.
    const withRegion = readFileSync(f.target, 'utf8');
    const open = openMarker('writing', 'base.md');
    const close = closeMarker('writing', 'base.md');
    const region = withRegion.slice(withRegion.indexOf(open), withRegion.indexOf(close) + close.length);
    writeFileSync(
      f.target,
      withRegion.replace(
        region,
        `<<<<<<< HEAD\n${region}\n=======\n${region.replace('writing base', 'their writing base')}\n>>>>>>> theirs`,
      ),
    );

    const res = await run(['doctor'], { env: th.env });
    expect(res.code).not.toBe(0);
    expect(`${res.stdout}${res.stderr ?? ''}`).toContain('mangled-markers');

    const repaired = await run(['doctor', '--repair'], { env: th.env });
    expect(repaired.code, `${repaired.stdout}${repaired.stderr ?? ''}`).toBe(0);

    const fixed = readFileSync(f.target, 'utf8');
    expect(fixed).toContain('keep me'); // pre-activation user content survives
    expect(fixed).not.toContain('<<<<<<<'); // the conflict fences are gone
    expect(fixed).not.toContain('>>>>>>> theirs');
    expect(openMarkerCount(fixed, 'writing', 'base.md')).toBe(1);
    expect(fixed).toContain('writing base');

    expect((await run(['doctor'], { env: th.env })).code).toBe(0);
  });

  it('an editor rewriting the file as CRLF breaks the sub-block anchoring and is repaired', async () => {
    const th = home();
    const f = seed(th);
    await materialiseRegion(f, 'writing', [
      { name: 'base.md', body: 'writing base\n' },
      { name: 'codex.md', body: 'codex extras\n' },
    ]);

    // A Windows-y editor round-trips the file: every LF becomes CRLF, so the
    // exact `\n\n` the mechanism requires between sub-blocks no longer matches.
    const lf = readFileSync(f.target, 'utf8');
    writeFileSync(f.target, lf.replace(/\n/g, '\r\n'));

    const res = await run(['doctor'], { env: th.env });
    expect(res.code).not.toBe(0);
    expect(`${res.stdout}${res.stderr ?? ''}`).toContain('mangled-markers');

    const repaired = await run(['doctor', '--repair'], { env: th.env });
    expect(repaired.code, `${repaired.stdout}${repaired.stderr ?? ''}`).toBe(0);

    const fixed = readFileSync(f.target, 'utf8');
    expect(fixed).toContain('keep me');
    expect(openMarkerCount(fixed, 'writing', 'base.md')).toBe(1);
    expect(openMarkerCount(fixed, 'writing', 'codex.md')).toBe(1);
    expect(fixed).toContain('codex extras');

    expect((await run(['doctor'], { env: th.env })).code).toBe(0);
  });

  it('a truncated close marker is repaired to a well-formed region', async () => {
    const th = home();
    const f = seed(th);
    await materialiseRegion(f, 'writing', [{ name: 'base.md', body: 'writing base\n' }]);

    // The last line was chopped (a bad merge, a truncated write): the open marker
    // is orphaned, so the recorded pair no longer matches the file.
    const text = readFileSync(f.target, 'utf8');
    writeFileSync(f.target, text.replace(`${closeMarker('writing', 'base.md')}\n`, ''));

    const res = await run(['doctor'], { env: th.env });
    expect(res.code).not.toBe(0);
    expect(`${res.stdout}${res.stderr ?? ''}`).toContain('mangled-markers');

    const repaired = await run(['doctor', '--repair'], { env: th.env });
    expect(repaired.code, `${repaired.stdout}${repaired.stderr ?? ''}`).toBe(0);

    const fixed = readFileSync(f.target, 'utf8');
    expect(fixed).toContain('keep me');
    expect(openMarkerCount(fixed, 'writing', 'base.md')).toBe(1);
    expect(fixed).toContain(closeMarker('writing', 'base.md'));

    expect((await run(['doctor'], { env: th.env })).code).toBe(0);
  });

  it('a deleted block is re-inserted WITHOUT discarding edits made since activation', async () => {
    const th = home();
    const f = seed(th);
    await materialiseRegion(f, 'writing', [{ name: 'base.md', body: 'writing base\n' }]);

    // The user keeps working in the file, then a harness rewrites it and drops the
    // whole managed block. Their later notes are NOT agentenv's to throw away: the
    // region is merely absent, so it can be re-inserted into the file as it stands.
    const withRegion = readFileSync(f.target, 'utf8');
    const open = openMarker('writing', 'base.md');
    const close = closeMarker('writing', 'base.md');
    const stripped = `${withRegion.slice(0, withRegion.indexOf(open))}${withRegion.slice(withRegion.indexOf(close) + close.length)}`;
    writeFileSync(f.target, `${stripped}\n## added after activation\n\nprecious\n`);

    const res = await run(['doctor'], { env: th.env });
    expect(res.code).not.toBe(0);
    expect(`${res.stdout}${res.stderr ?? ''}`).toContain('mangled-markers');

    const repaired = await run(['doctor', '--repair'], { env: th.env });
    expect(repaired.code, `${repaired.stdout}${repaired.stderr ?? ''}`).toBe(0);

    const fixed = readFileSync(f.target, 'utf8');
    expect(fixed).toContain('keep me');
    expect(fixed, 'repair discarded user edits made after activation').toContain(
      '## added after activation',
    );
    expect(fixed).toContain('precious');
    expect(openMarkerCount(fixed, 'writing', 'base.md')).toBe(1);

    expect((await run(['doctor'], { env: th.env })).code).toBe(0);
  });

  it("one env's mangled region in a SHARED file does not destroy the other env's region", async () => {
    const th = home();
    const f = seed(th);
    await materialiseRegion(f, 'writing', [{ name: 'base.md', body: 'writing base\n' }]);
    await materialiseRegion(f, 'research', [{ name: 'base.md', body: 'research base\n' }]);

    const before = readFileSync(f.target, 'utf8');
    expect(before).toContain('writing base');
    expect(before).toContain('research base');

    // Only the FIRST env's markers are broken; the second env's region is healthy.
    const open = openMarker('writing', 'base.md');
    writeFileSync(f.target, before.replace(open, `${open}\n${open}`));

    const res = await run(['doctor'], { env: th.env });
    expect(res.code).not.toBe(0);
    expect(`${res.stdout}${res.stderr ?? ''}`).toContain("env 'writing'");

    const repaired = await run(['doctor', '--repair'], { env: th.env });
    expect(repaired.code, `${repaired.stdout}${repaired.stderr ?? ''}`).toBe(0);

    const fixed = readFileSync(f.target, 'utf8');
    expect(fixed).toContain('keep me');
    expect(openMarkerCount(fixed, 'writing', 'base.md')).toBe(1);
    expect(
      openMarkerCount(fixed, 'research', 'base.md'),
      "repairing one env's region destroyed the other env's",
    ).toBe(1);
    expect(fixed).toContain('writing base');
    expect(fixed).toContain('research base');

    expect((await run(['doctor'], { env: th.env })).code).toBe(0);
  });

  // KNOWN GAP, pinned deliberately: a `conflict` rollback discards post-activation user
  // edits AND leaves no way back. This test asserts the CURRENT behaviour so the loss is
  // visible in the suite rather than buried in a notes file — flip the final expectation
  // when the manifest-level rescue concept lands (see `repairMangledMarkers`).
  it('a conflict rollback discards post-activation edits with no backup to recover them', async () => {
    const th = home();
    const f = seed(th);
    await materialiseRegion(f, 'writing', [{ name: 'base.md', body: 'writing base\n' }]);

    // The user writes real work into the file AFTER activation, outside the region.
    const POST_ACTIVATION = 'three months of notes\n';
    writeFileSync(f.target, `${readFileSync(f.target, 'utf8')}\n${POST_ACTIVATION}`);

    // A harness duplicates the open marker: the region reads `conflict`, and repair is
    // deliberately fail-closed — it rolls the file back to its activation-time bytes
    // rather than guess the region's span. That discards the notes above.
    const open = openMarker('writing', 'base.md');
    writeFileSync(f.target, readFileSync(f.target, 'utf8').replace(open, `${open}\n${open}`));

    const repaired = await run(['doctor', '--repair'], { env: th.env });
    expect(repaired.code, `${repaired.stdout}${repaired.stderr ?? ''}`).toBe(0);

    // The rollback itself is the accepted fail-closed trade: agentenv will not guess a
    // mangled region's span. The part that is NOT acceptable — and is unfixed — is that
    // the discarded bytes are recoverable from nowhere.
    expect(readFileSync(f.target, 'utf8')).not.toContain(POST_ACTIVATION);

    // Naively adding `backup(paths, item.path)` before the rollback does not help: a
    // content-addressed backup that no manifest item references reads as an orphan and
    // this same `--repair` run's GC deletes it. Hence the gap, and hence this pin.
    const rescued = readdirSync(f.paths.backups).some((b) =>
      readFileSync(join(f.paths.backups, b), 'utf8').includes(POST_ACTIVATION),
    );
    expect(rescued, 'a rescue backup now survives — flip this pin and close the gap').toBe(
      false,
    );

    expect((await run(['doctor'], { env: th.env })).code).toBe(0);
  });
});
