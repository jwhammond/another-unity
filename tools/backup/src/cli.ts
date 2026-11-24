// SPDX-License-Identifier: GPL-3.0-or-later
// npm run backup [-- --with-runs | --check | --restore <dir> [--target local|r2]]
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { runBackup } from './run';

const code = runBackup(process.argv.slice(2), process.env, {
  run: (cmd, args, env) => {
    const r = spawnSync(cmd, args, { stdio: 'inherit', env: env as NodeJS.ProcessEnv });
    if (r.error) {
      console.error(`could not run ${cmd}: ${(r.error as NodeJS.ErrnoException).code ?? 'error'}`);
      return 1;
    }
    return r.status ?? 1;
  },
  mkdir: (d) => mkdirSync(d, { recursive: true }),
  log: (l) => console.log(l),
});
process.exit(code);
