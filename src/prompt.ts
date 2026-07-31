import { createInterface } from 'node:readline';

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
