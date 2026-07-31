/**
 * Task 4.2 — LIVE acceptance for the OpenCode adapter (gated on `opencode` present).
 *
 * Composes a REAL session view (via the shared composer) of a COPY of the real
 * `~/.config/opencode/opencode.json` (COPIED into a throwaway temp per the safety
 * rule; the real file is only ever READ, never written or symlinked-through) — then
 * runs the adapter's real `selfCheck` against a live `opencode mcp list`. Proves:
 * the child observes the private view (its injected server is listed) under the
 * adapter's real override (`XDG_CONFIG_HOME=dirname(viewRoot)` + `OPENCODE_CONFIG_DIR`),
 * config isolation holds, and the real config file is untouched. Live-LOGIN is
 * deferred (the reference binary is unauthenticated) — this checks config ISOLATION.
 *
 * OPT-IN checkpoint test (spec criterion 9): the seeded real config may carry remote
 * MCP servers that connect over the network, so this is a checkpoint assertion, not a
 * suite gate. It does NOT run in `npm run ci`; set AGENTENV_LIVE=1 (and have
 * `opencode` present) to run it on demand.
 *
 * Run just this:  AGENTENV_LIVE=1 npm test -- test/adapter.opencode.live.test.ts
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SelfCheckContext } from '../src/adapter.js';
import { opencodeAdapter } from '../src/adapters/opencode.js';
import { resolvePaths } from '../src/paths.js';
import { makeCapture } from '../src/session/exec.js';
import { resolveBinaryOnPath } from '../src/session/resolve.js';
import { composeView } from '../src/session/composer.js';

const PROBE_TIMEOUT_MS = 60_000;
const hasOpencode = spawnSync('opencode', ['--version'], { timeout: 20_000 }).status === 0;
const realConfigDir = join(homedir(), '.config', 'opencode');
const realJsonPath = join(realConfigDir, 'opencode.json');
const canRun = process.env.AGENTENV_LIVE === '1' && hasOpencode && existsSync(realJsonPath);

const tmpRoots: string[] = [];
function freshRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentenv-opencode-live-'));
  tmpRoots.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

function sha(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

describe.skipIf(!canRun)('adapter.opencode — live selfCheck on a copy of real opencode.json', () => {
  it(
    'composes a session view whose child observes the view, with config isolation',
    async () => {
      // Prove the real config file is untouched by the whole test.
      const realJsonBefore = sha(realJsonPath);

      const root = freshRoot();

      // A COPY of the real config root: the real opencode.json COPIED in (READ only,
      // never symlinked to the real file, so any write during the probe lands on the
      // copy). This is the composer's `realConfigRoot` — its opencode.json is seeded.
      const copyRoot = join(root, 'opencode-copy');
      mkdirSync(copyRoot, { recursive: true });
      copyFileSync(realJsonPath, join(copyRoot, 'opencode.json'));

      // A store env contributing one distinctive MCP server + an instruction file
      // (present ONLY in the view).
      const probeName = `agentenv-live-${process.pid}`;
      const paths = resolvePaths({ AGENTENV_HOME: join(root, 'agentenv') });
      const envDir = paths.envDir('live-writing');
      mkdirSync(join(envDir, 'mcp'), { recursive: true });
      writeFileSync(
        join(envDir, 'mcp', 'servers.yaml'),
        `${probeName}:\n  transport: stdio\n  command: /bin/echo\n  args: ["marker"]\n`,
      );
      mkdirSync(join(envDir, 'instructions'), { recursive: true });
      writeFileSync(join(envDir, 'instructions', 'opencode.md'), '# live-writing instruction\n');

      // Compose the real view through the shared composer (config-keys seeds
      // opencode.json from the copy + injects the probe server & instruction path).
      const composed = await composeView({
        paths,
        adapter: opencodeAdapter,
        envs: ['live-writing'],
        session: `live-${process.pid}`,
        realConfigRoot: copyRoot,
        projectRoot: null,
      });
      const viewRoot = composed.viewRoot;
      // The view IS named `opencode` (the composer names it after the adapter id) —
      // the invariant `XDG_CONFIG_HOME=dirname(viewRoot)` relies on.
      expect(viewRoot.endsWith('/opencode')).toBe(true);

      // (1) The view's opencode.json carries the injected probe server + instruction path.
      const viewCfg = JSON.parse(readFileSync(join(viewRoot, 'opencode.json'), 'utf8'));
      expect(Object.keys(viewCfg.mcp)).toContain(probeName);
      expect(viewCfg.instructions).toContain(join(envDir, 'instructions', 'opencode.md'));

      // (2) selfCheck: the live child provably observes the view.
      const ctx: SelfCheckContext = {
        resolveBinary: () => resolveBinaryOnPath('opencode', process.env, [paths.shims]),
        capture: makeCapture(PROBE_TIMEOUT_MS),
        // Strip any ambient overrides so the adapter's own overrideEnv is authoritative.
        env: {
          ...process.env,
          XDG_CONFIG_HOME: undefined,
          OPENCODE_CONFIG_DIR: undefined,
        } as NodeJS.ProcessEnv,
      };
      const check = await opencodeAdapter.selfCheck(viewRoot, ctx);
      expect(check).toEqual({ ok: true });

      // (3) Directly confirm isolation: `opencode mcp list` under the adapter's real
      // override (XDG_CONFIG_HOME=dirname(viewRoot) is the lever) lists the probe
      // server, which exists ONLY in the view.
      const out = spawnSync('opencode', ['mcp', 'list'], {
        env: {
          ...process.env,
          XDG_CONFIG_HOME: dirname(viewRoot),
          OPENCODE_CONFIG_DIR: viewRoot,
        },
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
      });
      const listed = `${out.stdout ?? ''}${out.stderr ?? ''}`;
      expect(listed).toContain(probeName);

      // (4) The real config file was never written.
      expect(sha(realJsonPath)).toBe(realJsonBefore);
    },
    PROBE_TIMEOUT_MS,
  );
});
