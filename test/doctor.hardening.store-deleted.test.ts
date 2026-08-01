import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { injectKeyed } from '../src/config-keys.js';
import { materialise as dmMaterialise } from '../src/dir-merge.js';
import { materialise as fbMaterialise } from '../src/file-block.js';
import { beginTransaction } from '../src/journal.js';
import { withLock } from '../src/lock.js';
import { resolvePaths, type Paths } from '../src/paths.js';
import { readState } from '../src/state.js';
import {
  expectRealHomeUntouched,
  guardRealHome,
  makeTempHome,
  type RealHomeGuard,
  type TempHome,
} from './helpers.js';

/**
 * Task 5.1 — the store vanishes from under a LIVE activation: someone deletes
 * `~/.agentenv/store/environments/<env>` (or the whole store) while its items are
 * still materialised on the real surfaces.
 *
 * The manifest is self-describing, so `doctor` can still say exactly what each
 * record owns — and `--repair` must return those surfaces to the user rather than
 * leave sourceless links and regions behind, WITHOUT touching anything it does not
 * own and without needing the store it just lost.
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
const USER_CFG = '{\n  "mcpServers": {\n    "user": { "url": "u" }\n  }\n}\n';

interface Active {
  paths: Paths;
  skillsDir: string;
  link: string;
  instr: string;
  cfgFile: string;
}

/** Store an env's content and materialise all three surfaces from it. */
async function activate(th: TempHome, opts: { sources?: string[] } = {}): Promise<Active> {
  const paths = resolvePaths(th.env);
  const sources = opts.sources ?? ['base.md'];

  const storeSkill = join(paths.envDir('writing'), 'skills', 'w-skill');
  mkdirSync(storeSkill, { recursive: true });
  writeFileSync(join(storeSkill, 'SKILL.md'), '# w skill\n');
  const instrDir = join(paths.envDir('writing'), 'instructions');
  mkdirSync(instrDir, { recursive: true });
  const specs = sources.map((name) => {
    const storePath = join(instrDir, name);
    writeFileSync(storePath, `writing ${name} body\n`);
    return { source: name, storePath };
  });

  const realHome = join(th.home, 'real');
  const skillsDir = join(realHome, 'skills');
  mkdirSync(skillsDir, { recursive: true });
  const instr = join(realHome, 'INSTRUCTIONS.md');
  writeFileSync(instr, USER_INSTR);
  const cfgFile = join(realHome, 'config.json');
  writeFileSync(cfgFile, USER_CFG);

  await dmMaterialise(paths, {
    ownerEnv: 'writing',
    sourcePath: storeSkill,
    targetDir: skillsDir,
    itemName: 'w-skill',
    mode: 'symlink',
  });
  await fbMaterialise(paths, { target: instr, env: 'writing', mode: 'inline', sources: specs });
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

  return { paths, skillsDir, link: join(skillsDir, 'w-skill'), instr, cfgFile };
}

function backupEntries(paths: Paths): string[] {
  try {
    return readdirSync(paths.backups);
  } catch {
    return [];
  }
}

describe('doctor.hardening: store deleted while an env is active', () => {
  it('reports every sourceless surface and returns each one to the user', async () => {
    const th = home();
    const a = await activate(th);
    expect(readFileSync(a.instr, 'utf8')).toContain('writing base.md body');

    // The store is deleted out from under the live activation.
    rmSync(a.paths.envDir('writing'), { recursive: true, force: true });

    const res = await run(['doctor'], { env: th.env });
    expect(res.code).not.toBe(0);
    const report = `${res.stdout}${res.stderr ?? ''}`;
    expect(report).toContain('store-drift');
    expect(report, 'the sourceless symlink was not reported').toContain(a.link);
    expect(report, 'the sourceless managed region was not reported').toContain(a.instr);

    // Read-only: nothing has moved yet.
    expect(lstatSync(a.link).isSymbolicLink()).toBe(true);
    expect(readFileSync(a.instr, 'utf8')).toContain('agentenv:writing');

    const repaired = await run(['doctor', '--repair'], { env: th.env });
    expect(repaired.code, `${repaired.stdout}${repaired.stderr ?? ''}`).toBe(0);

    // The sourceless link is gone and the instruction file is byte-for-byte the
    // user's again — the round-trip guarantee survives losing the store.
    expect(existsSync(a.link)).toBe(false);
    expect(readFileSync(a.instr, 'utf8')).toBe(USER_INSTR);

    // The injected config key is NOT collateral: the manifest still describes it
    // in full, so `drop` can still remove it and doctor must leave it alone.
    const cfg = JSON.parse(readFileSync(a.cfgFile, 'utf8')) as {
      mcpServers: Record<string, { url: string } | undefined>;
    };
    expect(cfg.mcpServers.linear?.url).toBe('https://linear');
    expect(cfg.mcpServers.user?.url).toBe('u');

    const after = await readState(a.paths);
    expect(after.items.map((i) => i.surface)).toEqual(['config-keys']);
    expect(after.journal ?? null).toBeNull();
    expect(backupEntries(a.paths)).toHaveLength(0);

    expect((await run(['doctor'], { env: th.env })).code).toBe(0);
  });

  it('a takeover the store no longer backs is handed back to the user intact', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const storeSkill = join(paths.envDir('writing'), 'skills', 'w-skill');
    mkdirSync(storeSkill, { recursive: true });
    writeFileSync(join(storeSkill, 'SKILL.md'), '# store w skill\n');

    // The user already had a skill of that name; the env took it over (backing it up).
    const skillsDir = join(th.home, 'real', 'skills');
    const usersOwn = join(skillsDir, 'w-skill');
    mkdirSync(usersOwn, { recursive: true });
    writeFileSync(join(usersOwn, 'SKILL.md'), '# THE USERS OWN w-skill\n');
    await dmMaterialise(paths, {
      ownerEnv: 'writing',
      sourcePath: storeSkill,
      targetDir: skillsDir,
      itemName: 'w-skill',
      mode: 'symlink',
      force: true,
    });
    expect(lstatSync(usersOwn).isSymbolicLink()).toBe(true);

    rmSync(paths.store, { recursive: true, force: true }); // the WHOLE store, not just the env

    const res = await run(['doctor'], { env: th.env });
    expect(res.code).not.toBe(0);
    expect(`${res.stdout}${res.stderr ?? ''}`).toContain('store-drift');

    const repaired = await run(['doctor', '--repair'], { env: th.env });
    expect(repaired.code, `${repaired.stdout}${repaired.stderr ?? ''}`).toBe(0);

    // Losing the store must not cost the user the item the env had displaced.
    expect(lstatSync(usersOwn).isDirectory()).toBe(true);
    expect(readFileSync(join(usersOwn, 'SKILL.md'), 'utf8')).toBe('# THE USERS OWN w-skill\n');
    expect((await readState(paths)).items).toHaveLength(0);
    expect(backupEntries(paths)).toHaveLength(0);

    expect((await run(['doctor'], { env: th.env })).code).toBe(0);
  });

  it('a PARTIAL store loss is deliberately left alone rather than dropped wholesale', async () => {
    const th = home();
    const paths = resolvePaths(th.env);
    const instrDir = join(paths.envDir('writing'), 'instructions');
    const realHome = join(th.home, 'real');
    mkdirSync(realHome, { recursive: true });
    const instr = join(realHome, 'INSTRUCTIONS.md');
    writeFileSync(instr, USER_INSTR);
    mkdirSync(instrDir, { recursive: true });
    const specs = ['base.md', 'codex.md'].map((name) => {
      const storePath = join(instrDir, name);
      writeFileSync(storePath, `writing ${name} body\n`);
      return { source: name, storePath };
    });
    await fbMaterialise(paths, { target: instr, env: 'writing', mode: 'inline', sources: specs });

    // Only ONE of the two contributed store files is deleted. Dropping the whole
    // region would throw away the sub-block that is still perfectly good, so the
    // store-drift detector requires EVERY source to be gone.
    rmSync(join(instrDir, 'codex.md'), { force: true });

    const res = await run(['doctor'], { env: th.env });
    expect(res.code, `${res.stdout}${res.stderr ?? ''}`).toBe(0);
    const text = readFileSync(instr, 'utf8');
    expect(text).toContain('writing base.md body');
    expect(text).toContain('writing codex.md body');
  });

  it('the store AND the manifest vanishing leaves doctor with nothing to say', async () => {
    const th = home();
    const a = await activate(th);
    rmSync(a.paths.store, { recursive: true, force: true });
    rmSync(a.paths.state, { force: true });
    rmSync(a.paths.backups, { recursive: true, force: true });

    const res = await run(['doctor'], { env: th.env });
    expect(res.code, `${res.stdout}${res.stderr ?? ''}`).toBe(0);
    const repaired = await run(['doctor', '--repair'], { env: th.env });
    expect(repaired.code).toBe(0);
    expect(repaired.stdout).toContain('nothing to repair');

    // With no manifest there is no ownership to act on, so the surfaces the lost
    // store had written are left exactly as they stand — never guessed at.
    expect(lstatSync(a.link).isSymbolicLink()).toBe(true);
    expect(readFileSync(a.instr, 'utf8')).toContain('agentenv:writing');
  });
});
