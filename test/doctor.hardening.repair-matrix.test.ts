import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backup } from '../src/backups.js';
import { run } from '../src/cli.js';
import { injectKeyed } from '../src/config-keys.js';
import { materialise as fbMaterialise, openMarker } from '../src/file-block.js';
import { beginTransaction } from '../src/journal.js';
import { withLock } from '../src/lock.js';
import { resolvePaths, type Paths } from '../src/paths.js';
import { readState, writeState, type ManifestItem } from '../src/state.js';
import {
  expectRealHomeUntouched,
  guardRealHome,
  makeTempHome,
  type RealHomeGuard,
  type TempHome,
} from './helpers.js';

/**
 * Task 5.1's acceptance bar: a PROVEN `--repair` recovery path for every one of
 * the six detector kinds. The individual detector suites (task 3.3) each fault one
 * surface in isolation; this faults ALL SIX AT ONCE — which is what a real crash
 * plus a real harness rewrite actually leaves behind — and asserts that one repair
 * pass returns every surface to a consistent state:
 *
 *   journal-pending      → the interrupted mutation is rolled back
 *   dangling-symlink     → the link is re-materialised from the store
 *   store-drift          → the sourceless materialisation + record are dropped
 *   mangled-markers      → the region is rebuilt well-formed
 *   reserialised-config  → the record is reconciled to the parsed value
 *   orphaned-backup      → the unreferenced backup is deleted
 *
 * The seventh case — a config file that does not PARSE — has no automatic repair
 * by design; it is covered in doctor.hardening.reserialised, which asserts it is
 * reported as unrepairable with guidance rather than silently skipped.
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

const USER_INSTR = '# user instructions\n\nkeep me\n';

interface Broken {
  paths: Paths;
  /** journal-pending: the half-applied file the pending mutation created. */
  halfApplied: string;
  /** dangling-symlink: an owned link that resolves to nothing (store source present). */
  danglingLink: string;
  /** The store folder `danglingLink` must be pointed back at. */
  liveSource: string;
  /** store-drift: an owned link whose store source no longer exists. */
  sourcelessLink: string;
  /** mangled-markers: an instruction file whose owned region was broken. */
  instr: string;
  /** reserialised-config: a config file whose owned key a harness rewrote. */
  cfgFile: string;
  /** orphaned-backup: a backup entry no manifest record references. */
  orphanBackup: string;
}

/** Break all six things at once, using the real mechanisms wherever they apply. */
async function breakEverything(th: TempHome): Promise<Broken> {
  const paths = resolvePaths(th.env);
  mkdirSync(paths.base, { recursive: true });
  const realHome = join(th.home, 'real');
  const skillsDir = join(realHome, 'skills');
  mkdirSync(skillsDir, { recursive: true });

  // --- mangled-markers: materialise for real, then break the markers ---
  const instr = join(realHome, 'INSTRUCTIONS.md');
  writeFileSync(instr, USER_INSTR);
  const instrDir = join(paths.envDir('writing'), 'instructions');
  mkdirSync(instrDir, { recursive: true });
  const base = join(instrDir, 'base.md');
  writeFileSync(base, 'writing base instructions\n');
  await fbMaterialise(paths, {
    target: instr,
    env: 'writing',
    mode: 'inline',
    sources: [{ source: 'base.md', storePath: base }],
  });
  const open = openMarker('writing', 'base.md');
  writeFileSync(instr, readFileSync(instr, 'utf8').replace(open, `${open}\n${open}`));

  // --- reserialised-config: inject for real, then let a harness rewrite the value ---
  const cfgFile = join(realHome, 'config.json');
  writeFileSync(cfgFile, '{\n  "mcpServers": {\n    "user": { "url": "u" }\n  }\n}\n');
  await withLock(paths, async () => {
    const tx = await beginTransaction(paths);
    await injectKeyed(paths, tx, {
      file: cfgFile,
      format: 'json',
      keyPath: ['mcpServers', 'linear'],
      value: { url: 'https://linear' },
      ownerEnv: 'writing',
    });
    await tx.commit();
  });
  const parsed = JSON.parse(readFileSync(cfgFile, 'utf8')) as {
    mcpServers: Record<string, unknown>;
  };
  parsed.mcpServers.linear = { url: 'https://linear/v2' };
  writeFileSync(cfgFile, JSON.stringify(parsed, null, 2));

  // --- dangling-symlink: store source present, owned placement missing ---
  const liveSource = join(paths.envDir('writing'), 'skills', 'live-skill');
  mkdirSync(liveSource, { recursive: true });
  writeFileSync(join(liveSource, 'SKILL.md'), '# live skill\n');
  const danglingLink = join(skillsDir, 'live-skill');

  // --- store-drift: the store source was deleted, the link still points at it ---
  const goneSource = join(paths.envDir('writing'), 'skills', 'gone-skill');
  const sourcelessLink = join(skillsDir, 'gone-skill');
  symlinkSync(goneSource, sourcelessLink);

  // --- orphaned-backup: bytes under backups/ that nothing references ---
  const stray = join(realHome, 'stray.txt');
  writeFileSync(stray, 'orphaned bytes referenced by no manifest record\n');
  const strayRef = await backup(paths, stray);
  const orphanBackup = join(paths.backups, strayRef.kind === 'content' ? strayRef.hash : '');

  // --- journal-pending: a mutation journalled and applied, never committed ---
  const halfApplied = join(realHome, 'half-applied.txt');
  writeFileSync(halfApplied, 'the effect ran; the commit never did\n');

  const manifest = await readState(paths);
  manifest.items.push(
    {
      surface: 'dir-merge',
      action: 'symlink',
      path: danglingLink,
      target: liveSource,
      ownerEnv: 'writing',
      backupRef: { kind: 'absent' },
    } as unknown as ManifestItem,
    {
      surface: 'dir-merge',
      action: 'symlink',
      path: sourcelessLink,
      target: goneSource,
      ownerEnv: 'writing',
      backupRef: { kind: 'absent' },
    } as unknown as ManifestItem,
  );
  manifest.journal = [
    {
      op: 'add',
      item: {
        surface: 'dir-merge',
        action: 'symlink',
        path: halfApplied,
        target: join(paths.envDir('writing'), 'skills', 'pending'),
        ownerEnv: 'writing',
      } as unknown as ManifestItem,
      undo: { path: halfApplied, backupRef: { kind: 'absent' } },
    },
  ];
  await writeState(paths, manifest);

  return {
    paths,
    halfApplied,
    danglingLink,
    liveSource,
    sourcelessLink,
    instr,
    cfgFile,
    orphanBackup,
  };
}

describe('doctor.hardening: a repair path for every detector kind', () => {
  it('reports all six kinds at once and mutates nothing', async () => {
    const th = home();
    const b = await breakEverything(th);

    const res = await run(['doctor'], { env: th.env });
    expect(res.code).not.toBe(0);
    const report = `${res.stdout}${res.stderr ?? ''}`;
    for (const kind of [
      'journal-pending',
      'dangling-symlink',
      'store-drift',
      'mangled-markers',
      'reserialised-config',
      'orphaned-backup',
    ]) {
      expect(report, `${kind} was not reported`).toContain(`[${kind}]`);
    }

    // Read-only, with six problems on the floor: every one is still there.
    expect(existsSync(b.halfApplied)).toBe(true);
    expect(existsSync(b.danglingLink)).toBe(false); // still resolves to nothing
    expect(lstatSync(b.sourcelessLink).isSymbolicLink()).toBe(true);
    expect(readFileSync(b.instr, 'utf8').split(openMarker('writing', 'base.md')).length - 1).toBe(2);
    expect(existsSync(b.orphanBackup)).toBe(true);
    expect((await readState(b.paths)).journal?.length).toBe(1);
  });

  it('one --repair pass returns all six to a consistent state', async () => {
    const th = home();
    const b = await breakEverything(th);

    const repaired = await run(['doctor', '--repair'], { env: th.env });
    expect(repaired.code, `${repaired.stdout}${repaired.stderr ?? ''}`).toBe(0);
    const actions = repaired.stdout;

    // 1. journal-pending → the half-applied effect is undone, the journal cleared.
    expect(actions).toContain('rolled back 1 journalled mutation(s)');
    expect(existsSync(b.halfApplied)).toBe(false);
    expect((await readState(b.paths)).journal ?? null).toBeNull();

    // 2. dangling-symlink → re-materialised at the store source, and it resolves.
    expect(actions).toContain('re-materialised dangling link');
    expect(lstatSync(b.danglingLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(b.danglingLink)).toBe(b.liveSource);
    expect(statSync(b.danglingLink).isDirectory()).toBe(true);
    expect(readFileSync(join(b.danglingLink, 'SKILL.md'), 'utf8')).toBe('# live skill\n');

    // 3. store-drift → the sourceless link and its ownership record are gone.
    expect(actions).toContain('dropped orphaned materialisation');
    let stillLinked = true;
    try {
      lstatSync(b.sourcelessLink);
    } catch {
      stillLinked = false;
    }
    expect(stillLinked).toBe(false);

    // 4. mangled-markers → exactly one well-formed region; user content survives.
    expect(actions).toContain('restored mangled marker region');
    const instrText = readFileSync(b.instr, 'utf8');
    expect(instrText.split(openMarker('writing', 'base.md')).length - 1).toBe(1);
    expect(instrText).toContain('keep me');
    expect(instrText).toContain('writing base instructions');

    // 5. reserialised-config → the record agrees with the file; both keys stand.
    expect(actions).toContain('reconciled reserialised config key');
    const cfg = JSON.parse(readFileSync(b.cfgFile, 'utf8')) as {
      mcpServers: Record<string, { url: string } | undefined>;
    };
    expect(cfg.mcpServers.linear?.url).toBe('https://linear/v2');
    expect(cfg.mcpServers.user?.url).toBe('u');

    // 6. orphaned-backup → deleted, and no repair of the five above left a new one.
    expect(actions).toContain('removed orphaned backup');
    expect(existsSync(b.orphanBackup)).toBe(false);

    // The manifest now owns exactly the surfaces that still exist.
    const after = await readState(b.paths);
    expect(after.items.map((i) => i.path).sort()).toEqual(
      [b.cfgFile, b.danglingLink, b.instr].sort(),
    );

    const rerun = await run(['doctor'], { env: th.env });
    expect(rerun.code, `${rerun.stdout}${rerun.stderr ?? ''}`).toBe(0);
  });

  it('repairing six faults at once is idempotent and leaves no backup churn', async () => {
    const th = home();
    const b = await breakEverything(th);

    expect((await run(['doctor', '--repair'], { env: th.env })).code).toBe(0);
    const settled = readdirSync(b.paths.backups).sort();
    const instrAfter = readFileSync(b.instr, 'utf8');
    const cfgAfter = readFileSync(b.cfgFile, 'utf8');

    const second = await run(['doctor', '--repair'], { env: th.env });
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('nothing to repair');

    // A second pass must not re-write surfaces, nor churn the backup store.
    expect(readFileSync(b.instr, 'utf8')).toBe(instrAfter);
    expect(readFileSync(b.cfgFile, 'utf8')).toBe(cfgAfter);
    expect(readdirSync(b.paths.backups).sort()).toEqual(settled);
  });
});
