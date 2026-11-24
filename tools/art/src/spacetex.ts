// SPDX-License-Identifier: GPL-3.0-or-later
import { alignCheck, ALIGN_DEFAULTS, type AlignReport } from './align';
import { DEDITHER_DEFAULTS } from './dedither';
import type { Generator } from './generator';
import type { Models } from './graphs';
import { decodePng, encodePng, type Gray, type Rgba } from './image';
import { maskToRgba } from './maskdenoise';
import { nearestResize } from './pixel';
import { edgePoints, EDGE_POINTS } from './points';
import type { RepaintRecipe, SpaceTexturesRecipe } from './recipe';
import { repaint, upscaleOnly } from './repaint';
import { textureWorkSize, withAlphaOf } from './spacemodel';

/** A combat texture to repaint (Plan 30 R8): its lower-case name, its original picture (alpha 0 at a keyed colour 0), the texels its models' faces cover, and the base texture whose seed a damage texture takes. */
export interface SpaceTextureInput { name: string; picture: Rgba; islands: Uint8Array; base?: string }
export interface SpaceTextureResult {
  /** 4x the original, with the original's alpha. */
  picture: Rgba;
  mode: 'repaint' | 'upscale';
  /** Why it is the upscale: `small`, `listed` (the recipe's upscaleOnly), or the alignment check's reason. */
  why?: string;
  align?: AlignReport;
  seed: number;
}

/** The seed a texture takes: its own override, its base's (a damage texture: M8 spec §7), else the recipe's. */
export function textureSeed(r: SpaceTexturesRecipe, t: Pick<SpaceTextureInput, 'name' | 'base'>): number {
  return r.seeds[t.name] ?? (t.base !== undefined ? r.seeds[t.base] : undefined) ?? r.sampling.seed;
}

/** The repaint recipe one texture runs as (`tex.space.<name>`): the shared settings at its own work size, 4x out, and its seed. */
export function textureRepaintRecipe(r: SpaceTexturesRecipe, t: SpaceTextureInput): RepaintRecipe {
  return {
    id: `tex.space.${t.name}`, kind: 'repaint', source: { space: 'console' }, keep: [], areas: {}, repaint: true, models: { ...r.models }, model: 'sdxl',
    sampling: { ...r.sampling, seed: textureSeed(r, t) }, prompt: r.prompt, negative: r.negative, denoise: r.denoise, reference: [],
    dedither: { ...DEDITHER_DEFAULTS, method: r.dedither.method, sigma: r.dedither.sigma },
    size: { work: textureWorkSize(t.picture.width, t.picture.height), out: [t.picture.width * 4, t.picture.height * 4] }, post: [],
  };
}

/** The islands as the denoise mask at the work size (1 on an island, 0 off), feathered by a box of `feather` work pixels. */
export function islandMask(islands: Uint8Array, width: number, height: number, work: [number, number], feather: number): Rgba {
  const on: Rgba = { width, height, data: new Uint8Array(width * height * 4) };
  for (let i = 0; i < islands.length; i++) on.data.set(islands[i] ? [255, 255, 255, 255] : [0, 0, 0, 255], i * 4);
  const big = nearestResize(on, work[0], work[1]);
  const g: Gray = { width: work[0], height: work[1], data: new Float32Array(work[0] * work[1]) };
  const r = Math.round(feather);
  for (let y = 0; y < work[1]; y++) {
    for (let x = 0; x < work[0]; x++) {
      let sum = 0, n = 0;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const sx = x + dx, sy = y + dy;
        if (sx < 0 || sy < 0 || sx >= work[0] || sy >= work[1]) continue;
        sum += big.data[(sy * work[0] + sx) * 4]!;
        n++;
      }
      g.data[y * work[0] + x] = sum / n / 255;
    }
  }
  return maskToRgba(g);
}

const opaque = (img: Rgba): Rgba => {
  const data = new Uint8Array(img.data);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { width: img.width, height: img.height, data };
};

/**
 * One texture (Plan 30 R8): the upscale alone for a small or listed one; else the repaint under its islands, kept when it passes the
 * 2 px check against its original at EDGE_POINTS of its own, else its upscale (M8 spec §7: a texture that fails publishes upscale-only).
 * Either way 4x, with the original's alpha.
 */
export async function makeSpaceTexture(r: SpaceTexturesRecipe, t: SpaceTextureInput, g: Generator, m: Models, stamp = 'run'): Promise<SpaceTextureResult> {
  const recipe = textureRepaintRecipe(r, t);
  const seed = recipe.sampling.seed;
  const original = encodePng(opaque(t.picture));
  const listed = r.upscaleOnly.includes(t.name);
  if (listed || Math.min(t.picture.width, t.picture.height) < r.minSide) {
    const u = await upscaleOnly(recipe, original, g, m, stamp);
    return { picture: withAlphaOf(decodePng(u.plate), t.picture, 4), mode: 'upscale', why: listed ? 'listed' : 'small', seed };
  }
  const mask = encodePng(islandMask(t.islands, t.picture.width, t.picture.height, recipe.size.work, r.islands.feather));
  const out = await repaint(recipe, original, g, m, stamp, [], mask);
  const plate = decodePng(out.plate);
  const align = alignCheck(opaque(t.picture), plate, edgePoints(opaque(t.picture), EDGE_POINTS).map(p => ({ x: p.x, y: p.y, source: `${p.label} ${p.x},${p.y}` })), { ...ALIGN_DEFAULTS, maxShift: r.align.maxShift });
  if (align.ok) return { picture: withAlphaOf(plate, t.picture, 4), mode: 'repaint', align, seed };
  return { picture: withAlphaOf(decodePng(out.upscaled), t.picture, 4), mode: 'upscale', why: align.why ?? 'misaligned', align, seed };
}
