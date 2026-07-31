/**
 * Task 4.3 — LIVE acceptance for the Pi adapter (gated on `pi` present +
 * AGENTENV_LIVE=1). Composes a REAL session view (via the shared composer) of a
 * COPY of the real ~/.pi/agent — the real config is only ever READ, then COPIED
 * into a throwaway temp; nothing here symlinks-through or writes the real root —
 * and runs the adapter's real `selfCheck` against a live, OFFLINE `pi list`.
 *
 * Proves the live harness-matrix cells the adapter depends on:
 *   - PI_CODING_AGENT_DIR relocates the config root (`pi list` reads the view's
 *     settings.json packages, not the real root's);
 *   - skills are placed in the relocated in-root `skills/` (symlinks, D15);
 *   - auth.json + trust.json pass through as bucket-1 symlinks to the copy;
 *   - the real ~/.pi is byte-for-byte untouched by the whole test.
 *
 * OPT-IN checkpoint (spec criterion 9): NOT run in `npm run ci`. Run on demand:
 *   AGENTENV_LIVE=1 npm test -- test/adapter.pi.live.test.ts
 *
 * SAFETY: every `pi` call is hard-timed and offline (PI_OFFLINE=1); no
 * login/logout; the real ~/.pi is snapshot before/after and asserted unchanged.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SelfCheckContext } from '../src/adapter.js';
import { piAdapter } from '../src/adapters/pi.js';
import { resolvePaths } from '../src/paths.js';
import { makeCapture } from '../src/session/exec.js';
import { resolveBinaryOnPath } from '../src/session/resolve.js';
import { composeView } from '../src/session/composer.js';

const PROBE_TIMEOUT_MS = 60_000;
const hasPi = spawnSync('pi', ['--version'], { timeout: 20_000 }).status === 0;
const realPiRoot = join(homedir(), '.pi', 'agent');
const canRun = process.env.AGENTENV_LIVE === '1' && hasPi && existsSync(realPiRoot);

const tmpRoots: string[] = [];
function freshRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentenv-pi-live-'));
  tmpRoots.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

/** A content+structure hash of a directory tree (files by content, symlinks by target). */
function hashTree(root: string): string {
  const rows: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs);
      if (entry.isSymbolicLink()) rows.push(`L ${rel}`);
      else if (entry.isDirectory()) {
        rows.push(`D ${rel}`);
        walk(abs);
      } else rows.push(`F ${rel} ${createHash('sha256').update(readFileSync(abs)).digest('hex')}`);
    }
  };
  walk(root);
  return createHash('sha256').update(rows.join('\n')).digest('hex');
}

describe.skipIf(!canRun)('adapter.pi — live selfCheck on a copy of real ~/.pi/agent', () => {
  it(
    'composes a session view whose child observes the view, with auth/trust passing through',
    async () => {
      // Prove the real config root is untouched by the whole test.
      const realBefore = hashTree(realPiRoot);

      const root = freshRoot();

      // A COPY of the real config root (READ only). A trust.json + settings.json are
      // ADDED to the COPY (the real root has neither) so the pass-through and the
      // config-keys seed are exercised on the throwaway, never the real files.
      const copyRoot = join(root, 'pi-copy');
      cpSync(realPiRoot, copyRoot, { recursive: true });
      writeFileSync(join(copyRoot, 'trust.json'), '{"trustedProjects":["/home/user/demo"]}\n');
      writeFileSync(join(copyRoot, 'settings.json'), `${JSON.stringify({ packages: ['pre-existing-pkg'] }, null, 2)}\n`);

      // A store env contributing one distinctive package, one skill, and instructions.
      const probePkg = `agentenv-live-${process.pid}`;
      const paths = resolvePaths({ AGENTENV_HOME: join(root, 'agentenv') });
      const envDir = paths.envDir('live-writing');
      mkdirSync(join(envDir, 'files'), { recursive: true });
      writeFileSync(join(envDir, 'files', 'settings.json'), `${JSON.stringify({ packages: [probePkg] }, null, 2)}\n`);
      mkdirSync(join(envDir, 'skills', 'live-skill'), { recursive: true });
      writeFileSync(
        join(envDir, 'skills', 'live-skill', 'SKILL.md'),
        '---\nname: live-skill\ndescription: agentenv live probe skill\n---\n# live\n',
      );
      mkdirSync(join(envDir, 'instructions'), { recursive: true });
      writeFileSync(join(envDir, 'instructions', 'base.md'), 'Live env instructions.\n');

      // Compose the real view through the shared composer (bucket-1 symlinks auth/trust
      // through to the copy; config-keys seeds settings.json + injects the probe package).
      const composed = await composeView({
        paths,
        adapter: piAdapter,
        envs: ['live-writing'],
        session: `live-${process.pid}`,
        realConfigRoot: copyRoot,
        projectRoot: null,
      });
      const viewRoot = composed.viewRoot;

      // (1) Bucket-1 pass-through: auth.json + trust.json resolve to the (copied) real
      // files — the view stays authenticated and project-trust is intact (D15).
      for (const name of ['auth.json', 'trust.json']) {
        const link = join(viewRoot, name);
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(realpathSync(link)).toBe(realpathSync(join(copyRoot, name)));
      }

      // (2) The view's settings.json carries the injected probe package beside the
      // pre-existing one (config-keys array-element).
      const viewSettings = JSON.parse(readFileSync(join(viewRoot, 'settings.json'), 'utf8'));
      expect(viewSettings.packages).toContain(probePkg);
      expect(viewSettings.packages).toContain('pre-existing-pkg');

      // (3) The env skill is placed in the relocated in-root skills/ (dir-merge), beside
      // the user's real skills — Pi's documented + live-verified skill load location.
      const skillLink = join(viewRoot, 'skills', 'live-skill');
      expect(lstatSync(skillLink).isSymbolicLink()).toBe(true);
      expect(realpathSync(skillLink)).toBe(realpathSync(join(envDir, 'skills', 'live-skill')));

      // (4) selfCheck: the live child provably observes the view (offline `pi list`).
      const ctx: SelfCheckContext = {
        resolveBinary: () => resolveBinaryOnPath('pi', process.env, [paths.shims]),
        capture: makeCapture(PROBE_TIMEOUT_MS),
        env: { ...process.env, PI_CODING_AGENT_DIR: undefined } as NodeJS.ProcessEnv,
      };
      const check = await piAdapter.selfCheck(viewRoot, ctx);
      expect(check).toEqual({ ok: true });

      // (5) Directly confirm relocation: `pi list` on the view lists the probe package
      // (present ONLY in the view), offline, without mutating the view's settings.json.
      const out = spawnSync('pi', ['list', '--no-approve'], {
        env: { ...process.env, PI_CODING_AGENT_DIR: viewRoot, PI_OFFLINE: '1' },
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
      });
      expect(`${out.stdout ?? ''}${out.stderr ?? ''}`).toContain(probePkg);

      // (6) The real ~/.pi/agent was never written.
      expect(hashTree(realPiRoot)).toBe(realBefore);
    },
    PROBE_TIMEOUT_MS,
  );
});
