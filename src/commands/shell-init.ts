import type { Command } from '../command.js';

/**
 * `agentenv shell-init` — emit the shell hook to be eval'd from `.zshrc`/`.bashrc`:
 *
 *   eval "$(agentenv shell-init)"
 *
 * The hook (1) puts `~/.agentenv/shims/` first on PATH so a launched harness runs
 * agentenv's shim, and (2) assigns each interactive shell a stable session id
 * (`AGENTENV_SESSION`) that the shim uses to look up this shell's binding (D15).
 * It is POSIX-sh so the same output works in bash and zsh. Pure: it only prints —
 * installing the shims themselves is `agentenv init` (Task 1.7).
 */
export const shellInitCommand: Command = {
  name: 'shell-init',
  usage: '',
  summary: 'Emit the shell hook (eval "$(agentenv shell-init)")',

  async run({ paths }) {
    const shims = shSingleQuote(paths.shims);
    const script = `# agentenv shell hook — eval "$(agentenv shell-init)" in your shell rc.
# 1) Put agentenv's shims first on PATH (idempotent).
case ":$PATH:" in
  *":"${shims}":"*) ;;
  *) PATH=${shims}":$PATH" ;;
esac
export PATH
# 2) Give this interactive shell a stable session id for agentenv bindings.
if [ -z "\${AGENTENV_SESSION:-}" ]; then
  AGENTENV_SESSION="$$-$(hostname 2>/dev/null || echo host)-\${RANDOM:-0}"
  export AGENTENV_SESSION
fi
`;
    return { stdout: script, code: 0 };
  },
};

/** POSIX single-quote for safe interpolation into the emitted sh. */
function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
