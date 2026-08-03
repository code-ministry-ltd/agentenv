/**
 * Task 4.1 — LIVE re-verification for the Codex adapter (gated on `codex` present).
 *
 * Codex config ISOLATION is fully verifiable while UNAUTHENTICATED (`codex mcp get`
 * reads `[mcp_servers.*]` from `$CODEX_HOME/config.toml` and prints each server's
 * name regardless of auth). It is still explicitly gated by `AGENTENV_LIVE=1` so
 * a host-installed binary can never make the hermetic suite slow or flaky.
 * Live-login / auth pass-through is DEFERRED: no Codex account exists on the
 * reference machine, so `~/.codex/auth.json` is absent (spike caveat).
 *
 * SAFETY: the real `~/.codex` is only ever READ. `realConfigRoot` is a COPY; the
 * child is pointed only at the composed VIEW. A before/after sha of the real
 * config proves it is untouched. Every `codex` call is hard-timed.
 *
 * Run just this:  AGENTENV_LIVE=1 npm run test:live -- test/adapter.codex.live.test.ts
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SelfCheckContext } from '../src/adapter.js';
import { codexAdapter } from '../src/adapters/codex.js';
import { resolvePaths } from '../src/paths.js';
import { makeCapture } from '../src/session/exec.js';
import { resolveBinaryOnPath } from '../src/session/resolve.js';
import { composeView } from '../src/session/composer.js';

const PROBE_TIMEOUT_MS = 30_000;
// Probe the binary under a THROWAWAY CODEX_HOME: `codex` writes a scratch
// `tmp/arg0/*` helper lock under its config root on any invocation, so a bare
// `codex --version` would touch the REAL ~/.codex tree. Isolating it keeps this
// test's footprint entirely off the real dir (the safety rule).
const probeHome = mkdtempSync(join(tmpdir(), 'agentenv-codex-probe-'));
const hasCodex =
  spawnSync('codex', ['--version'], {
    timeout: 20_000,
    env: { ...process.env, CODEX_HOME: probeHome },
  }).status === 0;
const realCodexHome = join(homedir(), '.codex');

const tmpRoots: string[] = [];
function freshRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentenv-codex-live-'));
  tmpRoots.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of [...tmpRoots, probeHome]) rmSync(d, { recursive: true, force: true });
});

/** sha of the real config's stable managed files (NOT `tmp/`, which the binary churns). */
function realConfigSha(): string {
  const h = createHash('sha256');
  for (const name of ['config.toml', 'AGENTS.md', 'hooks.json', 'auth.json']) {
    const p = join(realCodexHome, name);
    h.update(`${name}:`).update(existsSync(p) ? readFileSync(p) : Buffer.from('<absent>'));
  }
  return h.digest('hex');
}

const canRun = process.env.AGENTENV_LIVE === '1' && hasCodex;

describe.skipIf(!canRun)('adapter.codex — live config isolation on a COPY of real ~/.codex', () => {
  it(
    'composes a session view whose child (`codex mcp get`) observes only the view',
    async () => {
      // Prove the real config is untouched by the whole test.
      const realBefore = realConfigSha();

      const root = freshRoot();

      // A COPY of the real config root (READ only — never a symlink to it, so any
      // write during the probe lands on the copy, never on real ~/.codex).
      const copyRoot = join(root, 'codex-copy');
      if (existsSync(realCodexHome)) {
        cpSync(realCodexHome, copyRoot, { recursive: true });
        // Drop the copied tmp/ so the copy is a clean config source.
        rmSync(join(copyRoot, 'tmp'), { recursive: true, force: true });
      } else {
        mkdirSync(copyRoot, { recursive: true });
      }

      // A store env contributing one distinctive stdio MCP server (present ONLY in
      // the view). `codex mcp get` reads it without connecting.
      const probeName = `agentenv_live_${process.pid}`;
      const paths = resolvePaths({ AGENTENV_HOME: join(root, 'agentenv') });
      mkdirSync(join(paths.envDir('live-writing'), 'mcp'), { recursive: true });
      writeFileSync(
        join(paths.envDir('live-writing'), 'mcp', 'servers.yaml'),
        `${probeName}:\n  transport: stdio\n  command: /bin/echo\n  args: ["marker"]\n`,
      );

      // Compose the real view through the shared composer.
      const composed = await composeView({
        paths,
        adapter: codexAdapter,
        envs: ['live-writing'],
        session: `live-${process.pid}`,
        realConfigRoot: copyRoot,
        projectRoot: null,
      });
      const viewRoot = composed.viewRoot;

      // (1) The view's config.toml carries the injected probe server (TOML seeding).
      const viewCfg = readFileSync(join(viewRoot, 'config.toml'), 'utf8');
      expect(viewCfg).toContain(`[mcp_servers.${probeName}]`);

      // (2) selfCheck: the live child provably observes the view.
      const ctx: SelfCheckContext = {
        resolveBinary: () => resolveBinaryOnPath('codex', process.env, [paths.shims]),
        capture: makeCapture(PROBE_TIMEOUT_MS),
        env: { ...process.env, CODEX_HOME: undefined } as NodeJS.ProcessEnv,
      };
      const check = await codexAdapter.selfCheck(viewRoot, ctx);
      expect(check).toEqual({ ok: true });

      // (3) Directly confirm isolation: a targeted read on the view returns the
      // probe server (which exists ONLY in the view).
      const out = spawnSync('codex', ['mcp', 'get', probeName, '--json'], {
        env: { ...process.env, CODEX_HOME: viewRoot },
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
      });
      const listed = `${out.stdout ?? ''}${out.stderr ?? ''}`;
      expect(listed).toContain(probeName);

      // (4) The real config was never written.
      expect(realConfigSha()).toBe(realBefore);
    },
    PROBE_TIMEOUT_MS * 2 + 10_000,
  );
});
