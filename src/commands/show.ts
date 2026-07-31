import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from '../args.js';
import type { Command } from '../command.js';
import { EnvYamlError } from '../env-config.js';
import { environmentExists, readEnvConfig } from '../store.js';

/** Content subdirectories a later task populates; shown as an inventory here. */
const CONTENT_SUBDIRS = ['skills', 'instructions', 'mcp', 'agents', 'commands', 'files'];

async function inventory(envDir: string): Promise<string[]> {
  const lines: string[] = [];
  for (const sub of CONTENT_SUBDIRS) {
    try {
      const entries = await readdir(join(envDir, sub));
      lines.push(`  ${sub}: ${entries.length}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return lines;
}

export const showCommand: Command = {
  name: 'show',
  usage: '<name>',
  summary: "Show an environment's manifest and contents",

  async run({ args, paths }) {
    const parsed = parseArgs(args);
    if (parsed.unknown.length > 0) {
      return { stdout: '', stderr: `show: unknown option '${parsed.unknown[0]}'\n`, code: 1 };
    }
    const name = parsed.positionals[0];
    if (name === undefined) {
      return { stdout: '', stderr: 'show: missing environment name\nUsage: agentenv show <name>\n', code: 1 };
    }

    if (!(await environmentExists(paths, name))) {
      return { stdout: '', stderr: `show: environment '${name}' does not exist\n`, code: 1 };
    }

    let cfg;
    try {
      cfg = await readEnvConfig(paths, name);
    } catch (err) {
      if (err instanceof EnvYamlError) {
        return { stdout: '', stderr: `show: ${err.message}\n`, code: 1 };
      }
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          stdout: '',
          stderr: `show: environment '${name}' has no env.yaml (${paths.envYaml(name)})\n`,
          code: 1,
        };
      }
      throw err;
    }

    const lines = [
      `Environment: ${name}`,
      `Version:     ${cfg.version}`,
      `Description: ${cfg.description || '(none)'}`,
    ];
    if (cfg.notes) {
      lines.push(`Notes:       ${cfg.notes}`);
    }
    if (cfg.capture?.ignore && cfg.capture.ignore.length > 0) {
      lines.push('Capture-ignore:');
      for (const pattern of cfg.capture.ignore) {
        lines.push(`  - ${pattern}`);
      }
    }

    const items = await inventory(paths.envDir(name));
    lines.push('Contents:');
    if (items.length === 0) {
      lines.push('  (no items yet)');
    } else {
      lines.push(...items);
    }

    return { stdout: `${lines.join('\n')}\n`, code: 0 };
  },
};
