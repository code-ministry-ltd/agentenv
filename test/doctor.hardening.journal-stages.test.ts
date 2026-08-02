import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backup, type BackupRef } from '../src/backups.js';
import { run } from '../src/cli.js';
import { injectKeyed } from '../src/config-keys.js';
import { materialise as dmMaterialise } from '../src/dir-merge.js';
import { materialise as fbMaterialise } from '../src/file-block.js';
import { beginTransaction } from '../src/journal.js';
import { withLock } from '../src/lock.js';
import { resolvePaths, type Paths } from '../src/paths.js';
import {
  emptyManifest,
  readState,
  writeState,
  type JournalEntry,
  type ManifestItem,
  type StateManifest,
} from '../src/state.js';
import {
  expectRealHomeUntouched,
  guardRealHome,
  makeTempHome,
  type RealHomeGuard,
  type TempHome,
} from './helpers.js';

/**
 * Task 5.1 — fault injection at EVERY stage of the write-ahead journal, not just
 * one (task 3.3 covered a single config-keys interruption).
 *
 * A `use <env> --global` drives three surface mechanisms, each of which runs the
 * same journal lifecycle: `beginTransaction` → `tx.apply` (journal persisted to
 * disk BEFORE the effect runs) → effect → `tx.commit` (net manifest change +
 * journal cleared in one atomic write), or `tx.rollback`. A process killed at any
 * point therefore lands in exactly one of these on-disk states:
 *
 *  1. journalled, effect NOT yet run              (write-ahead window)
 *  2. journalled, effect run, NOT committed       (half-applied)
 *  3. journalled takeover, effect run, NOT committed (a user item was displaced)
 *  4. multi-entry journal, first applied, second only journalled (partial batch)
 *  5. multi-entry journal, both applied, NOT committed
 *  6. mid-rollback: some undos already restored, journal still pending
 *  7. committed, killed before the caller's next step (nothing left to undo)
 *
 * Each is reproduced here for the surface that really produces it, and each test
 * asserts the RECOVERED state of every real surface — the files, links and config
 * on disk — not merely that a detector fired.
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

/** Everything a stage fixture needs: store content plus untouched user surfaces. */
interface Base {
  paths: Paths;
  /** The env store folder a dir-merge symlink would point at. */
  storeSkill: string;
  /** The env store instruction file a file-block region would render. */
  storeInstr: string;
  /** The real surface dir dir-merge places links into. */
  skillsDir: string;
  /** The user instruction file a file-block region is appended to. */
  instr: string;
  /** The user config file config-keys injects into. */
  cfgFile: string;
  /** Original bytes of `instr`, for a byte-exact recovery assertion. */
  instrBytes: string;
  /** Original bytes of `cfgFile`, for a byte-exact recovery assertion. */
  cfgBytes: string;
}

/** Store content + pre-existing user surfaces, with NO agentenv item applied yet. */
function seedBase(th: TempHome): Base {
  const paths = resolvePaths(th.env);
  mkdirSync(paths.base, { recursive: true });

  const storeSkill = join(paths.envDir('writing'), 'skills', 'w-skill');
  mkdirSync(storeSkill, { recursive: true });
  writeFileSync(join(storeSkill, 'SKILL.md'), '# w skill\n');
  const instrDir = join(paths.envDir('writing'), 'instructions');
  mkdirSync(instrDir, { recursive: true });
  const storeInstr = join(instrDir, 'base.md');
  writeFileSync(storeInstr, 'writing base instructions\n');

  const realHome = join(th.home, 'real');
  const skillsDir = join(realHome, 'skills');
  mkdirSync(join(skillsDir, 'user-skill'), { recursive: true });
  writeFileSync(join(skillsDir, 'user-skill', 'SKILL.md'), '# user skill\n');
  const instr = join(realHome, 'INSTRUCTIONS.md');
  const instrBytes = '# user instructions\n\nkeep me\n';
  writeFileSync(instr, instrBytes);
  const cfgFile = join(realHome, 'config.json');
  const cfgBytes = '{\n  "mcpServers": {\n    "user": { "url": "u" }\n  }\n}\n';
  writeFileSync(cfgFile, cfgBytes);

  return { paths, storeSkill, storeInstr, skillsDir, instr, cfgFile, instrBytes, cfgBytes };
}

/** Persist a hand-crafted pending journal — the on-disk trace of a killed process. */
async function crashWith(
  paths: Paths,
  journal: JournalEntry[],
  items: ManifestItem[] = [],
): Promise<void> {
  const manifest: StateManifest = { ...emptyManifest(), items, journal };
  await writeState(paths, manifest);
}

/** A dir-merge ownership record, as `dir-merge.materialise` would build it. */
function dirMergeItem(path: string, target: string, backupRef: BackupRef): ManifestItem {
  return {
    surface: 'dir-merge',
    action: 'symlink',
    path,
    target,
    ownerEnv: 'writing',
    backupRef,
  } as unknown as ManifestItem;
}

/** A config-keys ownership record, as `config-keys.injectKeyed` would build it. */
function configKeyItem(file: string, name: string): ManifestItem {
  return {
    action: 'config-key',
    surface: 'config-keys',
    path: file,
    key: `mcpServers.${name}`,
    ownerEnv: 'writing',
    mode: 'keyed',
    format: 'json',
    keyPath: ['mcpServers', name],
    hash: 'recorded-at-commit-time',
  } as unknown as ManifestItem;
}

/** Add `name` to the config's `mcpServers`, mirroring a keyed injection's effect. */
function injectServer(cfgFile: string, name: string, url: string): void {
  const obj = JSON.parse(readFileSync(cfgFile, 'utf8')) as { mcpServers: Record<string, unknown> };
  obj.mcpServers[name] = { url };
  writeFileSync(cfgFile, `${JSON.stringify(obj, null, 2)}\n`);
}

/** Backup entry names still on disk — every one should be GC'd by a full repair. */
function backupEntries(paths: Paths): string[] {
  try {
    return readdirSync(paths.backups);
  } catch {
    return [];
  }
}

/** `doctor` (read-only) must fire and must not touch a byte. */
async function expectDetected(th: TempHome, needle: string): Promise<void> {
  const res = await run(['doctor'], { env: th.env });
  expect(res.code).not.toBe(0);
  expect(`${res.stdout}${res.stderr ?? ''}`).toContain(needle);
}

/** `doctor --repair` must succeed and a re-run must report clean. */
async function repairAndVerifyClean(th: TempHome): Promise<void> {
  const repaired = await run(['doctor', '--repair'], { env: th.env });
  expect(repaired.code, `repair failed: ${repaired.stdout}${repaired.stderr ?? ''}`).toBe(0);
  const rerun = await run(['doctor'], { env: th.env });
  expect(rerun.code, `re-run not clean: ${rerun.stdout}${rerun.stderr ?? ''}`).toBe(0);
}

describe('doctor.hardening: kill mid-activation at each journal stage', () => {
  it('stage 1 — dir-merge journalled, effect never ran: rolls back to no link, no record', async () => {
    const th = home();
    const b = seedBase(th);
    const link = join(b.skillsDir, 'w-skill');
    await crashWith(b.paths, [
      {
        op: 'add',
        item: dirMergeItem(link, b.storeSkill, { kind: 'absent' }),
        undo: { path: link, backupRef: { kind: 'absent' } },
      },
    ]);

    await expectDetected(th, 'journal');
    // Read-only: the journal is untouched by a bare doctor.
    expect((await readState(b.paths)).journal?.length).toBe(1);

    await repairAndVerifyClean(th);
    expect(existsSync(link)).toBe(false);
    expect(existsSync(join(b.skillsDir, 'user-skill', 'SKILL.md'))).toBe(true);
    const after = await readState(b.paths);
    expect(after.journal ?? null).toBeNull();
    expect(after.items).toHaveLength(0);
    expect(backupEntries(b.paths)).toHaveLength(0);
  });

  it('stage 2 — dir-merge link placed but not committed: the link is removed', async () => {
    const th = home();
    const b = seedBase(th);
    const link = join(b.skillsDir, 'w-skill');
    symlinkSync(b.storeSkill, link); // the effect ran
    await crashWith(b.paths, [
      {
        op: 'add',
        item: dirMergeItem(link, b.storeSkill, { kind: 'absent' }),
        undo: { path: link, backupRef: { kind: 'absent' } },
      },
    ]);

    await expectDetected(th, 'journal');
    expect(lstatSync(link).isSymbolicLink()).toBe(true); // doctor mutated nothing

    await repairAndVerifyClean(th);
    expect(existsSync(link)).toBe(false);
    expect(existsSync(join(b.skillsDir, 'user-skill', 'SKILL.md'))).toBe(true);
    expect((await readState(b.paths)).items).toHaveLength(0);
    expect(backupEntries(b.paths)).toHaveLength(0);
  });

  it("stage 3 — takeover applied but not committed: the user's displaced item comes back", async () => {
    const th = home();
    const b = seedBase(th);
    // The user already had a skill of that name; a --force takeover backed it up
    // (a directory backup) and replaced it with our link, then the process died.
    const link = join(b.skillsDir, 'w-skill');
    mkdirSync(link, { recursive: true });
    writeFileSync(join(link, 'SKILL.md'), '# THE USERS OWN w-skill\n');
    const takeoverRef = await backup(b.paths, link);
    expect(takeoverRef.kind).toBe('directory');
    rmSync(link, { recursive: true, force: true });
    symlinkSync(b.storeSkill, link);

    await crashWith(b.paths, [
      {
        op: 'add',
        item: dirMergeItem(link, b.storeSkill, takeoverRef),
        undo: { path: link, backupRef: takeoverRef },
      },
    ]);

    await expectDetected(th, 'journal');
    await repairAndVerifyClean(th);

    // The user's own directory is back, byte-for-byte, and nothing is owned.
    expect(lstatSync(link).isDirectory()).toBe(true);
    expect(readFileSync(join(link, 'SKILL.md'), 'utf8')).toBe('# THE USERS OWN w-skill\n');
    expect((await readState(b.paths)).items).toHaveLength(0);
    expect(backupEntries(b.paths)).toHaveLength(0);
  });

  it('stage 4 — file-block journalled, region never written: the file is byte-identical', async () => {
    const th = home();
    const b = seedBase(th);
    const undoRef = await backup(b.paths, b.instr); // pre-write bytes
    await crashWith(b.paths, [
      {
        op: 'add',
        item: {
          surface: 'file-block',
          action: 'file-block',
          path: b.instr,
          key: 'writing',
          ownerEnv: 'writing',
          mode: 'inline',
          subBlocks: [{ source: 'base.md', storePath: b.storeInstr }],
          backupRef: undoRef,
        } as unknown as ManifestItem,
        undo: { path: b.instr, backupRef: undoRef },
      },
    ]);

    await expectDetected(th, 'journal');
    await repairAndVerifyClean(th);

    expect(readFileSync(b.instr, 'utf8')).toBe(b.instrBytes);
    expect((await readState(b.paths)).items).toHaveLength(0);
    expect(backupEntries(b.paths)).toHaveLength(0);
  });

  it('stage 5 — file-block region written but not committed: the region is undone', async () => {
    const th = home();
    const b = seedBase(th);
    const undoRef = await backup(b.paths, b.instr);
    // The effect ran: a well-formed region is now in the file.
    writeFileSync(
      b.instr,
      `${b.instrBytes}\n<!-- >>> agentenv:writing/base.md >>> managed — do not edit between markers -->\nwriting base instructions\n\n<!-- <<< agentenv:writing/base.md <<< -->\n`,
    );
    await crashWith(b.paths, [
      {
        op: 'add',
        item: {
          surface: 'file-block',
          action: 'file-block',
          path: b.instr,
          key: 'writing',
          ownerEnv: 'writing',
          mode: 'inline',
          subBlocks: [{ source: 'base.md', storePath: b.storeInstr }],
          backupRef: undoRef,
        } as unknown as ManifestItem,
        undo: { path: b.instr, backupRef: undoRef },
      },
    ]);

    await expectDetected(th, 'journal');
    expect(readFileSync(b.instr, 'utf8')).toContain('agentenv:writing'); // untouched by doctor

    await repairAndVerifyClean(th);
    // Byte-for-byte back to the user's file: no markers, no leftovers.
    expect(readFileSync(b.instr, 'utf8')).toBe(b.instrBytes);
    expect((await readState(b.paths)).items).toHaveLength(0);
    expect(backupEntries(b.paths)).toHaveLength(0);
  });

  it('stage 6 — config-keys batch half-applied (second key only journalled): full unwind', async () => {
    const th = home();
    const b = seedBase(th);
    // Entry 1: backup taken, key written. Entry 2: backup taken, killed BEFORE
    // its write. The journal must unwind in reverse and land on the user's bytes.
    const undo1 = await backup(b.paths, b.cfgFile);
    injectServer(b.cfgFile, 'linear', 'https://linear');
    const undo2 = await backup(b.paths, b.cfgFile);

    await crashWith(b.paths, [
      {
        op: 'add',
        item: configKeyItem(b.cfgFile, 'linear'),
        undo: { path: b.cfgFile, backupRef: undo1 },
      },
      {
        op: 'add',
        item: configKeyItem(b.cfgFile, 'notion'),
        undo: { path: b.cfgFile, backupRef: undo2 },
      },
    ]);

    await expectDetected(th, 'journal');
    await repairAndVerifyClean(th);

    expect(readFileSync(b.cfgFile, 'utf8')).toBe(b.cfgBytes);
    expect((await readState(b.paths)).items).toHaveLength(0);
    expect(backupEntries(b.paths)).toHaveLength(0);
  });

  it('stage 7 — config-keys batch fully applied but not committed: full unwind', async () => {
    const th = home();
    const b = seedBase(th);
    const undo1 = await backup(b.paths, b.cfgFile);
    injectServer(b.cfgFile, 'linear', 'https://linear');
    const undo2 = await backup(b.paths, b.cfgFile);
    injectServer(b.cfgFile, 'notion', 'https://notion');

    await crashWith(b.paths, [
      {
        op: 'add',
        item: configKeyItem(b.cfgFile, 'linear'),
        undo: { path: b.cfgFile, backupRef: undo1 },
      },
      {
        op: 'add',
        item: configKeyItem(b.cfgFile, 'notion'),
        undo: { path: b.cfgFile, backupRef: undo2 },
      },
    ]);

    await expectDetected(th, 'journal');
    await repairAndVerifyClean(th);

    expect(readFileSync(b.cfgFile, 'utf8')).toBe(b.cfgBytes);
    expect((await readState(b.paths)).items).toHaveLength(0);
    expect(backupEntries(b.paths)).toHaveLength(0);
  });

  it('stage 8 — killed MID-rollback: recovery finishes the unwind idempotently', async () => {
    const th = home();
    const b = seedBase(th);
    const undo1 = await backup(b.paths, b.cfgFile);
    injectServer(b.cfgFile, 'linear', 'https://linear');
    const undo2 = await backup(b.paths, b.cfgFile);
    injectServer(b.cfgFile, 'notion', 'https://notion');

    // A rollback started: the LAST entry's undo was already restored (notion is
    // gone again), then the process died before the first entry and before the
    // journal could be cleared.
    injectServer(b.cfgFile, 'linear', 'https://linear');
    const partiallyRolledBack = JSON.parse(readFileSync(b.cfgFile, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    delete partiallyRolledBack.mcpServers.notion;
    writeFileSync(b.cfgFile, `${JSON.stringify(partiallyRolledBack, null, 2)}\n`);

    await crashWith(b.paths, [
      {
        op: 'add',
        item: configKeyItem(b.cfgFile, 'linear'),
        undo: { path: b.cfgFile, backupRef: undo1 },
      },
      {
        op: 'add',
        item: configKeyItem(b.cfgFile, 'notion'),
        undo: { path: b.cfgFile, backupRef: undo2 },
      },
    ]);

    await expectDetected(th, 'journal');
    await repairAndVerifyClean(th);

    // Re-restoring an already-restored entry is harmless: we land on the user's bytes.
    expect(readFileSync(b.cfgFile, 'utf8')).toBe(b.cfgBytes);
    expect((await readState(b.paths)).items).toHaveLength(0);
    expect(backupEntries(b.paths)).toHaveLength(0);
  });

  it('stage 9 — killed AFTER commit: no surface is disturbed, only backups are GCd', async () => {
    const th = home();
    const b = seedBase(th);

    // Drive all three real mechanisms to a committed state — the manifest and every
    // surface agree; the process simply died before its next step.
    await dmMaterialise(b.paths, {
      ownerEnv: 'writing',
      sourcePath: b.storeSkill,
      targetDir: b.skillsDir,
      itemName: 'w-skill',
      mode: 'symlink',
    });
    await fbMaterialise(b.paths, {
      target: b.instr,
      env: 'writing',
      mode: 'inline',
      sources: [{ source: 'base.md', storePath: b.storeInstr }],
    });
    await withLock(b.paths, async () => {
      const tx = await beginTransaction(b.paths);
      await injectKeyed(b.paths, tx, {
        file: b.cfgFile,
        format: 'json',
        keyPath: ['mcpServers', 'linear'],
        value: { url: 'https://linear' },
        ownerEnv: 'writing',
      });
      await tx.commit();
    });

    const link = join(b.skillsDir, 'w-skill');
    const instrAfter = readFileSync(b.instr, 'utf8');
    const cfgAfter = readFileSync(b.cfgFile, 'utf8');

    // NO detector may fire over a consistent post-commit state except the benign
    // backup GC (a committed config-keys transaction de-references its undo bytes).
    const res = await run(['doctor'], { env: th.env });
    const report = `${res.stdout}${res.stderr ?? ''}`;
    for (const kind of [
      'journal-pending',
      'dangling-symlink',
      'store-drift',
      'mangled-markers',
      'reserialised-config',
    ]) {
      expect(report, `false positive after a clean commit`).not.toContain(kind);
    }

    await repairAndVerifyClean(th);

    // Every committed surface survives untouched.
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(b.instr, 'utf8')).toBe(instrAfter);
    expect(readFileSync(b.cfgFile, 'utf8')).toBe(cfgAfter);
    expect((await readState(b.paths)).items).toHaveLength(3);
  });
});
