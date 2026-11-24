// SPDX-License-Identifier: GPL-3.0-or-later
import type { Rgba } from './image';

/** Original pixels, [x, y, width, height] (recipe.ts's Rect; kept local so recipe.ts can import this module). */
type Rect = [number, number, number, number];

/**
 * The de-dither pre-step (applied to the 1x original before the 4x upscale). The originals are 256-colour pictures shaded
 * with ordered and error-diffusion dither (carpets, floors, walls); the photo-trained upscaler turns that into wavy streaks
 * and horizontal lines, and a low-denoise repaint keeps them.
 *
 * `bilateral`: an edge-preserving average whose colour range follows the local dither. Each pixel becomes the Gaussian
 * (`sigma`, original pixels) average of its neighbours, each weighted by how close its colour is to the pixel's (a biweight
 * in RGB distance: 1 at 0, 0 at the pixel's range). The range is `factor` times the local dither amplitude (clamped to
 * `minRange`..`range`), measured by `ditherScore`: a dither pixel stands out from its neighbours along both axes, where a
 * thin line or an edge stands out along one only. So on lab.s01's floor, whose dither steps are about 8 in RGB, a seam line
 * 25 darker is kept, and on the bridge's carpet, whose steps are up to 45, the blue-to-red edge (86) is kept. `passes` runs
 * it again on its own output (the range stays the original's): a 30-level checkerboard is 106/124 after one pass, 113/117
 * after two and flat after three. `none` leaves the picture as it is. Tuned on the bridge carpet and lab.s01's floor.
 */
export interface DeditherOptions {
  method: 'bilateral' | 'none';
  sigma: number;
  factor: number;
  minRange: number;
  range: number;
  passes: number;
  /**
   * Displays and lights are kept as they are: a pixel of HSV saturation >= `glowSat` at value >= 0.3, or of luminance >= `glowLum`,
   * grown by `glowGrow` px, is copied through like `keep`. A display's grid of 1 px lines is the dither's frequency, so the filter
   * alone would erase it (lab.s0d); the bridge carpet's red circle (saturation 0.38) is not a display. The bright test is off by
   * default (glowLum 2): the bridge's pale console lights are dithered too, and white labels on a dark ground are kept by the range.
   */
  glowSat: number;
  glowLum: number;
  glowGrow: number;
}

export const DEDITHER_DEFAULTS: DeditherOptions = { method: 'bilateral', sigma: 1.5, factor: 3, minRange: 12, range: 72, passes: 3, glowSat: 0.6, glowLum: 2, glowGrow: 2 };

/** The window (radius) the local dither amplitude is measured over, and how many of its strongest scores it averages. */
const AMP_RADIUS = 3;
const AMP_TOP = 6;

const dist = (d: Uint8Array, i: number, j: number, k: number): number => {
  // |2p - a - b| / 2 in RGB: how far p stands out from the two neighbours i and j (k = p)
  const r = 2 * d[k]! - d[i]! - d[j]!;
  const g = 2 * d[k + 1]! - d[i + 1]! - d[j + 1]!;
  const b = 2 * d[k + 2]! - d[i + 2]! - d[j + 2]!;
  return Math.sqrt(r * r + g * g + b * b) / 2;
};

/**
 * Per pixel, how much it looks like a dither pixel: min(horizontal, vertical second difference) less the difference of the two
 * diagonal ones. A checkerboard or a lone dot stands out both ways (and its diagonals agree); a horizontal or vertical line
 * stands out one way only; a diagonal line stands out both ways but along itself not at all, which the diagonal term cancels.
 */
export function ditherScore(img: Rgba): Float32Array {
  const { width: w, height: h, data: d } = img;
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const k = (y * w + x) * 4;
      const ax = dist(d, k - 4, k + 4, k);
      const ay = dist(d, k - w * 4, k + w * 4, k);
      const d1 = dist(d, k - w * 4 - 4, k + w * 4 + 4, k);
      const d2 = dist(d, k - w * 4 + 4, k + w * 4 - 4, k);
      out[y * w + x] = Math.max(0, Math.min(ax, ay) - Math.abs(d1 - d2));
    }
  return out;
}

/** The local dither amplitude: the mean of the AMP_TOP strongest scores in the (2 AMP_RADIUS + 1)^2 window. */
function amplitude(score: Float32Array, w: number, h: number, kept: Uint8Array): Float32Array {
  const out = new Float32Array(w * h);
  const top = new Float32Array(AMP_TOP);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      top.fill(0);
      for (let yy = Math.max(0, y - AMP_RADIUS); yy <= Math.min(h - 1, y + AMP_RADIUS); yy++)
        for (let xx = Math.max(0, x - AMP_RADIUS); xx <= Math.min(w - 1, x + AMP_RADIUS); xx++) {
          const q = yy * w + xx;
          const s = kept[q] ? 0 : score[q]!;
          if (s <= top[AMP_TOP - 1]!) continue;
          // insert s into the sorted (descending) top list
          let i = AMP_TOP - 1;
          while (i > 0 && top[i - 1]! < s) {
            top[i] = top[i - 1]!;
            i--;
          }
          top[i] = s;
        }
      let sum = 0;
      for (let i = 0; i < AMP_TOP; i++) sum += top[i]!;
      out[y * w + x] = sum / AMP_TOP;
    }
  return out;
}

/** 1 where the picture glows (a display, a light), grown by glowGrow px (a square). */
export function glowMap(img: Rgba, o: Pick<DeditherOptions, 'glowSat' | 'glowLum' | 'glowGrow'>): Uint8Array {
  const { width: w, height: h, data: d } = img;
  const seed = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const r = d[p * 4]! / 255, g = d[p * 4 + 1]! / 255, b = d[p * 4 + 2]! / 255;
    const mx = Math.max(r, g, b);
    const sat = mx === 0 ? 0 : (mx - Math.min(r, g, b)) / mx;
    if ((sat >= o.glowSat && mx >= 0.3) || 0.299 * r + 0.587 * g + 0.114 * b >= o.glowLum) seed[p] = 1;
  }
  const g = o.glowGrow;
  if (g <= 0) return seed;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!seed[y * w + x]) continue;
      for (let yy = Math.max(0, y - g); yy <= Math.min(h - 1, y + g); yy++) out.fill(1, yy * w + Math.max(0, x - g), yy * w + Math.min(w, x + g + 1));
    }
  return out;
}

/** The de-dithered picture. Pixels in `keep` (the ship's interface strip) and glowing ones are copied as they are and never feed a neighbour. */
export function dedither(img: Rgba, o: DeditherOptions, keep: Rect[] = []): Rgba {
  if (o.method === 'none' || o.passes <= 0) return { width: img.width, height: img.height, data: img.data.slice() };
  const { width: w, height: h } = img;
  const kept = new Uint8Array(w * h);
  for (const [x, y, rw, rh] of keep)
    for (let yy = Math.max(0, y); yy < Math.min(h, y + rh); yy++) kept.fill(1, yy * w + Math.max(0, x), yy * w + Math.min(w, x + rw));
  const glow = glowMap(img, o);
  for (let p = 0; p < w * h; p++) if (glow[p]) kept[p] = 1;
  const amp = amplitude(ditherScore(img), w, h, kept);
  const r = Math.max(1, Math.ceil(2 * o.sigma));
  const spatial: number[] = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) spatial.push(Math.exp(-(dx * dx + dy * dy) / (2 * o.sigma * o.sigma)));
  let src = img.data;
  for (let pass = 0; pass < o.passes; pass++) {
    const out = src.slice();
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (kept[p]) continue;
        const range = Math.min(o.range, Math.max(o.minRange, o.factor * amp[p]!));
        const range2 = range * range;
        const i = p * 4;
        const pr = src[i]!, pg = src[i + 1]!, pb = src[i + 2]!;
        let sr = 0, sg = 0, sb = 0, sw = 0, k = 0;
        for (let dy = -r; dy <= r; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) {
            k += 2 * r + 1;
            continue;
          }
          for (let dx = -r; dx <= r; dx++, k++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const q = yy * w + xx;
            if (kept[q]) continue;
            const j = q * 4;
            const er = src[j]! - pr, eg = src[j + 1]! - pg, eb = src[j + 2]! - pb;
            const d2 = er * er + eg * eg + eb * eb;
            if (d2 >= range2) continue;
            const t = 1 - d2 / range2;
            const wt = spatial[k]! * t * t;
            sr += wt * src[j]!;
            sg += wt * src[j + 1]!;
            sb += wt * src[j + 2]!;
            sw += wt;
          }
        }
        // (the pixel itself always weighs in, so sw > 0)
        out[i] = Math.round(sr / sw);
        out[i + 1] = Math.round(sg / sw);
        out[i + 2] = Math.round(sb / sw);
      }
    src = out;
  }
  return { width: w, height: h, data: src };
}
