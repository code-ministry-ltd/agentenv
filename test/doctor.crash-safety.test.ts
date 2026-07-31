import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backup } from '../src/backups.js';
import { run } from '../src/cli.js';
import { materialise as dmMaterialise } from '../src/dir-merge.js';
import { materialise as fbMaterialise } from '../src/file-block.js';
import { resolvePaths } from '../src/paths.js';
import { readState, writeState, type JournalEntry } from '../src/state.js';
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

interface CrashState {
  cfgFile: string;
  originalCfg: string;
  skillLink: string;
  storeSkill: string;
  instr: string;
}

/**
 * Reproduce the on-disk state a kill mid-`--global`-activation leaves (spec
 * criterion 6, design D4). A `use writing --global` applies three surfaces; the
 * dir-merge (skill) and file-block (instructions) surfaces COMMIT first, then the
 * config-keys transaction is interrupted AFTER its write-ahead journal is
 * persisted and its effect ran, but BEFORE commit — so:
 *
 *  - the real config file is HALF-APPLIED (the env's server is present), and
 *  - state.json carries a PENDING journal whose `undo` restores the pre-inject
 *    bytes.
 *
 * `doctor --repair` must roll that back and leave every real surface consistent.
 */
async function seedCrashMidActivation(th: TempHome): Promise<CrashState> {
  const paths = resolvePaths(th.env);
  const realHome = join(th.home, 'real');
  mkdirSync(realHome, { recursive: true });

  // --- store content for env 'writing' ---
  const storeSkill = join(paths.envDir('writing'), 'skills', 'w-skill');
  mkdirSync(storeSkill, { recursive: true });
  writeFileSync(join(storeSkill, 'SKILL.md'), '# w skill\n');
  const instrDir = join(paths.envDir('writing'), 'instructions');
  mkdirSync(instrDir, { recursive: true });
  const base = join(instrDir, 'base.md');
  writeFileSync(base, 'writing base instructions\n');

  // --- pre-existing user surfaces ---
  const skillsDir = join(realHome, 'skills');
  mkdirSync(join(skillsDir, 'user-skill'), { recursive: true });
  writeFileSync(join(skillsDir, 'user-skill', 'SKILL.md'), '# user skill\n');
  const instr = join(realHome, 'INSTRUCTIONS.md');
  writeFileSync(instr, '# user instructions\n\nkeep me\n');
  const cfgFile = join(realHome, 'config.json');
  writeFileSync(cfgFile, '{\n  "mcpServers": {\n    "user": { "url": "u" }\n  }\n}\n');

  // --- surfaces that COMMITTED before the crash ---
  await dmMaterialise(paths, {
    ownerEnv: 'writing',
    sourcePath: storeSkill,
    targetDir: skillsDir,
    itemName: 'w-skill',
    mode: 'symlink',
  });
  await fbMaterialise(paths, {
    target: instr,
    env: 'writing',
    mode: 'inline',
    sources: [{ source: 'base.md', storePath: base }],
  });

  // --- the config-keys transaction interrupted after apply, before commit ---
  const originalCfg = readFileSync(cfgFile, 'utf8');
  const cfgBackup = await backup(paths, cfgFile); // undo bytes = the pre-inject config
  const obj = JSON.parse(originalCfg) as { mcpServers: Record<string, unknown> };
  obj.mcpServers.linear = { url: 'https://linear' }; // half-applied effect
  writeFileSync(cfgFile, JSON.stringify(obj, null, 2));

  const manifest = await readState(paths);
  const pending: JournalEntry = {
    op: 'add',
    item: {
      action: 'config-key',
      surface: 'config-keys',
      path: cfgFile,
      key: 'mcpServers.linear',
      ownerEnv: 'writing',
      mode: 'keyed',
      format: 'json',
      keyPath: ['mcpServers', 'linear'],
      hash: 'unused-on-rollback',
    } as unknown as JournalEntry['item'],
    undo: { path: cfgFile, backupRef: cfgBackup },
  };
  manifest.journal = [pending];
  await writeState(paths, manifest);

  return { cfgFile, originalCfg, skillLink: join(skillsDir, 'w-skill'), storeSkill, instr };
}

describe('doctor: crash safety (spec criterion 6)', () => {
  it('doctor (no flag) reports the interrupted transaction and mutates nothing', async () => {
    const th = home();
    const s = await seedCrashMidActivation(th);
    const paths = resolvePaths(th.env);

    const res = await run(['doctor'], { env: th.env });
    expect(res.code).not.toBe(0);
    expect(`${res.stdout}${res.stderr ?? ''}`).toContain('journal');

    // Read-only: the half-applied surface and the pending journal are untouched.
    expect(readFileSync(s.cfgFile, 'utf8')).toContain('linear');
    expect((await readState(paths)).journal?.length).toBe(1);
  });

  it('--repair returns every real surface to a consistent state, re-run clean', async () => {
    const th = home();
    const s = await seedCrashMidActivation(th);
    const paths = resolvePaths(th.env);

    const repair = await run(['doctor', '--repair'], { env: th.env });
    expect(repair.code).toBe(0);

    // 1. The interrupted config-keys write was rolled back to the pre-inject bytes.
    expect(readFileSync(s.cfgFile, 'utf8')).toBe(s.originalCfg);
    // 2. The journal is cleared.
    expect((await readState(paths)).journal ?? null).toBeNull();
    // 3. The committed surfaces survive: skill symlink + user skill + instructions.
    expect(lstatSync(s.skillLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(s.skillLink)).toBe(s.storeSkill);
    expect(existsSync(join(th.home, 'real', 'skills', 'user-skill'))).toBe(true);
    const instrText = readFileSync(s.instr, 'utf8');
    expect(instrText).toContain('keep me');
    expect(instrText).toContain('writing base instructions');

    // 4. A re-run reports clean.
    const rerun = await run(['doctor'], { env: th.env });
    expect(rerun.code).toBe(0);
  });

  it('--repair is idempotent: a second repair finds nothing and stays clean', async () => {
    const th = home();
    await seedCrashMidActivation(th);

    const first = await run(['doctor', '--repair'], { env: th.env });
    expect(first.code).toBe(0);
    const second = await run(['doctor', '--repair'], { env: th.env });
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('nothing to repair');
  });
});
