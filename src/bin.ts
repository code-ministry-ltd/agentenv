#!/usr/bin/env node
import { run } from './cli.js';

const { stdout, code } = run(process.argv.slice(2));
process.stdout.write(stdout);
// Set exitCode rather than calling process.exit() so a piped/redirected stdout
// is allowed to drain instead of being truncated on a hard exit.
process.exitCode = code;
