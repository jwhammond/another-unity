// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
export const WEB = fileURLToPath(new URL('../..', import.meta.url));
/** The self-contained output a deploy uploads. Git-ignored: it holds the local game data and art. */
export const OUT = `${WEB}dist-deploy`;
export const DEPLOY_FILES = `${WEB}deploy`;

/** Pages project names: lowercase letters, digits and hyphens, up to 58 characters, not starting or ending with a hyphen. */
export function validProjectName(name: string | undefined): name is string {
  return !!name && /^[a-z0-9]([a-z0-9-]{0,56}[a-z0-9])?$/.test(name);
}

/** Runs a command with the output shown; returns its exit code. */
export function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}): number {
  const r = spawnSync(cmd, args, { cwd: opts.cwd ?? REPO, stdio: 'inherit', env: { ...process.env, ...opts.env } });
  if (r.error) console.error(`${cmd}: ${r.error.message}`);
  return r.status ?? 1;
}

/** Whether the lifted game data and the published art are on this machine (they are git-ignored; docs/unity-local.md makes them). */
export function localGamePresent(): { data: boolean; art: boolean } {
  return { data: existsSync(`${REPO}games/unity/game.yaml`), art: existsSync(`${REPO}games/unity/art`) };
}
