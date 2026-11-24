// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { planBackup } from './plan';
import { runBackup, type Runner } from './run';

const env = {
  HOME: '/home/u',
  ART_CACHE: '/cache/art',
  GAMEDATA_DIR: '/data/cd',
  BACKUP_LOCAL_REPO: '/mnt/drive/repo',
  BACKUP_R2_REPO: 's3:https://acct.example/bucket',
  AWS_ACCESS_KEY_ID: 'made-up-id',
  AWS_SECRET_ACCESS_KEY: 'made-up-secret',
  RESTIC_PASSWORD_COMMAND: 'echo x',
};
const repo = '/work/repo';

function harness(e: Record<string, string | undefined>, argv: string[] = []) {
  const calls: { cmd: string; args: string[] }[] = [];
  const out: string[] = [];
  const run: Runner = (cmd, args) => (calls.push({ cmd, args }), 0);
  const code = runBackup(argv, e, { run, mkdir: () => {}, log: (l) => out.push(l) }, repo);
  return { calls, out, code };
}

describe('planBackup', () => {
  it("plans the art cache's own folders and not models or venvs", () => {
    const p = planBackup(env, { withRuns: false }, repo);
    expect(p.missing).toEqual([]);
    for (const f of ['work', 'refs', 'comfy-io', 'originals', 'bench', 'bench-remote']) expect(p.paths).toContain(`/cache/art/${f}`);
    expect(p.paths.some((x) => /models|venv|ComfyUI/.test(x))).toBe(false);
    expect(p.paths).toContain('/data/cd');
    expect(p.paths).toContain('/work/repo/games/unity/gate.yaml');
    expect(p.paths).toContain('/home/u/.cache/au-backup');
    expect(p.bundles.map((b) => b.repo)).toEqual(['/work/repo', '/home/u/pcode/scummvm-export']);
    expect(p.targets.map((t) => t.name)).toEqual(['local', 'r2']);
  });

  it('adds unity-raw only with --with-runs', () => {
    expect(planBackup(env, { withRuns: false }, repo).paths).not.toContain('/home/u/pcode/unity-raw');
    expect(planBackup(env, { withRuns: true }, repo).paths).toContain('/home/u/pcode/unity-raw');
  });

  it('names what is unset, and skips an r2 target without keys', () => {
    const p = planBackup({ HOME: '/h', BACKUP_R2_REPO: 's3:x' }, { withRuns: false }, repo);
    expect(p.targets).toEqual([]);
    expect(p.missing).toEqual(expect.arrayContaining(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'ART_CACHE', 'GAMEDATA_DIR', 'RESTIC_PASSWORD_COMMAND']));
  });

  it('honours the test-only path override, with no bundles', () => {
    const p = planBackup({ ...env, BACKUP_PATHS_OVERRIDE: '/a:/b' }, { withRuns: true }, repo);
    expect(p.paths).toEqual(['/a', '/b']);
    expect(p.bundles).toEqual([]);
  });
});

describe('runBackup', () => {
  it('no target means exit 1 and no command run', () => {
    const { calls, out, code } = harness({ ...env, BACKUP_LOCAL_REPO: undefined, BACKUP_R2_REPO: undefined });
    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(out.join('\n')).toContain('BACKUP_LOCAL_REPO or BACKUP_R2_REPO');
  });

  it('each target gets a backup with --compression max, after the bundles', () => {
    const { calls, code } = harness(env);
    expect(code).toBe(0);
    expect(calls.filter((c) => c.cmd === 'git').length).toBe(2);
    const backups = calls.filter((c) => c.cmd === 'restic');
    expect(backups.length).toBe(2);
    for (const b of backups) expect(b.args.slice(0, 3)).toEqual(['backup', '--compression', 'max']);
    expect(calls[0]!.cmd).toBe('git');
  });

  it('never prints a secret or a repo url', () => {
    const { out } = harness(env);
    const text = out.join('\n');
    for (const s of ['made-up-id', 'made-up-secret', 'acct.example', '/mnt/drive']) expect(text).not.toContain(s);
    expect(text).toContain('local');
    expect(text).toContain('r2');
  });

  it('--check and --restore run restic with the chosen target', () => {
    expect(harness(env, ['--check']).calls.map((c) => c.args)).toEqual([['check'], ['check']]);
    const r = harness(env, ['--restore', '/out', '--target', 'r2']);
    expect(r.calls).toEqual([{ cmd: 'restic', args: ['restore', 'latest', '--target', '/out'] }]);
  });

  it('--check and --restore need only a target and the password, not the paths a backup reads', () => {
    // (a fresh machine: no art cache, no CD folder, no HOME)
    const fresh = { BACKUP_LOCAL_REPO: '/mnt/drive/repo', RESTIC_PASSWORD_COMMAND: 'echo x' };
    const c = harness(fresh, ['--check']);
    expect(c.code).toBe(0);
    expect(c.calls.map((x) => x.args)).toEqual([['check']]);
    const r = harness(fresh, ['--restore', '/out']);
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([{ cmd: 'restic', args: ['restore', 'latest', '--target', '/out'] }]);
    // (the password is still needed)
    const noPassword = harness({ BACKUP_LOCAL_REPO: '/mnt/drive/repo' }, ['--check']);
    expect(noPassword.code).toBe(1);
    expect(noPassword.out).toContain('  RESTIC_PASSWORD_COMMAND');
    // (and a backup still needs its paths)
    const backup = harness(fresh, []);
    expect(backup.code).toBe(1);
    expect(backup.out).toEqual(expect.arrayContaining(['  ART_CACHE', '  GAMEDATA_DIR']));
    expect(backup.calls).toEqual([]);
  });

  it('--restore --target r2 is an option, not a folder', () => {
    const r = harness(env, ['--restore', '--target', 'r2']);
    expect(r.code).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.out[0]).toMatch(/^usage: /);
    // (the folder first, then the option, in either order)
    expect(harness(env, ['--target', 'r2', '--restore', '/out']).calls).toEqual([{ cmd: 'restic', args: ['restore', 'latest', '--target', '/out'] }]);
  });
});
