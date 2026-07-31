import { spawn } from 'node:child_process';

/**
 * Default editor launcher: spawn `command args...` inheriting the terminal so
 * an interactive editor works, and resolve to its exit code. Injected in tests
 * (via RunOptions.launchEditor) so no real editor is ever spawned.
 */
export function launchEditorDefault(command: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 0));
  });
}
