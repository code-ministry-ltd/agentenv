#!/usr/bin/env node
import { run } from './cli.js';

// Top-level catch (M2): the CLI surface is designed to never throw (session
// launches fail open, commands return a RunResult), but a truly unexpected throw
// must still exit cleanly with a one-line diagnostic rather than an unhandled
// rejection stack. Set exitCode rather than calling process.exit() so a
// piped/redirected stream is allowed to drain instead of being truncated.
try {
  const { stdout, stderr, code } = await run(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = code;
} catch (err) {
  process.stderr.write(`agentenv: fatal error (${err instanceof Error ? err.message : String(err)})\n`);
  process.exitCode = 1;
}
