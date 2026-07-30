#!/usr/bin/env node
import { run } from './cli.js';

const { stdout, code } = run(process.argv.slice(2));
process.stdout.write(stdout);
process.exit(code);
