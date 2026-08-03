import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Adapter } from '../adapter.js';
import type { Paths } from '../paths.js';

/**
 * Generate one PATH shim per supported harness in `~/.agentenv/shims/` (D15).
 * `agentenv init` (Task 1.7) installs these; Task 1.6 provides the generator and
 * tests it directly.
 *
 * A shim is a tiny POSIX-sh stand-in named after the harness binary. When the
 * shell hook puts the shim dir first on PATH, launching `claude` runs the shim,
 * which delegates the whole binding/compose/exec decision to `agentenv __shim`
 * (the Node-side logic, which itself resolves the REAL binary from a sanitised
 * PATH and fails open). If `agentenv` is not even installed, the shim still does
 * the right thing: it strips its own dir from PATH and execs the real binary
 * untouched — the shim must never brick the user's tool.
 */
export async function generateShims(
  paths: Paths,
  adapters: readonly Adapter[],
): Promise<string[]> {
  await mkdir(paths.shims, { recursive: true });
  const written: string[] = [];
  for (const adapter of adapters) {
    for (const binaryName of [adapter.binaryName, ...(adapter.aliases ?? [])]) {
      const shimPath = join(paths.shims, binaryName);
      await writeFile(shimPath, shimScript(binaryName, paths.shims), 'utf8');
      await chmod(shimPath, 0o755);
      written.push(shimPath);
    }
  }
  return written;
}

/** The shim script body for one harness binary. */
export function shimScript(binaryName: string, shimsDir: string): string {
  // Single-quote the two interpolated strings for the shell. Neither an
  // agentenv home path nor a v1 harness binary name contains a single quote;
  // guard anyway by escaping ' as the standard '\'' sequence.
  const bin = shQuote(binaryName);
  const dir = shQuote(shimsDir);
  return `#!/bin/sh
# agentenv shim for ${binaryName} — generated; do not edit.
# Delegates the launch decision (bind? compose? exec) to agentenv, which resolves
# the REAL ${binaryName} from a PATH with shim dirs removed and fails open. If
# agentenv is unavailable, resolve and exec the real binary directly — normalising
# symlinks/trailing slashes so an uninstalled/broken agentenv never bricks the tool
# and, crucially, never exec-loops back into this shim (H1).
bin=${bin}
if command -v agentenv >/dev/null 2>&1; then
  exec agentenv __shim "$bin" -- "$@"
fi
# Fallback: agentenv is unavailable. A re-entry SENTINEL guarantees termination:
# if it is already set we mis-resolved last time, so hard-fail with one line
# instead of exec-looping forever.
if [ -n "\${AGENTENV_SHIM:-}" ]; then
  printf 'agentenv: %s shim loop-guard tripped — real binary not found; aborting\\n' "$bin" >&2
  exit 127
fi
AGENTENV_SHIM=1
export AGENTENV_SHIM
# Resolve this shim's own dir to its PHYSICAL path (follows symlinks, collapses
# trailing/duplicate slashes) so the comparison below is exact regardless of how
# the shims dir appears on PATH.
shimreal=$(cd ${dir} 2>/dev/null && pwd -P) || shimreal=${dir}
real=""
IFS=:
for d in $PATH; do
  [ -n "$d" ] || d=.
  dreal=$(cd "$d" 2>/dev/null && pwd -P) || dreal="$d"
  [ "$dreal" = "$shimreal" ] && continue
  candidate="$d/$bin"
  [ -f "$candidate" ] && [ -x "$candidate" ] && { real="$candidate"; break; }
done
unset IFS
# Exec by ABSOLUTE PATH (never by bare name) so resolution can't re-enter the shim.
[ -n "$real" ] && exec "$real" "$@"
printf 'agentenv: real %s not found on PATH (shim dir excluded) — aborting\\n' "$bin" >&2
exit 127
`;
}

/** POSIX single-quote a string for safe interpolation into an sh script. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
