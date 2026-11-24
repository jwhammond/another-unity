// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BLENDER_SCRIPTS, runBlender } from './blender';
import type { ArtCache } from './cache';
import type { SpawnLike } from './comfy';
import { areaResize, decodePng, encodePng, type Rgba } from './image';
import type { MaterialRecipe } from './recipe';
import { normalFromHeight, SEAM_LIMIT, seamRatio, seamRatioCoarse, tile3x3 } from './texture';
import { makeTileable } from './tileable';

const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

export interface MaterialMaps {
  albedo: Rgba;
  roughness: Rgba;
  height: Rgba;
  /** Tangent-space, from the height. */
  normal: Rgba;
  /** glTF's metallic-roughness texture: G is roughness, B is metal (none), R is left at 1. */
  mr: Rgba;
  seam: { before: number; after: number; coarse: number };
}

/** R5: makes each baked map tile, derives the normal from the height and packs roughness for glTF. */
export function finishMaterial(raw: { albedo: Rgba; roughness: Rgba; height: Rgba }, recipe: Pick<MaterialRecipe, 'band' | 'normalStrength'>): MaterialMaps {
  const albedo = makeTileable(raw.albedo, recipe.band);
  const roughness = makeTileable(raw.roughness, recipe.band);
  const height = makeTileable(raw.height, recipe.band);
  const mr = new Uint8Array(roughness.data.length);
  for (let i = 0; i < roughness.data.length; i += 4) mr.set([255, roughness.data[i + 1]!, 0, 255], i);
  return {
    albedo,
    roughness,
    height,
    normal: normalFromHeight(height, recipe.normalStrength),
    mr: { width: roughness.width, height: roughness.height, data: mr },
    seam: { before: seamRatio(raw.albedo), after: seamRatio(albedo), coarse: seamRatioCoarse(albedo) },
  };
}

export interface MaterialMeta {
  recipe: string;
  recipeSha256: string;
  blender: string;
  script: string;
  scriptSha256: string;
  seconds: number;
  outputs: Record<string, { file: string; sha256: string; width: number; height: number }>;
  checks: { seam: { before: number; after: number; coarse: number; limit: number } };
}

/**
 * Bakes a material (Cycles on the CPU, in Blender), makes it tile and writes <work>/<id>/<stamp>/{albedo, roughness, height,
 * normal, mr, preview}.png, meta.json and last.json. A visible seam keeps the files but throws.
 */
export async function runMaterialRecipe(
  recipe: MaterialRecipe,
  recipeText: string,
  cache: ArtCache,
  deps: { spawnFn?: SpawnLike; env?: NodeJS.ProcessEnv; log?: (line: string) => void; scriptsDir?: string } = {},
): Promise<{ dir: string; meta: MaterialMeta }> {
  const script = resolve(deps.scriptsDir ?? BLENDER_SCRIPTS, recipe.script);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(cache.work, recipe.id, stamp);
  await mkdir(dir, { recursive: true });
  const base = join(dir, 'raw');
  const r = await runBlender(script, `${base}.glb`, { seed: recipe.seed, size: recipe.size, samples: recipe.samples, ...recipe.params }, deps);
  const read = async (name: string): Promise<Rgba> => decodePng(new Uint8Array(await readFile(`${base}.${name}.png`)));
  const maps = finishMaterial({ albedo: await read('albedo'), roughness: await read('rough'), height: await read('height') }, recipe);
  const preview = areaResize(tile3x3(maps.albedo), maps.albedo.width * 1.5, maps.albedo.height * 1.5);
  const outputs: MaterialMeta['outputs'] = {};
  for (const [name, img] of Object.entries({ albedo: maps.albedo, roughness: maps.roughness, height: maps.height, normal: maps.normal, mr: maps.mr, preview })) {
    const bytes = encodePng(img);
    const file = join(dir, `${name}.png`);
    await writeFile(file, bytes);
    outputs[name] = { file, sha256: sha(bytes), width: img.width, height: img.height };
  }
  const meta: MaterialMeta = {
    recipe: recipe.id,
    recipeSha256: sha(recipeText),
    blender: r.version,
    script: recipe.script,
    scriptSha256: sha(await readFile(script)),
    seconds: r.seconds,
    outputs,
    checks: { seam: { ...maps.seam, limit: SEAM_LIMIT } },
  };
  await writeFile(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  if (maps.seam.after > SEAM_LIMIT || maps.seam.coarse > SEAM_LIMIT) {
    throw new Error(`${recipe.id}: the wrap is still visible after the crossfade (seamRatio ${maps.seam.after.toFixed(2)}, coarse ${maps.seam.coarse.toFixed(2)}, limit ${SEAM_LIMIT}); see ${dir}`);
  }
  await writeFile(join(cache.work, recipe.id, 'last.json'), `${JSON.stringify({ dir, meta }, null, 2)}\n`);
  return { dir, meta };
}
