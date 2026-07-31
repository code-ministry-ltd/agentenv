/**
 * Task 4.3 — unit coverage for the Pi adapter (`src/adapters/pi.ts`). No real `pi`
 * binary is spawned here: `detect`/`selfCheck` are exercised through injected
 * capture/resolve seams, so this runs in `npm run ci` offline. Live re-verification
 * of the harness matrix (relocation, `pi list`, auth/trust pass-through) is the
 * gated `adapter.pi.live.test.ts`.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  surfaceRootRelativePath,
  validateAdapter,
  type ConfigKeysSurface,
  type SelfCheckContext,
} from '../src/adapter.js';
import { piAdapter } from '../src/adapters/pi.js';

const tmpRoots: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentenv-pi-unit-'));
  tmpRoots.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

/** The settings config-keys surface, narrowed for the compile/syncBack tests. */
function settingsSurface(): ConfigKeysSurface {
  const s = piAdapter.surfaces.find((x) => x.id === 'settings');
  if (!s || s.mechanism !== 'config-keys') throw new Error('no settings surface');
  return s;
}

describe('adapter.pi — identity + structural contract', () => {
  it('is well-formed per the frozen validateAdapter (incl. the unsupported-MCP surface)', () => {
    expect(validateAdapter(piAdapter)).toBeNull();
  });

  it('declares the frozen identity: id `pi`, binary `pi`, PI_CODING_AGENT_DIR, session-capable', () => {
    expect(piAdapter.id).toBe('pi');
    expect(piAdapter.binaryName).toBe('pi');
    expect(piAdapter.configRootEnv).toBe('PI_CODING_AGENT_DIR');
    expect(piAdapter.sessionSupported).toBe(true);
  });

  it('overrideEnv sets ONLY PI_CODING_AGENT_DIR to the view root', () => {
    expect(piAdapter.overrideEnv('/v/root')).toEqual({ PI_CODING_AGENT_DIR: '/v/root' });
  });

  it('realConfigRoot defaults to ~/.pi/agent, but a set PI_CODING_AGENT_DIR wins', () => {
    expect(piAdapter.realConfigRoot({} as NodeJS.ProcessEnv)).toMatch(/[/\\]\.pi[/\\]agent$/);
    expect(piAdapter.realConfigRoot({ PI_CODING_AGENT_DIR: '/custom/root' } as NodeJS.ProcessEnv)).toBe(
      '/custom/root',
    );
    // A blank override falls back to the default (never an empty root).
    expect(piAdapter.realConfigRoot({ PI_CODING_AGENT_DIR: '  ' } as NodeJS.ProcessEnv)).toMatch(
      /[/\\]\.pi[/\\]agent$/,
    );
  });
});

describe('adapter.pi — two-bucket classification (D15)', () => {
  it('auth.json + trust.json are bucket-1 state pass-through (login + project trust)', () => {
    expect(piAdapter.classifyEntry('auth.json')).toBe('state');
    expect(piAdapter.classifyEntry('trust.json')).toBe('state');
  });

  it('surface targets are bucket-2 managed', () => {
    for (const name of ['skills', 'prompts', 'AGENTS.md', 'settings.json']) {
      expect(piAdapter.classifyEntry(name)).toBe('managed');
    }
  });

  it('unknown entries + Pi state dirs default to bucket-1 state (the safe unknown)', () => {
    for (const name of ['extensions', 'SYSTEM.md', 'APPEND_SYSTEM.md', 'a-future-pi-file', 'sessions']) {
      expect(piAdapter.classifyEntry(name)).toBe('state');
    }
  });

  it('every surface target classifies managed — the invariant validateAdapter enforces', () => {
    for (const s of piAdapter.surfaces) {
      const target = surfaceRootRelativePath(s).split(/[\\/]/)[0]!;
      expect(piAdapter.classifyEntry(target)).toBe('managed');
    }
  });
});

describe('adapter.pi — surface declarations', () => {
  it('exposes skills(dir-merge), instructions(file-block inline), prompts(dir-merge), settings(config-keys array-element)', () => {
    const byId = Object.fromEntries(piAdapter.surfaces.map((s) => [s.id, s]));

    expect(byId.skills).toMatchObject({ mechanism: 'dir-merge', rootRelativePath: 'skills', mode: 'symlink', supported: true, storeKind: 'skills' });
    expect(byId.instructions).toMatchObject({ mechanism: 'file-block', rootRelativePath: 'AGENTS.md', layering: 'inline', supported: true, storeKind: 'instructions' });
    expect(byId.prompts).toMatchObject({ mechanism: 'dir-merge', rootRelativePath: 'prompts', mode: 'symlink', supported: true, storeKind: 'commands' });
    expect(byId.settings).toMatchObject({ mechanism: 'config-keys', rootRelativePath: 'settings.json', format: 'json', style: 'array-element', supported: true });
  });

  it('MCP is declared UNSUPPORTED with a reason (Pi has no native MCP), so status reports it (D6)', () => {
    const mcp = piAdapter.surfaces.find((s) => s.id === 'mcp');
    expect(mcp).toBeDefined();
    expect(mcp!.supported).toBe(false);
    expect(mcp!.unsupportedReason).toMatch(/no native MCP/i);
  });
});

describe('adapter.pi — compileConfigKeys (settings resource arrays, array-element D3)', () => {
  it('emits one array-element injection per element of each owned settings array', async () => {
    const envDir = freshDir();
    mkdirSync(join(envDir, 'files'), { recursive: true });
    writeFileSync(
      join(envDir, 'files', 'settings.json'),
      JSON.stringify({
        packages: ['@acme/writing-pack', 'reviewer'],
        themes: ['midnight'],
        ignored: ['not-a-managed-array'],
      }),
    );

    const injections = await piAdapter.compileConfigKeys(settingsSurface(), {
      envContentDir: envDir,
      projectRoot: null,
    });

    expect(injections).toEqual([
      { style: 'array-element', arrayPath: ['packages'], value: '@acme/writing-pack' },
      { style: 'array-element', arrayPath: ['packages'], value: 'reviewer' },
      { style: 'array-element', arrayPath: ['themes'], value: 'midnight' },
    ]);
    // `ignored` is not a managed Pi settings array — never injected.
    expect(injections.some((i) => i.style === 'array-element' && i.arrayPath[0] === 'ignored')).toBe(false);
  });

  it('contributes nothing when the env has no settings store file', async () => {
    const envDir = freshDir();
    expect(await piAdapter.compileConfigKeys(settingsSurface(), { envContentDir: envDir, projectRoot: null })).toEqual([]);
  });

  it('a non-settings surface compiles to nothing (MCP never reaches compile, but is safe if it does)', async () => {
    const mcp = piAdapter.surfaces.find((s) => s.id === 'mcp') as ConfigKeysSurface;
    expect(await piAdapter.compileConfigKeys(mcp, { envContentDir: freshDir(), projectRoot: null })).toEqual([]);
  });
});

describe('adapter.pi — syncBackConfigKeys (reverse to canonical, array-element by value)', () => {
  it('folds a drifted settings value into the env store array without a secret transform', async () => {
    const envDir = freshDir();
    mkdirSync(join(envDir, 'files'), { recursive: true });
    writeFileSync(join(envDir, 'files', 'settings.json'), JSON.stringify({ packages: ['existing'] }));

    const mutations = await piAdapter.syncBackConfigKeys!(
      settingsSurface(),
      { style: 'array-element', keyPath: ['packages'], canonicalValue: 'newly-added' },
      { envContentDir: envDir, projectRoot: null },
    );

    expect(mutations).toHaveLength(1);
    expect(mutations[0]!.storeRelativePath).toBe(join('files', 'settings.json'));
    expect(JSON.parse(mutations[0]!.content)).toEqual({ packages: ['existing', 'newly-added'] });
  });

  it('is idempotent: a value already present is not duplicated', async () => {
    const envDir = freshDir();
    mkdirSync(join(envDir, 'files'), { recursive: true });
    writeFileSync(join(envDir, 'files', 'settings.json'), JSON.stringify({ packages: ['keep'] }));

    const mutations = await piAdapter.syncBackConfigKeys!(
      settingsSurface(),
      { style: 'array-element', keyPath: ['packages'], canonicalValue: 'keep' },
      { envContentDir: envDir, projectRoot: null },
    );
    expect(JSON.parse(mutations[0]!.content)).toEqual({ packages: ['keep'] });
  });

  it('returns no mutation for a keyed drift (settings is array-element only)', async () => {
    const mutations = await piAdapter.syncBackConfigKeys!(
      settingsSurface(),
      { style: 'keyed', keyPath: ['packages', 0], canonicalValue: 'x' },
      { envContentDir: freshDir(), projectRoot: null },
    );
    expect(mutations).toEqual([]);
  });
});

describe('adapter.pi — selfCheck (offline `pi list` probe, injected capture)', () => {
  const viewRoot = '/view/root';

  function ctx(over: Partial<SelfCheckContext>): SelfCheckContext {
    return {
      resolveBinary: async () => '/usr/bin/pi',
      capture: async () => ({ code: 0, stdout: '', stderr: '' }),
      env: {} as NodeJS.ProcessEnv,
      ...over,
    };
  }

  it('fails closed when pi is not on PATH', async () => {
    const res = await piAdapter.selfCheck(viewRoot, ctx({ resolveBinary: async () => null }));
    expect(res).toEqual({ ok: false, detail: 'pi not found on PATH' });
  });

  it('passes when the child lists the view`s injected package under PI_CODING_AGENT_DIR', async () => {
    const dir = freshDir();
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ packages: ['agentenv-probe-pkg'] }));
    let sawEnv: NodeJS.ProcessEnv | undefined;
    const res = await piAdapter.selfCheck(dir, ctx({
      capture: async (_bin, args, env) => {
        sawEnv = env;
        expect(args).toEqual(['list', '--no-approve']);
        return { code: 0, stdout: 'User packages:\n  agentenv-probe-pkg\n', stderr: '' };
      },
    }));
    expect(res).toEqual({ ok: true });
    // The probe points Pi at the view AND runs offline.
    expect(sawEnv?.PI_CODING_AGENT_DIR).toBe(dir);
    expect(sawEnv?.PI_OFFLINE).toBe('1');
  });

  it('fails when the child`s pi list omits the view`s package (child observed the wrong root)', async () => {
    const dir = freshDir();
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ packages: ['agentenv-probe-pkg'] }));
    const res = await piAdapter.selfCheck(dir, ctx({
      capture: async () => ({ code: 0, stdout: 'No packages installed.\n', stderr: '' }),
    }));
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('agentenv-probe-pkg');
  });

  it('falls back to an exit-code check when the view contributes no package', async () => {
    const dir = freshDir(); // no settings.json → no packages to key off
    const ok = await piAdapter.selfCheck(dir, ctx({ capture: async () => ({ code: 0, stdout: 'No packages installed.\n', stderr: '' }) }));
    expect(ok).toEqual({ ok: true });

    const bad = await piAdapter.selfCheck(dir, ctx({ capture: async () => ({ code: 1, stdout: '', stderr: 'boom' }) }));
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain('exited 1');
  });
});
