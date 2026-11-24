// SPDX-License-Identifier: GPL-3.0-or-later
import { runTracediff } from './cli';

try {
  process.exitCode = await runTracediff(process.argv.slice(2), line => console.log(line));
} catch (e) {
  // (runTracediff answers its own failures; this is the last guard against a stack trace)
  console.log(`tracediff: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 2;
}
