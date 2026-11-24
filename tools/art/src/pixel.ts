// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The avatar's `pixel` post-step: the finished picture is reduced to a coarse pixel grid, quantised to a small palette (the game
 * portrait's own colours, or k-means colours of the picture itself, optionally ordered-dithered) and scaled back up with
 * nearest-neighbour so the pixels stay square-edged. Deterministic: no random numbers anywhere (k-means starts from a farthest-point
 * pick, the dither is a fixed Bayer matrix).
 */
import { z } from 'zod';
import { areaResize, type Rgba } from './image';
import { labToRgb, rgbToLab } from './portrait';

export const pixelOptions = z
  .object({
    /** The pixel grid [columns, rows] the picture is reduced to. */
    grid: z.tuple([z.number().int().min(2).max(512), z.number().int().min(2).max(512)]),
    /** `area`: the mean of each cell. `mode`: the mean of the cell's most common colour (4 bits a channel), which keeps small dark features such as eyes from washing out. */
    filter: z.enum(['area', 'mode']).default('area'),
    /** `game`: the colours of the game portrait. `{ kmeans: N }`: N colours found in the picture (Lab k-means). */
    palette: z.union([z.literal('game'), z.object({ kmeans: z.number().int().min(2).max(256) }).strict()]),
    /** `bayer`: 4x4 ordered dither before the palette lookup. */
    dither: z.enum(['none', 'bayer']).default('none'),
  })
  .strict();
export type PixelOptions = z.infer<typeof pixelOptions>;

type Lab = [number, number, number];
const dist = (a: Lab, b: Lab): number => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
/** Dither amplitude (8-bit channel values): about the step between neighbouring palette colours at 16..32 colours. */
const SPREAD = 28;

/** The grid-size picture: each cell's mean (`area`) or its most common colour's mean (`mode`). */
function reduce(img: Rgba, w: number, h: number, filter: PixelOptions['filter']): Rgba {
  if (filter === 'area') return areaResize(img, w, h);
  const out: Rgba = { width: w, height: h, data: new Uint8Array(w * h * 4) };
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * img.height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * img.width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / w));
      const bins = new Map<number, { n: number; s: [number, number, number] }>();
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * img.width + xx) * 4;
          const key = ((img.data[i]! >> 4) << 8) | ((img.data[i + 1]! >> 4) << 4) | (img.data[i + 2]! >> 4);
          const b = bins.get(key) ?? { n: 0, s: [0, 0, 0] };
          b.n++;
          for (let c = 0; c < 3; c++) b.s[c]! += img.data[i + c]!;
          bins.set(key, b);
        }
      // ties go to the lower key, so the result does not depend on iteration order
      let best: { n: number; s: [number, number, number] } | undefined;
      let bestKey = Infinity;
      for (const [k, b] of bins) if (!best || b.n > best.n || (b.n === best.n && k < bestKey)) [best, bestKey] = [b, k];
      for (let c = 0; c < 3; c++) out.data[(y * w + x) * 4 + c] = Math.round(best!.s[c]! / best!.n);
      out.data[(y * w + x) * 4 + 3] = 255;
    }
  }
  return out;
}

/** The distinct opaque colours of an image, sorted. */
export function imageColours(img: Rgba): [number, number, number][] {
  const seen = new Set<number>();
  for (let i = 0; i < img.width * img.height; i++) if (img.data[i * 4 + 3]! > 0) seen.add((img.data[i * 4]! << 16) | (img.data[i * 4 + 1]! << 8) | img.data[i * 4 + 2]!);
  return [...seen].sort((a, b) => a - b).map(v => [v >> 16, (v >> 8) & 255, v & 255]);
}

/** k colours of the image: Lloyd's algorithm in Lab from a farthest-point start (no randomness). */
export function kmeansPalette(img: Rgba, k: number, iterations = 16): [number, number, number][] {
  const px: Lab[] = [];
  for (let i = 0; i < img.width * img.height; i++) px.push(rgbToLab(img.data[i * 4]!, img.data[i * 4 + 1]!, img.data[i * 4 + 2]!));
  const mean: Lab = [0, 0, 0];
  for (const p of px) for (let c = 0; c < 3; c++) mean[c]! += p[c]! / px.length;
  let first = 0;
  for (let i = 1; i < px.length; i++) if (dist(px[i]!, mean) < dist(px[first]!, mean)) first = i;
  const cent: Lab[] = [[...px[first]!] as Lab];
  const near = px.map(p => dist(p, cent[0]!));
  while (cent.length < Math.min(k, px.length)) {
    let far = 0;
    for (let i = 1; i < px.length; i++) if (near[i]! > near[far]!) far = i;
    if (near[far]! === 0) break;
    cent.push([...px[far]!] as Lab);
    for (let i = 0; i < px.length; i++) near[i] = Math.min(near[i]!, dist(px[i]!, cent[cent.length - 1]!));
  }
  const assign = new Int32Array(px.length);
  for (let it = 0; it < iterations; it++) {
    const sum = cent.map(() => [0, 0, 0, 0]);
    px.forEach((p, i) => {
      let b = 0;
      for (let j = 1; j < cent.length; j++) if (dist(p, cent[j]!) < dist(p, cent[b]!)) b = j;
      assign[i] = b;
      const s = sum[b]!;
      s[0]! += p[0]!;
      s[1]! += p[1]!;
      s[2]! += p[2]!;
      s[3]!++;
    });
    cent.forEach((c, j) => {
      const s = sum[j]!;
      if (s[3]! > 0) for (let q = 0; q < 3; q++) c[q] = s[q]! / s[3]!;
    });
  }
  const rgb = cent.map(c => labToRgb(c[0], c[1], c[2]));
  return rgb.sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]) || a[0] - b[0] || a[1] - b[1]);
}

/** Every pixel moved to its nearest palette colour (Lab distance), after an optional Bayer offset. */
export function quantise(img: Rgba, palette: [number, number, number][], dither: PixelOptions['dither']): Rgba {
  const lab = palette.map(p => rgbToLab(p[0], p[1], p[2]));
  const out: Rgba = { width: img.width, height: img.height, data: new Uint8Array(img.data.length) };
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      const off = dither === 'bayer' ? ((BAYER4[(y & 3) * 4 + (x & 3)]! + 0.5) / 16 - 0.5) * SPREAD : 0;
      const q = rgbToLab(clamp(img.data[i]! + off), clamp(img.data[i + 1]! + off), clamp(img.data[i + 2]! + off));
      let b = 0;
      for (let j = 1; j < lab.length; j++) if (dist(q, lab[j]!) < dist(q, lab[b]!)) b = j;
      out.data.set([...palette[b]!, 255], i);
    }
  return out;
}
const clamp = (v: number): number => Math.max(0, Math.min(255, v));

/** The picture at the pixel grid's size, on the chosen palette: one array element per game pixel. */
export function pixelGrid(img: Rgba, game: Rgba, o: PixelOptions): Rgba {
  const small = reduce(img, o.grid[0], o.grid[1], o.filter);
  const palette = o.palette === 'game' ? imageColours(game) : kmeansPalette(small, o.palette.kmeans);
  return quantise(small, palette, o.dither);
}

/** Nearest-neighbour scaling: each output pixel copies the source pixel it falls in. */
export function nearestResize(img: Rgba, width: number, height: number): Rgba {
  const out: Rgba = { width, height, data: new Uint8Array(width * height * 4) };
  for (let y = 0; y < height; y++) {
    const sy = Math.min(img.height - 1, Math.floor((y * img.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x * img.width) / width));
      out.data.set(img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (y * width + x) * 4);
    }
  }
  return out;
}

/** The whole step: grid, palette, then a nearest-neighbour upscale to `out` (width, height). */
export function pixelate(img: Rgba, game: Rgba, o: PixelOptions, out: [number, number]): Rgba {
  return nearestResize(pixelGrid(img, game, o), out[0], out[1]);
}
