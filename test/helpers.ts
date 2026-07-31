import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/** A hermetic temp AGENTENV_HOME plus the env object to inject into run(). */
export interface TempHome {
  home: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

export function makeTempHome(extraEnv: NodeJS.ProcessEnv = {}): TempHome {
  const home = mkdtempSync(join(tmpdir(), 'agentenv-test-'));
  return {
    home,
    env: { AGENTENV_HOME: home, ...extraEnv },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

/**
 * Snapshot the real ~/.agentenv so a test can prove a command never touched it.
 * Works whether or not it already exists on the dev machine.
 */
export function realHomeSnapshot(): { existed: boolean; mtimeMs?: number } {
  const real = join(homedir(), '.agentenv');
  if (!existsSync(real)) return { existed: false };
  return { existed: true, mtimeMs: statSync(real).mtimeMs };
}

export function expectRealHomeUntouched(before: { existed: boolean; mtimeMs?: number }): void {
  const real = join(homedir(), '.agentenv');
  if (!before.existed) {
    if (existsSync(real)) {
      throw new Error(`test created the real ~/.agentenv at ${real}`);
    }
    return;
  }
  if (statSync(real).mtimeMs !== before.mtimeMs) {
    throw new Error(`test modified the real ~/.agentenv at ${real}`);
  }
}
