import type { Command } from '../command.js';
import { createCommand } from './create.js';
import { listCommand } from './list.js';
import { showCommand } from './show.js';

/**
 * The command registry: the single source of truth for which subcommands
 * exist. `run` dispatches by looking a name up here, and `--help` lists these
 * entries. Each slice appends its command; order here is the display order.
 */
export const commands: readonly Command[] = [createCommand, listCommand, showCommand];

export function findCommand(name: string): Command | undefined {
  return commands.find((c) => c.name === name);
}
