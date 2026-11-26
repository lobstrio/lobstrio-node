#!/usr/bin/env node
import { main } from './cli.js';

// A reader that stops early (`| head`) closes the pipe: not an error.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

main(process.argv.slice(2), {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  stdoutIsTTY: Boolean(process.stdout.isTTY),
  stderrIsTTY: Boolean(process.stderr.isTTY),
}).then((code) => {
  process.exitCode = code;
});
