/**
 * Task 1.8 — LIVE acceptance for the Claude adapter (gated on `claude` present).
 *
 * Composes a REAL session view (via the shared composer) of a COPY of the real
 * ~/.claude — real `.credentials.json` and `.claude.json` are COPIED into a
 * throwaway temp (per the safety rule; the real files are only ever READ, never
 * symlinked-through or written) — then runs the adapter's real `selfCheck` against
 * a live `claude mcp list`. Proves: the child observes the private view (its
 * injected server is listed), login passes through the copied credentials, and the
 * real ~/.claude is untouched. Skips cleanly where `claude` is absent (CI).
 *
 * Run just this:  npm test -- -t "adapter.claude — live"
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SelfCheckContext } from '../src/adapter.js';
import { claudeAdapter } from '../src/adapters/claude.js';
import { resolvePaths } from '../src/paths.js';
import { defaultCapture } from '../src/session/exec.js';
import { resolveBinaryOnPath } from '../src/session/resolve.js';
import { composeView } from '../src/session/composer.js';

const PROBE_TIMEOUT_MS = 60_000;
const hasClaude = spawnSync('claude', ['--version'], { timeout: 20_000 }).status === 0;
const realCredsPath = join(homedir(), '.claude', '.credentials.json');
const realJsonPath = join(homedir(), '.claude.json');
const canRun = hasClaude && existsSync(realCredsPath) && existsSync(realJsonPath);

const tmpRoots: string[] = [];
function freshRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentenv-claude-live-'));
  tmpRoots.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

function sha(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

describe.skipIf(!canRun)('adapter.claude — live selfCheck on a copy of real ~/.claude', () => {
  it(
    'composes a session view whose child observes the view, with login passing through',
    async () => {
      // Prove the real credential file is untouched by the whole test.
      const realCredsBefore = sha(realCredsPath);

      const root = freshRoot();

      // A COPY of the real config root: real credentials + real .claude.json copied
      // in (READ only; never a symlink to the real files, so any write during the
      // probe lands on the copy, never on real ~/.claude).
      const copyRoot = join(root, 'claude-copy');
      mkdirSync(copyRoot, { recursive: true });
      copyFileSync(realCredsPath, join(copyRoot, '.credentials.json'));
      copyFileSync(realJsonPath, join(copyRoot, '.claude.json'));

      // A store env contributing one distinctive MCP server (present ONLY in the view).
      const probeName = `agentenv-live-${process.pid}`;
      const paths = resolvePaths({ AGENTENV_HOME: join(root, 'agentenv') });
      mkdirSync(join(paths.envDir('live-writing'), 'mcp'), { recursive: true });
      writeFileSync(
        join(paths.envDir('live-writing'), 'mcp', 'servers.yaml'),
        `${probeName}:\n  transport: stdio\n  command: /bin/echo\n  args: ["marker"]\n`,
      );

      // Compose the real view through the shared composer (bucket-1 symlinks the
      // credentials copy; config-keys seeds .claude.json + injects the probe server).
      const composed = await composeView({
        paths,
        adapter: claudeAdapter,
        envs: ['live-writing'],
        session: `live-${process.pid}`,
        realConfigRoot: copyRoot,
        projectRoot: null,
      });
      const viewRoot = composed.viewRoot;

      // (1) Login-intact MECHANISM: the view links .credentials.json through to the
      // (copied) real token — auth passes through (D15 bucket 1).
      const viewCreds = join(viewRoot, '.credentials.json');
      expect(lstatSync(viewCreds).isSymbolicLink()).toBe(true);
      expect(realpathSync(viewCreds)).toBe(realpathSync(join(copyRoot, '.credentials.json')));

      // (2) The view's .claude.json carries the injected probe server beside context7.
      const viewCfg = JSON.parse(readFileSync(join(viewRoot, '.claude.json'), 'utf8'));
      expect(Object.keys(viewCfg.mcpServers)).toContain(probeName);

      // (3) selfCheck: the live child provably observes the view.
      const ctx: SelfCheckContext = {
        resolveBinary: () => resolveBinaryOnPath('claude', process.env, [paths.shims]),
        capture: defaultCapture,
        env: { ...process.env, CLAUDE_CONFIG_DIR: undefined } as NodeJS.ProcessEnv,
      };
      const check = await claudeAdapter.selfCheck(viewRoot, ctx);
      expect(check).toEqual({ ok: true });

      // (4) Directly confirm isolation: `claude mcp list` on the view lists the
      // probe server (which exists ONLY in the view). Best-effort login-intact: if
      // the account exposes remote MCP servers, they connect through the token copy.
      const out = spawnSync('claude', ['mcp', 'list'], {
        env: { ...process.env, CLAUDE_CONFIG_DIR: viewRoot },
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
      });
      const listed = `${out.stdout ?? ''}${out.stderr ?? ''}`;
      expect(listed).toContain(probeName);
      if (/claude\.ai/i.test(listed)) {
        // Login intact end-to-end: at least one account remote connected via the copied token.
        expect(listed).toMatch(/claude\.ai .*Connected/i);
      }

      // (5) The real credential file was never written.
      expect(sha(realCredsPath)).toBe(realCredsBefore);
    },
    PROBE_TIMEOUT_MS,
  );
});
