import { createInterface } from 'node:readline';
import type { SkillChoice } from './command.js';

/**
 * Default confirmation prompt for destructive actions. Reads a yes/no answer
 * from a real TTY; when stdin is not a TTY (tests, pipes, CI) it declines
 * rather than blocking — the caller offers `--yes` to proceed non-interactively.
 * The question is written to stderr so stdout stays machine-clean.
 */
export async function confirmDefault(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * Default `add skills` checklist (design D17). Prints a numbered list of skills
 * (name + description) to stderr and reads a selection: `all`, `none`/empty, or
 * a comma/space list of numbers. Without a TTY it selects nothing — the caller
 * points the user at `--all` for non-interactive installs. Returns skill names.
 */
export async function selectSkillsDefault(choices: readonly SkillChoice[]): Promise<string[]> {
  if (!process.stdin.isTTY || choices.length === 0) {
    return [];
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write('Select skills to install (e.g. "1,3", "all", or "none"):\n');
    choices.forEach((c, i) => {
      const desc = c.description ? ` — ${c.description}` : '';
      process.stderr.write(`  ${i + 1}) ${c.name}${desc}\n`);
    });
    const answer = (await new Promise<string>((resolve) => rl.question('> ', resolve))).trim().toLowerCase();
    if (answer === '' || answer === 'none') return [];
    if (answer === 'all') return choices.map((c) => c.name);
    const picked = new Set<string>();
    for (const token of answer.split(/[\s,]+/)) {
      const idx = Number(token);
      if (Number.isInteger(idx) && idx >= 1 && idx <= choices.length) {
        picked.add(choices[idx - 1]!.name);
      }
    }
    return [...picked];
  } finally {
    rl.close();
  }
}
