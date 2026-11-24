// SPDX-License-Identifier: GPL-3.0-or-later
import { ALIGN_DEFAULTS, edgeMap, measureShift, selfCorrelation, type AlignOptions } from './align';
import { areaResize, type Rgba } from './image';

export interface CardChecks {
  flickerRatio: number;
  flickerMax: number;
  deltaE: number;
  /**
   * Opt-in, for a costume with a glittering patch (a sash of speckle): a window whose edges correlate with themselves moved 1 px
   * by less than this, both ways, is speckle. Any repaint draws other speckle, so no shift can be measured there, and the next
   * strongest windows are judged instead. A frame whose strongest windows are over half speckle fails. Unset: every window counts.
   */
  speckle?: number;
}
export const CARD_CHECK_DEFAULTS: CardChecks = { flickerRatio: 2.5, flickerMax: 12, deltaE: 12 };

/** R7's alignment: a 15x15 window, +-3 px, at the original's own resolution. A frame's median shift may be 1.0 px; no point may pass 2.0. */
export const CARD_ALIGN: AlignOptions = { ...ALIGN_DEFAULTS, radius: 7, search: 3, maxShift: 2 };
export const MEDIAN_SHIFT = 1.0;
/** At most this many windows per frame, the strongest edges inside the figure, no two closer than a window. */
const POINTS = 12;
/** An F below this is noise, however much it exceeds a (near zero) median. */
const FLICKER_FLOOR = 2;

/** A frame whose strongest windows are over this share speckle is not judged by the rest: that fails. */
const MAX_SPECKLE_SHARE = 0.5;
/** A frame's alignment needs this many measured windows, or this share of its candidates (M2). */
const MIN_MEASURED = 3;
const MIN_MEASURED_SHARE = 0.25;

const OPAQUE = 128;
/** The sub-pixel estimate is good to about 0.05-0.1 px: a point at 2.06 is at the limit, not beyond it. */
const SHIFT_TOLERANCE = 0.1;

/** The animation's frames over one neutral ground, so the silhouette's edge is the same in both and only the inside is judged. */
function onGround(img: Rgba): Rgba {
  const out = new Uint8Array(img.data.length);
  for (let i = 0; i < img.width * img.height; i++) {
    const a = img.data[i * 4 + 3]! / 255;
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(img.data[i * 4 + c]! * a + 128 * (1 - a));
    out[i * 4 + 3] = 255;
  }
  return { width: img.width, height: img.height, data: out };
}

const median = (v: number[]): number => {
  const t = [...v].sort((a, b) => a - b);
  return t.length === 0 ? 0 : t.length % 2 ? t[(t.length - 1) / 2]! : (t[t.length / 2 - 1]! + t[t.length / 2]!) / 2;
};

/** Windows centred inside the figure where the original has the most edge (greedy, no two within a window's width). */
function figurePoints(edges: { width: number; height: number; data: Float32Array }, alpha: Rgba, n: number, radius: number, speckle?: number): { points: { x: number; y: number; source: string }[]; speckle: number } {
  const { width: w, height: h } = edges;
  const cand: { x: number; y: number; s: number }[] = [];
  for (let y = radius; y < h - radius; y += 2) {
    for (let x = radius; x < w - radius; x += 2) {
      if (alpha.data[(y * w + x) * 4 + 3]! < 255) continue;
      let s = 0;
      for (let yy = -radius; yy <= radius; yy += 1) for (let xx = -radius; xx <= radius; xx += 1) s += edges.data[(y + yy) * w + x + xx]!;
      cand.push({ x, y, s });
    }
  }
  cand.sort((a, b) => b.s - a.s || a.y - b.y || a.x - b.x);
  const out: { x: number; y: number; source: string }[] = [];
  const skipped: { x: number; y: number }[] = [];
  const near = (p: { x: number; y: number }, c: { x: number; y: number }): boolean => Math.abs(p.x - c.x) < radius * 2 && Math.abs(p.y - c.y) < radius * 2;
  for (const c of cand) {
    if (out.length >= n) break;
    if (out.some(p => near(p, c)) || skipped.some(p => near(p, c))) continue;
    if (speckle !== undefined && Math.max(selfCorrelation(edges, c.x, c.y, 1, 0, radius), selfCorrelation(edges, c.x, c.y, 0, 1, radius)) < speckle) {
      skipped.push(c);
      continue;
    }
    out.push({ x: c.x, y: c.y, source: 'figure' });
  }
  return { points: out, speckle: skipped.length };
}

const lab = (r: number, g: number, b: number): [number, number, number] => {
  const lin = (v: number): number => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
};

/** The mean Lab colour of the opaque pixels between 35% and 65% of the frame's opaque height (the costume), or null if there are none. */
export function costumeLab(img: Rgba, reference: Rgba = img): [number, number, number] | null {
  let top = img.height;
  let bottom = -1;
  for (let y = 0; y < reference.height; y++) {
    for (let x = 0; x < reference.width; x++) {
      if (reference.data[(y * reference.width + x) * 4 + 3]! >= OPAQUE) {
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  }
  if (bottom < 0) return null;
  const y0 = Math.floor(top + (bottom - top + 1) * 0.35);
  const y1 = Math.ceil(top + (bottom - top + 1) * 0.65);
  let n = 0;
  const acc: [number, number, number] = [0, 0, 0];
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < img.width; x++) {
      const o = (y * img.width + x) * 4;
      if (reference.data[o + 3]! < OPAQUE) continue;
      const l = lab(img.data[o]!, img.data[o + 1]!, img.data[o + 2]!);
      acc[0] += l[0];
      acc[1] += l[1];
      acc[2] += l[2];
      n++;
    }
  }
  return n ? [acc[0] / n, acc[1] / n, acc[2] / n] : null;
}

/**
 * F for two frames: mean |(rep_b - rep_a) - (up_b - up_a)| over the pixels opaque in both, in levels of 255. `shift` is where frame b's
 * cell lies on a's (its top-left, in pixels of a's cell), for cells of other sizes; pixels outside either cell are left out.
 */
function flickerBetween(ua: Rgba, ub: Rgba, ra: Rgba, rb: Rgba, shift: [number, number]): number {
  let sum = 0;
  let count = 0;
  for (let y = 0; y < ua.height; y++) {
    const by = y - shift[1];
    if (by < 0 || by >= ub.height) continue;
    for (let x = 0; x < ua.width; x++) {
      const bx = x - shift[0];
      if (bx < 0 || bx >= ub.width) continue;
      const o = (y * ua.width + x) * 4;
      const q = (by * ub.width + bx) * 4;
      if (ua.data[o + 3]! < OPAQUE || ub.data[q + 3]! < OPAQUE) continue;
      for (let k = 0; k < 3; k++) sum += Math.abs(rb.data[q + k]! - ra.data[o + k]! - (ub.data[q + k]! - ua.data[o + k]!));
      count += 3;
    }
  }
  return count ? Math.round((sum / count) * 100) / 100 : 0;
}

/** A frame of one animation as the switch between animations sees it: its upscaled and repainted cells, and the sprite's origin in fractions of the cell. */
export interface Placed {
  up: Rgba;
  rep: Rgba;
  anchor: [number, number];
  /** The flicker median of the animation the frame is of; null for an animation of one frame, which has no flicker of its own. Only a sibling's is known. */
  median?: number | null;
}

/** F between the frame an animation ends on (or a still stands on) and the frame another begins with: the two cells put on the sprite's origin. */
export function transitionFlicker(from: Placed, to: Placed): number {
  const shift: [number, number] = [Math.round(from.anchor[0] * from.up.width - to.anchor[0] * to.up.width), Math.round(from.anchor[1] * from.up.height - to.anchor[1] * to.up.height)];
  return flickerBetween(from.up, to.up, from.rep, to.rep, shift);
}

/**
 * The rules frames within an animation keep, for the switch from one animation to another (a door's still to its opening): no more than the
 * recipe's flickerMax, and no more than flickerRatio times `median`, the animations' own, above the floor (null: neither animation has more than a frame, so
 * there is no flicker of their own to compare with, and only flickerMax applies). null when it keeps them.
 */
export function checkTransition(from: Placed, to: Placed, median: number | null, c: CardChecks = CARD_CHECK_DEFAULTS): string | null {
  const f = transitionFlicker(from, to);
  if (f > c.flickerMax) return `flicker ${f.toFixed(1)}/255 across the switch (limit ${c.flickerMax})`;
  if (median !== null && f > FLICKER_FLOOR && f > c.flickerRatio * median) return `flicker ${f.toFixed(1)}/255 across the switch against a median ${median!.toFixed(1)} (limit ${c.flickerRatio}x)`;
  return null;
}

export interface AnimCheck {
  ok: boolean;
  /** Per frame: the median |shift| of its measured windows, in original pixels (1x). */
  alignment: number[];
  /** Per consecutive pair: F, in levels of 255. */
  flicker: number[];
  /** Per frame: the costume colour's distance from the original's (CIE76). */
  deltaE: number[];
  /** The numbers the flicker rule used. */
  flickerMedian: number;
  /** The largest shift of any measured window, over the animation. */
  worstShift: number;
  why?: string;
}

/**
 * R7 for one animation. `original` are the sprite's own frames in the animation's cells at 1x, `upscaled` and `repainted`
 * the same cells at card scale (4x). Shape: the alpha is the upscaled original's, exactly. Alignment: edge windows inside the
 * figure, repainted (at 1x) against the original. Flicker: F = mean |(rep_b - rep_a) - (up_b - up_a)| over pixels opaque in both.
 * Identity: the costume's Lab colour within deltaE of the original's.
 */
export function checkAnim(original: Rgba[], upscaled: Rgba[], repainted: Rgba[], c: CardChecks = CARD_CHECK_DEFAULTS, opts: { skipAlign?: boolean } = {}): AnimCheck {
  const n = repainted.length;
  if (original.length !== n || upscaled.length !== n) throw new Error('checkAnim: the three sets differ in length');
  const fail: string[] = [];
  // shape
  for (let i = 0; i < n; i++) {
    const a = upscaled[i]!;
    const b = repainted[i]!;
    if (a.width !== b.width || a.height !== b.height) throw new Error(`checkAnim: frame ${i} changed size`);
    for (let p = 3; p < a.data.length; p += 4) {
      if (a.data[p] !== b.data[p]) {
        fail.push(`frame ${i}'s alpha differs from the original's`);
        break;
      }
    }
  }
  // alignment, at 1x
  const alignment: number[] = [];
  let worstShift = 0;
  for (let i = 0; i < (opts.skipAlign ? 0 : n); i++) {
    const o = original[i]!;
    const r = repainted[i]!;
    const small = r.width === o.width ? r : areaResize(r, o.width, o.height);
    const flat: Rgba = { width: o.width, height: o.height, data: new Uint8Array(o.data) };
    // the original's alpha is the sprite's: opaque or not (no shadow), so the silhouette matches the repaint's forced one
    const a = edgeMap(onGround(o), 1);
    const b = edgeMap(onGround({ ...small, data: new Uint8Array(small.data).map((v, k) => (k % 4 === 3 ? flat.data[k]! : v)) }), 1);
    const { points: pts, speckle } = figurePoints(a, o, POINTS, CARD_ALIGN.radius, c.speckle);
    if (speckle / Math.max(1, speckle + pts.length) > MAX_SPECKLE_SHARE) fail.push(`frame ${i}: ${speckle} of its ${speckle + pts.length} strongest windows are speckle that can't be measured`);
    const shifts: number[] = [];
    for (const p of pts) {
      const m = measureShift(a, b, p, CARD_ALIGN);
      if (m.verdict === 'flat') continue;
      const d = m.verdict === 'fail' ? Math.max(Math.hypot(m.dx, m.dy), CARD_ALIGN.maxShift + 0.01) : Math.hypot(m.dx, m.dy);
      shifts.push(d);
    }
    // (a frame whose windows are all flat, a dark back view say, would pass with a median of nothing: too few measured is a failure)
    if (shifts.length < MIN_MEASURED && shifts.length < pts.length * MIN_MEASURED_SHARE) fail.push(`frame ${i}: only ${shifts.length} of its ${pts.length} windows could be measured`);
    worstShift = Math.max(worstShift, ...shifts, 0);
    alignment.push(Math.round(median(shifts) * 100) / 100);
    if (median(shifts) > MEDIAN_SHIFT) fail.push(`frame ${i}: median shift ${median(shifts).toFixed(2)} px (limit ${MEDIAN_SHIFT})`);
    else if (shifts.some(s => s > CARD_ALIGN.maxShift + SHIFT_TOLERANCE)) fail.push(`frame ${i}: a point moved ${Math.max(...shifts).toFixed(2)} px (limit ${CARD_ALIGN.maxShift})`);
  }
  // flicker
  const flicker: number[] = [];
  for (let i = 0; i + 1 < n; i++) flicker.push(flickerBetween(upscaled[i]!, upscaled[i + 1]!, repainted[i]!, repainted[i + 1]!, [0, 0]));
  const flickerMedian = median(flicker);
  if (flickerMedian > c.flickerMax) fail.push(`median flicker ${flickerMedian.toFixed(1)}/255 (limit ${c.flickerMax})`);
  flicker.forEach((f, i) => {
    if (f > FLICKER_FLOOR && f > c.flickerRatio * flickerMedian) fail.push(`frames ${i}-${i + 1} flicker ${f.toFixed(1)} against a median ${flickerMedian.toFixed(1)} (limit ${c.flickerRatio}x)`);
  });
  // identity
  const deltaE: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = costumeLab(upscaled[i]!);
    const b = costumeLab(repainted[i]!, upscaled[i]!);
    const d = a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : 0;
    deltaE.push(Math.round(d * 10) / 10);
    if (d > c.deltaE) fail.push(`frame ${i}: the costume colour moved ΔE ${d.toFixed(1)} (limit ${c.deltaE})`);
  }
  return { ok: fail.length === 0, alignment, flicker, deltaE, flickerMedian, worstShift, ...(fail.length ? { why: fail.slice(0, 4).join('; ') } : {}) };
}
