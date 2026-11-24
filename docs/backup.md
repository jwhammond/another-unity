# Backups

`npm run backup` saves everything the repo doesn't hold, with [restic](https://restic.net): encrypted on this Mac, deduplicated and
compressed (zstd, `--compression max`). The code is in `tools/backup`.

## What is saved

| What | Path | Size (2026-11-09) |
|---|---|---|
| The art cache's own work | `$ART_CACHE/{work,refs,comfy-io,originals,bench,bench-remote}` | ~26 GB |
| The CD | `$GAMEDATA_DIR` | 1.2 GB |
| The ScummVM runs | `~/pcode/unity-raw` (only with `--with-runs`) | 5.3 GB |
| The gate file | `games/unity/gate.yaml` | tiny |
| The export fork | a `git bundle --all` of `~/pcode/scummvm-export` | small |
| This repo's branches | a `git bundle --all` (local branches and unpushed work survive the push) | small |

The bundles are written to `~/.cache/au-backup` just before each run, and that folder is saved too.

Left out, because they come back by themselves:
- the art cache's `models` (`tools/art/setup` downloads them again, pinned), `venv`, `venv-face` and `ComfyUI`;
- `games/unity`'s built files (`npm run unity:build` and the art rebuild them);
- `node_modules`.

## Costs

- An external drive: nothing a month.
- Cloudflare R2: the first 10 GB are free, then about $0.015/GB-month, so about $0.35/month for ~33 GB (the 26 GB art cache,
  the 1.2 GB CD, 5.3 GB of runs, and the small rest). That is the price at the time of writing (2026-11-09); check Cloudflare's
  price list. Compression and dedup likely make it less. There is no egress fee, so a restore costs nothing to download.
- Later runs upload only what changed.

## Setup

1. `brew install restic`.
2. Make a password once (for example `openssl rand -base64 32`). Keep it in a **password manager**: without it the backup cannot be
   read. Also put it in the Keychain, as a generic password named `au-backup`:
   `security add-generic-password -a "$USER" -s au-backup -w`
3. In the shell profile, set the password command, which restic runs itself:
   `export RESTIC_PASSWORD_COMMAND='security find-generic-password -a "$USER" -s au-backup -w'`
4. Choose a target, or both:
   - **A drive or folder**: `export BACKUP_LOCAL_REPO=/Volumes/Backup/au-backup`
   - **R2**: in the Cloudflare dashboard make a bucket, then an API token for R2 limited to that bucket (Object Read & Write). Set
     `BACKUP_R2_REPO=s3:https://<account>.r2.cloudflarestorage.com/<bucket>`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. Keep
     these in the Keychain or the shell profile, never in the repo.
5. Also set `ART_CACHE` and `GAMEDATA_DIR`, which the art tools and the gate already use.
6. Make each repository once: `RESTIC_REPOSITORY=<the path or s3: url> restic init`.

## Commands

- `npm run backup` makes the two bundles, then runs `restic backup --compression max` for each target.
- `npm run backup -- --with-runs` adds `~/pcode/unity-raw`.
- `npm run backup -- --check` runs `restic check` on each target.
- `npm run backup -- --restore <dir> [--target local|r2]` runs `restic restore latest --target <dir>` (the first target if none is named).

`--check` and `--restore` need only the targets and the password (`ART_CACHE`, `GAMEDATA_DIR` and `HOME` are for a backup), so they work
on a fresh machine. If anything it needs is unset, it names what, runs nothing and exits 1. It prints target names (`local`, `r2`) and never a key,
a password or a repository URL.

## Restoring

Restore into an empty folder, then put things back in this order:

1. Install restic, set `RESTIC_PASSWORD_COMMAND` (or `RESTIC_PASSWORD` from the password manager) and the target's variables.
2. `npm run backup -- --restore ~/restore`. Restic keeps the original absolute paths below it.
   A restore needs the same env set as a backup (the password and the target's variables).
   `restore latest` has no `~/pcode/unity-raw` if the last run was made without `--with-runs`.
3. Clone this repo from its remote, or from the bundle: `git clone ~/restore<home>/.cache/au-backup/another-unity.bundle another-unity`.
   The export fork comes from `scummvm-export.bundle` the same way.
4. Copy the CD back to `$GAMEDATA_DIR`, then `games/unity/gate.yaml` to `games/unity/gate.yaml`. Keep that file: a new one would
   orphan every sealed file already published.
5. Copy the art cache's folders back into `$ART_CACHE`, then run `tools/art/setup` for the models, venvs and ComfyUI.
6. `npm install`, then `npm run unity:build` to rebuild `games/unity`.
7. Set up the secrets again (below).

## A yearly restore test

Once a year: `npm run backup -- --check`, then restore into a scratch folder and compare a sample with the original, for example
`diff -r "$ART_CACHE/refs" ~/restore"$ART_CACHE/refs"`. A backup that has never been restored is a guess.

## Set up again after a restore

Not backed up, by design. Names only:
- the Jellyfin API key (`JELLYFIN_ENV` points at where it lives);
- wrangler's login (`npx wrangler login`);
- `CF_PAGES_PROJECT`;
- the R2 token and the restic password (from the password manager).
