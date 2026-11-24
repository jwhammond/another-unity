// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Extension, NodeIO, PropertyType, type ReaderContext } from '@gltf-transform/core';
import type { ArtCache } from './cache';
import type { SpawnLike } from './comfy';
import type { BlenderRecipe } from './recipe';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..', '..');
/** Committed scripts live here (R11). */
export const BLENDER_SCRIPTS = join(REPO, 'art', 'blender');
export const BLENDER_APP = '/Applications/Blender.app/Contents/MacOS/Blender';

/** `$BLENDER` if it exists, else the app's binary, else undefined. */
export function blenderPath(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string | undefined {
  if (env.BLENDER) return exists(env.BLENDER) ? env.BLENDER : undefined;
  return exists(BLENDER_APP) ? BLENDER_APP : undefined;
}

/**
 * R11: headless, factory settings, no audio, a Python error is exit 1. The script finds `lib/` itself (it puts its own
 * directory on sys.path from __file__), so nothing here depends on Blender's -P path handling.
 */
export function blenderArgs(script: string, out: string, params: Record<string, unknown>, extra: string[] = []): string[] {
  return ['-b', '--factory-startup', '-noaudio', '--python-exit-code', '1', '-P', script, '--', '--out', out, '--params', JSON.stringify(params), ...extra];
}

const tail = (s: string, n: number): string => s.split('\n').filter(l => l.trim()).slice(-n).join('\n');

export async function runBlender(
  script: string,
  out: string,
  params: Record<string, unknown>,
  deps: { spawnFn?: SpawnLike; env?: NodeJS.ProcessEnv; log?: (line: string) => void; timeoutMs?: number; extraArgs?: string[] } = {},
): Promise<{ seconds: number; version: string }> {
  const env = deps.env ?? process.env;
  const bin = blenderPath(env);
  if (!bin) throw new Error(`no Blender: set $BLENDER or install it at ${BLENDER_APP}`);
  const spawnFn: SpawnLike = deps.spawnFn ?? ((cmd, args, o) => spawn(cmd, args, { ...o, stdio: ['ignore', 'pipe', 'pipe'] }));
  const log = deps.log ?? (() => {});
  await mkdir(dirname(out), { recursive: true });
  const t0 = Date.now();
  const child = spawnFn(bin, blenderArgs(script, out, params, deps.extraArgs), { cwd: dirname(script), env });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d: Buffer) => {
    stdout += d;
    for (const l of String(d).split('\n')) if (l.trim()) log(l);
  });
  child.stderr?.on('data', (d: Buffer) => (stderr += d));
  await new Promise<void>((ok, fail) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`blender timed out after ${deps.timeoutMs} ms running ${script}`));
    }, deps.timeoutMs ?? 300_000);
    child.on('error', e => (clearTimeout(timer), fail(e)));
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) ok();
      else fail(new Error(`blender exited ${code} running ${script}:\n${tail(stderr || stdout, 15)}`));
    });
  });
  const version = /^Blender (\d+\.\d+\.\d+)/m.exec(stdout)?.[1] ?? 'unknown';
  return { seconds: (Date.now() - t0) / 1000, version };
}

/** A stand-in for a texture extension that is required but whose images the checks don't read (no @gltf-transform/extensions here). */
function passThrough(name: string): typeof Extension {
  return class extends Extension {
    static EXTENSION_NAME = name;
    extensionName = name;
    prereadTypes = [PropertyType.TEXTURE];
    /** A texture whose image is under the extension (webp) gets that image as its plain `source`. */
    preread(context: ReaderContext): this {
      for (const t of context.jsonDoc.json.textures ?? []) {
        const e = (t.extensions as Record<string, { source?: number }> | undefined)?.[name];
        if (t.source === undefined && e?.source !== undefined) t.source = e.source;
      }
      return this;
    }
    read(): this {
      return this;
    }
    write(): this {
      return this;
    }
  };
}

/** Reads a .glb with gltf-transform: node names, extras, cameras and mesh count, for checks. */
export async function inspectGlb(bytes: Uint8Array): Promise<{ nodes: { name: string; extras: Record<string, unknown> }[]; cameras: number; meshes: number; textures: number; lights: number }> {
  // the glb's own JSON chunk names its extensions (webp textures, lights, emissive strength...): none of them matter to the checks
  const json = JSON.parse(Buffer.from(bytes.subarray(20, 20 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(12, true))).toString('utf8')) as { extensionsUsed?: string[]; extensions?: { KHR_lights_punctual?: { lights?: unknown[] } } };
  const doc = await new NodeIO().registerExtensions((json.extensionsUsed ?? []).map(passThrough)).readBinary(bytes);
  const root = doc.getRoot();
  return {
    nodes: root.listNodes().map(n => ({ name: n.getName(), extras: n.getExtras() as Record<string, unknown> })),
    cameras: root.listCameras().length,
    meshes: root.listMeshes().length,
    textures: root.listTextures().length,
    lights: json.extensions?.KHR_lights_punctual?.lights?.length ?? 0,
  };
}

export interface BlenderMeta {
  recipe: string;
  recipeSha256: string;
  blender: string;
  script: string;
  scriptSha256: string;
  seconds: number;
  textures: string[];
  outputs: { glb: { file: string; sha256: string; bytes: number } };
  checks: { nodes: number; cameras: number; meshes: number };
}

/** Runs a blender recipe into <work>/<id>/<run-stamp>/<id>.glb and updates <work>/<id>/last.json. */
export async function runBlenderRecipe(
  recipe: BlenderRecipe,
  recipeText: string,
  cache: ArtCache,
  deps: { spawnFn?: SpawnLike; env?: NodeJS.ProcessEnv; log?: (line: string) => void; scriptsDir?: string } = {},
): Promise<{ dir: string; meta: BlenderMeta }> {
  const script = resolve(deps.scriptsDir ?? BLENDER_SCRIPTS, recipe.script);
  if (!existsSync(script)) throw new Error(`no Blender script ${script}`);
  // Each texture recipe's last output (its first PNG), by recipe id.
  const textures: string[] = [];
  for (const id of recipe.textures) {
    let last: { meta: { outputs: Record<string, { file: string }> } };
    try {
      last = JSON.parse(await readFile(join(cache.work, id, 'last.json'), 'utf8'));
    } catch {
      throw new Error(`texture recipe "${id}" has no run (${join(cache.work, id, 'last.json')}): run it first`);
    }
    const first = Object.values(last.meta.outputs)[0];
    if (!first) throw new Error(`texture recipe "${id}" has no outputs`);
    textures.push(first.file);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(cache.work, recipe.id, stamp);
  const out = join(dir, `${recipe.id}.glb`);
  const r = await runBlender(script, out, recipe.params, { ...deps, extraArgs: textures.length ? ['--textures', JSON.stringify(textures)] : [] });
  const bytes = new Uint8Array(await readFile(out));
  const g = await inspectGlb(bytes);
  const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');
  const meta: BlenderMeta = {
    recipe: recipe.id,
    recipeSha256: sha(recipeText),
    blender: r.version,
    script: recipe.script,
    scriptSha256: sha(await readFile(script)),
    seconds: r.seconds,
    textures,
    outputs: { glb: { file: out, sha256: sha(bytes), bytes: bytes.length } },
    checks: { nodes: g.nodes.length, cameras: g.cameras, meshes: g.meshes },
  };
  await writeFile(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  await writeFile(join(cache.work, recipe.id, 'last.json'), `${JSON.stringify({ dir, meta }, null, 2)}\n`);
  return { dir, meta };
}
