// SPDX-License-Identifier: GPL-3.0-or-later
import type { z } from 'zod';
import type { Generator } from './generator';
import { inpaintGraph, txt2imgGraph, type Models } from './graphs';
import { areaResize, decodePng, encodePng, luminance, roll, type Rgba } from './image';
import type { textureRecipe } from './recipe';

export type TextureRecipe = z.infer<typeof textureRecipe>;
/** R12's pass mark: the wrap's step may be at most 1.5x the steps inside. */
export const SEAM_LIMIT = 1.5;
/**
 * seamRatio only sees steps between neighbouring pixels, so on a fine grid a visible jump in overall brightness at the
 * wrap (a lit patch against a dark one) hides in the grid's own contrast. The same ratio on a COARSE x COARSE
 * area-downscale measures that.
 */
export const COARSE = 16;
export const seamRatioCoarse = (img: Rgba): number => seamRatio(areaResize(img, COARSE, COARSE));

const IN = 'art-tex.png';
const MASK = 'art-tex-mask.png';

/** A white cross of `band` px over the centre lines, feathered by band/4: where the rolled image's seams are. */
export function seamMask(size: number, band: number): Rgba {
  const data = new Uint8Array(size * size * 4);
  const half = band / 2;
  const feather = Math.max(band / 4, 1e-6);
  const c = size / 2;
  // Distance of a pixel centre from the centre line (at c): full inside band/2 - feather, falling to 0 over `feather`.
  const line = (p: number): number => {
    const d = Math.abs(p + 0.5 - c);
    return Math.min(1, Math.max(0, (half - d) / feather));
  };
  for (let y = 0; y < size; y++) {
    const ly = line(y);
    for (let x = 0; x < size; x++) {
      const v = Math.round(255 * Math.max(line(x), ly));
      data.set([v, v, v, 255], (y * size + x) * 4);
    }
  }
  return { width: size, height: size, data };
}

/**
 * How visible the wrap is: the mean absolute luminance step across the wrap edges (last column to first, last row to
 * first) over the mean step between neighbours inside. Near 1 looks seamless; R12 passes at <= 1.5.
 */
export function seamRatio(img: Rgba): number {
  const { width: w, height: h } = img;
  const l = luminance(img).data;
  let inside = 0;
  let nIn = 0;
  let wrap = 0;
  let nWrap = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = l[y * w + x]!;
      const right = l[y * w + ((x + 1) % w)]!;
      const down = l[((y + 1) % h) * w + x]!;
      const horizontalWrap = x === w - 1;
      const verticalWrap = y === h - 1;
      (horizontalWrap ? (wrap += Math.abs(v - right), nWrap++) : (inside += Math.abs(v - right), nIn++));
      (verticalWrap ? (wrap += Math.abs(v - down), nWrap++) : (inside += Math.abs(v - down), nIn++));
    }
  }
  const a = wrap / nWrap;
  const b = inside / nIn;
  return a < 1e-9 && b < 1e-9 ? 1 : a / Math.max(b, 1e-9);
}

/**
 * A tangent-space normal map from luminance as height, sampled with wrap-around so it tiles too. OpenGL convention
 * (+Y up, as three.js reads it): a height rising to the right tilts the normal left, one rising downward tilts it up.
 */
export function normalFromHeight(img: Rgba, strength: number): Rgba {
  const { width: w, height: h } = img;
  const l = luminance(img).data;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const yu = ((y - 1 + h) % h) * w;
    const yd = ((y + 1) % h) * w;
    for (let x = 0; x < w; x++) {
      const dx = (l[y * w + ((x + 1) % w)]! - l[y * w + ((x - 1 + w) % w)]!) / 2;
      const dy = (l[yd + x]! - l[yu + x]!) / 2;
      const nx = -dx * strength;
      const ny = dy * strength;
      const inv = 1 / Math.hypot(nx, ny, 1);
      out.set([Math.round((nx * inv * 0.5 + 0.5) * 255), Math.round((ny * inv * 0.5 + 0.5) * 255), Math.round((inv * 0.5 + 0.5) * 255), 255], (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data: out };
}

export function tile3x3(img: Rgba): Rgba {
  const { width: w, height: h } = img;
  const W = w * 3;
  const out = new Uint8Array(W * h * 3 * 4);
  for (let y = 0; y < h * 3; y++) {
    for (let tx = 0; tx < 3; tx++) {
      const s = (y % h) * w * 4;
      out.set(img.data.subarray(s, s + w * 4), (y * W + tx * w) * 4);
    }
  }
  return { width: W, height: h * 3, data: out };
}

export interface TextureResult {
  albedo: Uint8Array;
  normal: Uint8Array;
  preview: Uint8Array;
  seamBefore: number;
  seamAfter: number;
  /** seamRatio of the COARSE x COARSE downscale. */
  seamCoarse: number;
}
/** The textures are kept when a seam is still visible, for a look: the error carries them. */
export class SeamError extends Error {
  constructor(
    readonly result: TextureResult,
    message: string,
  ) {
    super(message);
  }
}

/** txt2img, roll by half, inpaint the seam cross, roll back. Fails if `seamAfter` is over SEAM_LIMIT. */
export async function makeTexture(r: TextureRecipe, g: Generator, m: Models): Promise<TextureResult> {
  const raw = (await g.run({ ...txt2imgGraph(m, r.sampling, r.prompt, r.negative, [r.size, r.size]), inputs: {} })).image!;
  const first = decodePng(raw);
  const seamBefore = seamRatio(first);
  const half = r.size / 2;
  const rolled = encodePng(roll(first, half, half));
  const mask = encodePng(seamMask(r.size, r.seam.band));
  const job = inpaintGraph(m, r.sampling, { prompt: r.prompt, negative: r.negative, denoise: r.seam.denoise, growMask: 0 }, IN, MASK);
  const painted = (await g.run({ ...job, inputs: { [IN]: rolled, [MASK]: mask } })).image!;
  const albedoImg = roll(decodePng(painted), half, half);
  const strength = r.post.flatMap(p => ('normal' in p ? [p.normal.strength] : []))[0] ?? 2;
  const result: TextureResult = {
    albedo: encodePng(albedoImg),
    normal: encodePng(normalFromHeight(albedoImg, strength)),
    preview: encodePng(tile3x3(albedoImg)),
    seamBefore,
    seamAfter: seamRatio(albedoImg),
    seamCoarse: seamRatioCoarse(albedoImg),
  };
  if (result.seamAfter > SEAM_LIMIT || result.seamCoarse > SEAM_LIMIT) {
    throw new SeamError(result, `${r.id}: the seam is still visible (ratio ${result.seamAfter.toFixed(2)} after, ${result.seamCoarse.toFixed(2)} coarse, ${seamBefore.toFixed(2)} before; limit ${SEAM_LIMIT})`);
  }
  return result;
}
