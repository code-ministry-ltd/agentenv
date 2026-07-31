import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePaths } from '../src/paths.js';

describe('resolvePaths', () => {
  it('derives every path from AGENTENV_HOME when set', () => {
    const base = '/tmp/agentenv-test-home';
    const p = resolvePaths({ AGENTENV_HOME: base });

    expect(p.base).toBe(base);
    expect(p.store).toBe(join(base, 'store'));
    expect(p.environments).toBe(join(base, 'store', 'environments'));
    expect(p.storeReadme).toBe(join(base, 'store', 'README.md'));
    expect(p.state).toBe(join(base, 'state.json'));
    expect(p.secrets).toBe(join(base, 'secrets.env'));
    expect(p.backups).toBe(join(base, 'backups'));
    expect(p.live).toBe(join(base, 'live'));
    expect(p.shims).toBe(join(base, 'shims'));
  });

  it('resolves per-environment paths under environments/', () => {
    const p = resolvePaths({ AGENTENV_HOME: '/tmp/agentenv-test-home' });
    expect(p.envDir('writing')).toBe(
      '/tmp/agentenv-test-home/store/environments/writing',
    );
    expect(p.envYaml('writing')).toBe(
      '/tmp/agentenv-test-home/store/environments/writing/env.yaml',
    );
  });

  it('defaults to ~/.agentenv when AGENTENV_HOME is unset', () => {
    const p = resolvePaths({});
    expect(p.base).toBe(join(homedir(), '.agentenv'));
  });

  it('treats an empty AGENTENV_HOME as unset', () => {
    const p = resolvePaths({ AGENTENV_HOME: '   ' });
    expect(p.base).toBe(join(homedir(), '.agentenv'));
  });

  it('resolves a relative AGENTENV_HOME to an absolute path', () => {
    const p = resolvePaths({ AGENTENV_HOME: 'relative/dir' });
    expect(p.base).toMatch(/^\//);
    expect(p.base.endsWith('relative/dir')).toBe(true);
  });

  it('is a pure computation that touches no filesystem', () => {
    const base = join('/tmp', `agentenv-untouched-${Date.now()}`);
    resolvePaths({ AGENTENV_HOME: base });
    expect(existsSync(base)).toBe(false);
  });
});
