import type { Command, CommandContext, RunResult } from '../command.js';
import { loadSecrets, maskSecret, writeSecrets } from '../secrets.js';

/** A valid secret KEY — the same shape `secrets.env` parsing accepts. */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `agentenv secret set|list|rm` — manage machine-local `${VAR}` values in
 * `~/.agentenv/secrets.env` (spec criterion 7, design D6). This file lives BESIDE
 * the store, never inside it, so a value set here is never synced. Materialisation
 * resolves `${VAR}` from here (then the shell env) for the substitute rung; the
 * store only ever holds placeholders.
 *
 * `list` MASKS every value — it prints key names and a fixed dot run, never the
 * secret — and no subcommand ever echoes a value back.
 */
export const secretCommand: Command = {
  name: 'secret',
  usage: 'set <KEY> <VALUE> | list | rm <KEY>',
  summary: 'Manage machine-local ${VAR} secret values (never synced)',

  async run(ctx): Promise<RunResult> {
    const action = ctx.args[0];
    switch (action) {
      case 'set':
        return setSecret(ctx);
      case 'list':
      case 'ls':
        return listSecrets(ctx);
      case 'rm':
      case 'unset':
        return removeSecret(ctx);
      case undefined:
        return listSecrets(ctx); // bare `agentenv secret` lists (masked)
      default:
        return {
          stdout: '',
          stderr: `secret: unknown action '${action}'\nUsage: agentenv secret ${secretCommand.usage}\n`,
          code: 1,
        };
    }
  },
};

async function setSecret(ctx: CommandContext): Promise<RunResult> {
  const key = ctx.args[1];
  const value = ctx.args[2];
  if (key === undefined || value === undefined) {
    return {
      stdout: '',
      stderr: 'secret set: expected <KEY> <VALUE>\nUsage: agentenv secret set <KEY> <VALUE>\n',
      code: 1,
    };
  }
  if (!KEY_RE.test(key)) {
    return {
      stdout: '',
      stderr: `secret set: invalid key '${key}' — must match [A-Za-z_][A-Za-z0-9_]*\n`,
      code: 1,
    };
  }
  const secrets = await loadSecrets(ctx.paths);
  const existed = secrets.has(key);
  secrets.set(key, value);
  await writeSecrets(ctx.paths, secrets);
  // Never echo the value.
  return { stdout: `${existed ? 'Updated' : 'Set'} secret ${key} (machine-local, not synced).\n`, code: 0 };
}

async function listSecrets(ctx: CommandContext): Promise<RunResult> {
  const secrets = await loadSecrets(ctx.paths);
  if (secrets.size === 0) {
    return {
      stdout: "No secrets set. Add one with 'agentenv secret set <KEY> <VALUE>'.\n",
      code: 0,
    };
  }
  const keys = [...secrets.keys()].sort();
  const width = Math.max(...keys.map((k) => k.length));
  const lines = keys.map((k) => `  ${k.padEnd(width)}  ${maskSecret(secrets.get(k) ?? '')}`);
  return { stdout: `${lines.join('\n')}\n`, code: 0 };
}

async function removeSecret(ctx: CommandContext): Promise<RunResult> {
  const key = ctx.args[1];
  if (key === undefined) {
    return { stdout: '', stderr: 'secret rm: expected <KEY>\nUsage: agentenv secret rm <KEY>\n', code: 1 };
  }
  const secrets = await loadSecrets(ctx.paths);
  if (!secrets.delete(key)) {
    return { stdout: `No secret ${key} to remove.\n`, code: 0 };
  }
  await writeSecrets(ctx.paths, secrets);
  return { stdout: `Removed secret ${key}.\n`, code: 0 };
}
