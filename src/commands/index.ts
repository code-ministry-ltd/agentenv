import type { Command } from '../command.js';
import { addCommand } from './add.js';
import { captureCommand } from './capture.js';
import { createCommand } from './create.js';
import { dropCommand } from './drop.js';
import { editCommand } from './edit.js';
import { initCommand } from './init.js';
import { listCommand } from './list.js';
import { remoteCommand } from './remote.js';
import { rmCommand } from './rm.js';
import { runCommand } from './run.js';
import { secretCommand } from './secret.js';
import { shellInitCommand } from './shell-init.js';
import { shimCommand } from './shim.js';
import { showCommand } from './show.js';
import { statusCommand } from './status.js';
import { syncCommand } from './sync.js';
import { useCommand } from './use.js';

/**
 * The command registry: the single source of truth for which subcommands
 * exist. `run` dispatches by looking a name up here, and `--help` lists these
 * entries. Each slice appends its command; order here is the display order.
 */
export const commands: readonly Command[] = [
  initCommand,
  createCommand,
  listCommand,
  showCommand,
  editCommand,
  rmCommand,
  addCommand,
  useCommand,
  dropCommand,
  captureCommand,
  secretCommand,
  statusCommand,
  remoteCommand,
  syncCommand,
  runCommand,
  shellInitCommand,
  shimCommand,
];

export function findCommand(name: string): Command | undefined {
  return commands.find((c) => c.name === name);
}
