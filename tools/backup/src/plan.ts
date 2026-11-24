// SPDX-License-Identifier: GPL-3.0-or-later
// What `npm run backup` saves, and where. Pure: it reads only the env it is given and touches nothing.
import { join } from 'node:path';

export type Env = Record<string, string | undefined>;
export type BackupPlan = {
  paths: string[];
  excludes: string[];
  targets: { name: 'local' | 'r2'; repo: string }[];
  bundles: { repo: string; out: string }[];
  missing: string[];
};

// the art cache's own work. Its models, venvs and ComfyUI come back by themselves, so they are not listed.
const ART_FOLDERS = ['work', 'refs', 'comfy-io', 'originals', 'bench', 'bench-remote'];

const needing = (env: Env, missing: string[]) => (name: string): string | undefined => {
  const v = env[name];
  if (!v) missing.push(name);
  return v || undefined;
};

/**
 * The repositories alone, and what they need: a target and the password. All `--check` and `--restore` need, so a restore on a fresh
 * machine (no art cache, no CD folder yet) isn't refused for the paths only a backup reads.
 */
export function planTargets(env: Env): Pick<BackupPlan, 'targets' | 'missing'> {
  const missing: string[] = [];
  const need = needing(env, missing);
  const targets: BackupPlan['targets'] = [];
  const local = env.BACKUP_LOCAL_REPO;
  if (local) targets.push({ name: 'local', repo: local });
  const r2 = env.BACKUP_R2_REPO;
  if (r2) {
    const key = need('AWS_ACCESS_KEY_ID');
    const secret = need('AWS_SECRET_ACCESS_KEY');
    if (key && secret) targets.push({ name: 'r2', repo: r2 });
  }
  if (!local && !r2) missing.push('BACKUP_LOCAL_REPO or BACKUP_R2_REPO');
  if (!env.RESTIC_PASSWORD_COMMAND && !env.RESTIC_PASSWORD && !env.RESTIC_PASSWORD_FILE) missing.push('RESTIC_PASSWORD_COMMAND');
  return { targets, missing };
}

export function planBackup(env: Env, flags: { withRuns: boolean }, repoDir: string = process.cwd()): BackupPlan {
  const { targets, missing } = planTargets(env);
  const need = needing(env, missing);

  const override = env.BACKUP_PATHS_OVERRIDE;
  if (override) {
    // (test only: a small set of paths, and no bundles)
    return { paths: override.split(':').filter(Boolean), excludes: [], targets, bundles: [], missing };
  }

  const home = need('HOME');
  const art = need('ART_CACHE');
  const cd = need('GAMEDATA_DIR');
  const paths: string[] = [];
  if (art) for (const f of ART_FOLDERS) paths.push(join(art, f));
  if (cd) paths.push(cd);
  paths.push(join(repoDir, 'games/unity/gate.yaml'));
  const bundles: BackupPlan['bundles'] = [];
  if (home) {
    if (flags.withRuns) paths.push(join(home, 'pcode/unity-raw'));
    const out = join(home, '.cache/au-backup');
    bundles.push({ repo: repoDir, out: join(out, 'another-unity.bundle') });
    bundles.push({ repo: join(home, 'pcode/scummvm-export'), out: join(out, 'scummvm-export.bundle') });
    paths.push(out);
  }
  return { paths, excludes: ['.DS_Store'], targets, bundles, missing };
}
