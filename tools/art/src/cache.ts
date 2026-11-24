// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ArtCache {
  root: string;
  venv: string;
  python: string;
  comfy: string;
  models: string;
  io: { input: string; output: string };
  work: string;
  bench: string;
  modelPaths: string;
}

/** The cache's layout. `$ART_CACHE`, default `~/pcode/unity-art-cache`: outside the repo, never committed. */
export function artCache(env: NodeJS.ProcessEnv = process.env): ArtCache {
  const root = env.ART_CACHE || join(homedir(), 'pcode', 'unity-art-cache');
  return {
    root,
    venv: join(root, 'venv'),
    python: join(root, 'venv', 'bin', 'python'),
    comfy: join(root, 'ComfyUI'),
    models: join(root, 'models'),
    io: { input: join(root, 'comfy-io', 'input'), output: join(root, 'comfy-io', 'output') },
    work: join(root, 'work'),
    bench: join(root, 'bench'),
    modelPaths: join(root, 'extra_model_paths.yaml'),
  };
}

/** Whether the live tests can run: ART_CACHE set and its venv and ComfyUI present (the reason if not). */
export function liveReady(env: NodeJS.ProcessEnv = process.env): { ok: true } | { ok: false; why: string } {
  if (!env.ART_CACHE) return { ok: false, why: 'ART_CACHE is not set' };
  const c = artCache(env);
  if (!existsSync(c.python)) return { ok: false, why: `no venv at ${c.venv} (run tools/art/setup/install.sh)` };
  if (!existsSync(join(c.comfy, 'main.py'))) return { ok: false, why: `no ComfyUI at ${c.comfy}` };
  return { ok: true };
}

/**
 * Whether another run holds the shared GPU lock (`<cache>/.comfy.lock`): a non-blocking probe, `lockf -k -t 0 <lock> true`, which exits 75
 * when the lock is taken. The live ComfyUI tests skip while it is, as their timeouts are shorter than the queue. No lockf: not held.
 */
export function comfyLockHeld(env: NodeJS.ProcessEnv = process.env): boolean {
  const lock = join(artCache(env).root, '.comfy.lock');
  if (!existsSync(lock)) return false;
  const r = spawnSync('/usr/bin/lockf', ['-k', '-t', '0', lock, 'true'], { stdio: 'ignore' });
  return r.status === 75;
}
