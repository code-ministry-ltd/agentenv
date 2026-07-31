#!/usr/bin/env node
import { run } from './cli.js';

const { stdout, stderr, code } = await run(process.argv.slice(2));
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);
// Set exitCode rather than calling process.exit() so a piped/redirected stream
// is allowed to drain instead of being truncated on a hard exit.
process.exitCode = code;
