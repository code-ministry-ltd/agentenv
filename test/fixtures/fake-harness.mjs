#!/usr/bin/env node
/**
 * The fake harness binary for the fixture adapter (Task 1.6, Deliver B).
 *
 * A stand-in for a real coding-agent CLI: it reads the config-root override the
 * fixture adapter declares (FIXTURE_CONFIG_DIR) and reports what it observes, so
 * the whole session machinery is testable with NO real harness installed.
 *
 * Usage (all read FIXTURE_CONFIG_DIR):
 *   fake-harness                    → prints the observed config root, one line
 *   fake-harness --print-config-root → same (explicit; used by the self-check)
 *   fake-harness --list-skills      → prints each entry name in <root>/skills
 *   fake-harness --show-instructions→ prints the contents of <root>/INSTRUCTIONS.md
 *   fake-harness --show-mcp         → prints mcpServers keys from <root>/config.json
 *
 * Exit code is 0 on success. It never writes anywhere — it only reads the root.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.FIXTURE_CONFIG_DIR ?? '(none)';
const mode = process.argv[2] ?? '--print-config-root';

function out(s) {
  process.stdout.write(`${s}\n`);
}

try {
  if (mode === '--print-config-root' || mode === undefined) {
    out(root);
  } else if (mode === '--list-skills') {
    let names = [];
    try {
      names = readdirSync(join(root, 'skills')).sort();
    } catch {
      /* no skills dir → empty */
    }
    out(names.join(','));
  } else if (mode === '--show-instructions') {
    let text = '';
    try {
      text = readFileSync(join(root, 'INSTRUCTIONS.md'), 'utf8');
    } catch {
      /* no instructions → empty */
    }
    process.stdout.write(text);
  } else if (mode === '--show-mcp') {
    let keys = [];
    try {
      const cfg = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      keys = Object.keys(cfg.mcpServers ?? {}).sort();
    } catch {
      /* no config → empty */
    }
    out(keys.join(','));
  } else {
    // Unknown mode still prints the root, so a bare probe always works.
    out(root);
  }
  process.exit(0);
} catch (err) {
  process.stderr.write(`fake-harness: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
}
