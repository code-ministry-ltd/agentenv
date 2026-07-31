import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';

/**
 * Resolve a command name to an executable path by scanning `PATH`, with a set of
 * directories excluded — the shim dirs (D15): a shim must find the REAL binary,
 * never itself, so every shim directory is stripped from the search before
 * resolution. Returns the absolute path, or `null` when nothing is found.
 *
 * A name that already contains a path separator is treated as a direct path and
 * returned if it is an executable file (mirrors how a shell treats `./foo`).
 * `PATHEXT` is honoured on Windows so `foo` resolves `foo.cmd`/`foo.exe`.
 */
export async function resolveBinaryOnPath(
  binaryName: string,
  env: NodeJS.ProcessEnv,
  excludeDirs: readonly string[] = [],
): Promise<string | null> {
  const excluded = new Set(excludeDirs.map((d) => resolve(d)));

  if (binaryName.includes('/') || binaryName.includes('\\')) {
    return (await isExecutableFile(binaryName)) ? resolve(binaryName) : null;
  }

  const pathValue = env.PATH ?? env.Path ?? '';
  const dirs = pathValue.split(delimiter).filter((d) => d.length > 0);
  const exts =
    process.platform === 'win32'
      ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : [''];

  for (const dir of dirs) {
    if (excluded.has(resolve(dir))) continue;
    for (const ext of exts) {
      const candidate = join(dir, binaryName + ext);
      if (await isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

async function isExecutableFile(p: string): Promise<boolean> {
  try {
    const st = await stat(p); // follow symlinks — a shim/wrapper is a valid target
    if (!st.isFile()) return false;
    if (process.platform === 'win32') return true; // no x-bit semantics on Windows
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove every shim directory from a `PATH` string. Used to build the sanitised
 * environment a resolved real binary is exec'd under, so a child that itself
 * shells out to the harness (or re-execs) does not re-enter the shim.
 */
export function sanitisePath(pathValue: string, shimDirs: readonly string[]): string {
  const excluded = new Set(shimDirs.map((d) => resolve(d)));
  return pathValue
    .split(delimiter)
    .filter((d) => d.length > 0 && !excluded.has(resolve(d)))
    .join(delimiter);
}
