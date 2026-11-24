// SPDX-License-Identifier: GPL-3.0-or-later
// The backup commands, with the process runner injected. Nothing here prints a secret: only target names (local, r2).
import { dirname } from 'node:path';
import { planBackup, planTargets, type Env } from './plan';

export type Runner = (cmd: string, args: string[], env: Env) => number;
export type Io = { run: Runner; mkdir: (dir: string) => void; log: (line: string) => void };

const USAGE = 'usage: backup [--with-runs] | --check | --restore <dir> [--target local|r2]';

// returns the exit code
export function runBackup(argv: string[], env: Env, io: Io, repoDir?: string): number {
  const check = argv.includes('--check');
  const ri = argv.indexOf('--restore');
  const restoreDir = ri >= 0 ? argv[ri + 1] : undefined;
  // (`--restore --target r2` names no folder: an option is never taken for one)
  if (ri >= 0 && (!restoreDir || restoreDir.startsWith('--'))) {
    io.log(USAGE);
    return 1;
  }
  const ti = argv.indexOf('--target');
  const only = ti >= 0 ? argv[ti + 1] : undefined;
  if (ti >= 0 && only !== 'local' && only !== 'r2') {
    io.log(USAGE);
    return 1;
  }

  // (a check or a restore needs only the targets and the password; a backup needs the paths it reads too)
  const plan = check || restoreDir ? { ...planTargets(env), paths: [], excludes: [], bundles: [] }
    : planBackup(env, { withRuns: argv.includes('--with-runs') }, repoDir);
  if (plan.missing.length > 0 || plan.targets.length === 0) {
    io.log('backup: not set up; missing:');
    for (const m of plan.missing) io.log(`  ${m}`);
    return 1;
  }
  let targets = plan.targets;
  if (only) targets = targets.filter((t) => t.name === only);
  else if (restoreDir) targets = targets.slice(0, 1);
  if (targets.length === 0) {
    io.log(`backup: target ${only} is not configured`);
    return 1;
  }
  const withRepo = (repo: string): Env => ({ ...env, RESTIC_REPOSITORY: repo });

  if (restoreDir) {
    const t = targets[0]!;
    io.log(`restoring latest from ${t.name} to ${restoreDir}`);
    return io.run('restic', ['restore', 'latest', '--target', restoreDir], withRepo(t.repo));
  }
  if (check) {
    let code = 0;
    for (const t of targets) {
      io.log(`checking ${t.name}`);
      code = io.run('restic', ['check'], withRepo(t.repo)) || code;
    }
    return code;
  }

  for (const b of plan.bundles) {
    io.mkdir(dirname(b.out));
    const c = io.run('git', ['-C', b.repo, 'bundle', 'create', b.out, '--all'], env);
    if (c !== 0) {
      io.log('backup: a git bundle failed; nothing was backed up');
      return c;
    }
  }
  let code = 0;
  for (const t of targets) {
    io.log(`backing up to ${t.name}`);
    const args = ['backup', '--compression', 'max', ...plan.excludes.flatMap((e) => ['--exclude', e]), ...plan.paths];
    const c = io.run('restic', args, withRepo(t.repo));
    if (c !== 0) io.log(`backup to ${t.name} failed (exit ${c})`);
    code = c || code;
  }
  return code;
}
