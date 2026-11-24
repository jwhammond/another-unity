// SPDX-License-Identifier: GPL-3.0-or-later
import { areaResize, luminance, type Gray, type Rgba } from './image';
import { edgePoints, EDGE_POINTS, type CheckPoint } from './points';

/** R7: a window of 2*radius+1 pixels, integer shifts within +-search, then a parabola per axis for the sub-pixel part. */
export interface AlignOptions {
  radius: number;
  search: number;
  maxShift: number;
  minPeak: number;
  minEnergy: number;
  minMeasured: number;
  /** Fewest points that must measure each axis: max(this, minAxisShare of the judged points). */
  minAxis: number;
  minAxisShare: number;
  /** Points that structure exists at but can't be judged (repeating texture, diagonal edge, border-cut corner) must stay under this share of all points. */
  maxUnjudgeable: number;
  /** The median |shift| over the points that measure an axis may not exceed this (a global drift, px). */
  maxDrift: number;
  /**
   * A point that fails at the fine scale only for a low match peak is measured again on a smoother edge map with a wider
   * window: dithered or grainy originals bury their structure under noise at sigma 1.5, and the plate is no worse for it.
   * Only a confident peak (minPeak, as at the fine scale) within maxShift passes there. 0 turns it off.
   */
  coarseRadius: number;
  coarseSigma: number;
  /**
   * A point whose structure is there but whose match stays unconfident at both scales, with every shift it shows within
   * maxShift, is unmeasurable (it never passes; the plate there is neither shown right nor shown wrong). Such points must
   * stay under this share of all points, so a plate that lost its structure everywhere is still refused.
   */
  maxLowConfidence: number;
  /**
   * When too few of the hotspot and floor points can be measured (they lie in black or smooth paint, as in dark rooms),
   * the original's strongest-edge windows are added, and this many points in all must then measure: alignment is shown on
   * the structure that exists, and every point that does measure still has to line up within maxShift. 0 turns the
   * supplement off (a room with too little to measure then fails).
   */
  minEdgeCoverage: number;
}
export const ALIGN_DEFAULTS: AlignOptions = { radius: 12, search: 4, maxShift: 2, minPeak: 0.5, minEnergy: 0.02, minMeasured: 0.6, minAxis: 3, minAxisShare: 0.25, maxUnjudgeable: 0.4, maxDrift: 1, coarseRadius: 20, coarseSigma: 3, maxLowConfidence: 0.1, minEdgeCoverage: 6 };

/** The sub-pixel estimate is good to about 0.01-0.02 px: a shift of exactly maxShift must not fail on that. */
const SHIFT_RESOLUTION = 0.05;
/** The same for the median drift: a plate moved exactly maxDrift measures that to within the noise of many points. */
const DRIFT_RESOLUTION = 0.15;

function gaussian(g: Gray, sigma: number): Gray {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i]! /= sum;
  const { width: w, height: h } = g;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) a += g.data[y * w + Math.min(w - 1, Math.max(0, x + i))]! * k[i + r]!;
      tmp[y * w + x] = a;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) a += tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x]! * k[i + r]!;
      out[y * w + x] = a;
    }
  }
  return { width: w, height: h, data: out };
}

/** Luminance, Gaussian blur, Sobel magnitude, normalised so that the image's strongest edge is 1 (a flat image stays 0). */
export function edgeMap(img: Rgba, sigma = 1.5): Gray {
  const g = gaussian(luminance(img), sigma);
  const { width: w, height: h } = g;
  const at = (x: number, y: number): number => g.data[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))]!;
  const out = new Float32Array(w * h);
  let max = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
      const gy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
      const m = Math.hypot(gx, gy);
      out[y * w + x] = m;
      if (m > max) max = m;
    }
  }
  if (max > 0) for (let i = 0; i < out.length; i++) out[i]! /= max;
  return { width: w, height: h, data: out };
}

/** What a point is measured on: the edge maps of the original and the plate at the fine scale, and at the coarse one (made when the first point needs it). */
export interface EdgeMaps {
  a: Gray;
  b: Gray;
  coarse: () => { a: Gray; b: Gray };
}

export interface PointResult extends CheckPoint {
  verdict: 'pass' | 'fail' | 'flat';
  dx: number;
  dy: number;
  peak: number;
  /** The axis this point can't measure (a straight edge); its shift there is reported as 0. */
  blind?: 'x' | 'y';
  /** A flat verdict that is not for lack of structure: repeating texture, a diagonal edge or a border-cut corner (the ledger's 40% guard counts these). */
  unjudgeable?: true;
  /** Set when the coarse scale decided the point (see AlignOptions.coarseRadius). */
  scale?: 'coarse';
  /** A flat verdict for a point that has structure but no confident match at either scale (see AlignOptions.maxLowConfidence). */
  lowConfidence?: true;
}

/** A window whose self-correlation at a 2 px shift is this high is blind along that axis. */
const BLIND = 0.97;
/** A best shift beyond the limit that an in-range shift matches within this score is ambiguous (periodic texture). */
const AMBIGUOUS = 0.04;

/** The normalised cross-correlation of `a`'s window with itself moved by (dx, dy), over the pixels inside the image. */
export function selfCorrelation(a: Gray, px: number, py: number, dx: number, dy: number, r: number): number {
  let n = 0;
  let sA = 0;
  let sA2 = 0;
  let sB = 0;
  let sB2 = 0;
  let sAB = 0;
  for (let y = -r; y <= r; y++) {
    for (let x = -r; x <= r; x++) {
      const x1 = px + x;
      const y1 = py + y;
      const x2 = x1 + dx;
      const y2 = y1 + dy;
      if (x1 < 0 || y1 < 0 || x1 >= a.width || y1 >= a.height || x2 < 0 || y2 < 0 || x2 >= a.width || y2 >= a.height) continue;
      const va = a.data[y1 * a.width + x1]!;
      const vb = a.data[y2 * a.width + x2]!;
      n++; sA += va; sA2 += va * va; sB += vb; sB2 += vb * vb; sAB += va * vb;
    }
  }
  if (n < (2 * r + 1) ** 2 / 4) return 0;
  const sdA = Math.sqrt(Math.max(0, sA2 / n - (sA / n) ** 2));
  const sdB = Math.sqrt(Math.max(0, sB2 / n - (sB / n) ** 2));
  return sdA === 0 || sdB === 0 ? 0 : (sAB / n - (sA / n) * (sB / n)) / (sdA * sdB);
}

/**
 * Where `b`'s structure around the point sits relative to `a`'s: the best normalised cross-correlation over the shifts.
 * Only pixels that exist in both images count: a window over the image's border is cut short, not padded with a repeat
 * of the last row or column (a repeat is the same along that axis, so it hides the shift there).
 */
export function measureShift(a: Gray, b: Gray, p: CheckPoint, o: AlignOptions = ALIGN_DEFAULTS): PointResult {
  const { radius: r, search: s } = o;
  const px = Math.round(p.x);
  const py = Math.round(p.y);
  const inside = (g: Gray, x: number, y: number): boolean => x >= 0 && y >= 0 && x < g.width && y < g.height;
  // the original's window (the part inside the image): too little edge energy can't be measured
  let n0 = 0;
  let s0 = 0;
  let s02 = 0;
  for (let y = -r; y <= r; y++) {
    for (let x = -r; x <= r; x++) {
      if (!inside(a, px + x, py + y)) continue;
      const v = a.data[(py + y) * a.width + px + x]!;
      n0++; s0 += v; s02 += v * v;
    }
  }
  const sd0 = n0 ? Math.sqrt(Math.max(0, s02 / n0 - (s0 / n0) ** 2)) : 0;
  // a window cut by the image's corner to less than half measures the border, not structure: the plate's last pixels are the VAE's and the upscaler's padding
  if (n0 < (2 * r + 1) ** 2 / 2) return { ...p, verdict: 'flat', dx: 0, dy: 0, peak: 0, unjudgeable: true };
  if (sd0 < o.minEnergy) return { ...p, verdict: 'flat', dx: 0, dy: 0, peak: 0 };
  // a window that looks the same moved 2 px along an axis (a straight horizontal or vertical edge) can't tell that axis's shift
  const blindX = selfCorrelation(a, px, py, 2, 0, r) >= BLIND;
  const blindY = selfCorrelation(a, px, py, 0, 2, r) >= BLIND;
  if (blindX && blindY) return { ...p, verdict: 'flat', dx: 0, dy: 0, peak: 0 };
  // the same for a straight diagonal edge: the shift along it can't be seen, and the best shift is then an arbitrary point along it
  // (a near-identity plate fails there); count it as unmeasurable, as a window with no structure is
  if (selfCorrelation(a, px, py, 2, 2, r) >= BLIND || selfCorrelation(a, px, py, 2, -2, r) >= BLIND) return { ...p, verdict: 'flat', dx: 0, dy: 0, peak: 0, unjudgeable: true };
  const side = 2 * s + 1;
  const scores = new Float64Array(side * side).fill(-2);
  let best = (s * side) + s;
  for (let dy = -s; dy <= s; dy++) {
    if (blindY && dy !== 0) continue;
    for (let dx = -s; dx <= s; dx++) {
      if (blindX && dx !== 0) continue;
      let n = 0;
      let sumA = 0;
      let sumA2 = 0;
      let sumB = 0;
      let sumB2 = 0;
      let sumAB = 0;
      for (let y = -r; y <= r; y++) {
        for (let x = -r; x <= r; x++) {
          if (!inside(a, px + x, py + y) || !inside(b, px + x + dx, py + y + dy)) continue;
          const va = a.data[(py + y) * a.width + px + x]!;
          const vb = b.data[(py + y + dy) * b.width + px + x + dx]!;
          n++; sumA += va; sumA2 += va * va; sumB += vb; sumB2 += vb * vb; sumAB += va * vb;
        }
      }
      let ncc = 0;
      if (n >= (2 * r + 1) ** 2 / 4) {
        const sdA = Math.sqrt(Math.max(0, sumA2 / n - (sumA / n) ** 2));
        const sdB = Math.sqrt(Math.max(0, sumB2 / n - (sumB / n) ** 2));
        ncc = sdA === 0 || sdB === 0 ? 0 : (sumAB / n - (sumA / n) * (sumB / n)) / (sdA * sdB);
      }
      const k = (dy + s) * side + (dx + s);
      scores[k] = ncc;
      if (ncc > scores[best]!) best = k;
    }
  }
  // a repeating texture (a mesh, a grid) scores almost as well at a shift within the limit as at the best one, wherever that is:
  // the window can't tell which cell is which, so it is unmeasurable, not a failure. Only a separate peak counts, 2 px or more
  // from the best: the in-range shoulder of the best peak itself (a true shift of 2-3 px) is a misalignment, not a repeat
  const bestDx = (best % side) - s;
  const bestDy = Math.floor(best / side) - s;
  let inRange = -2;
  for (let dy = -s; dy <= s; dy++) {
    for (let dx = -s; dx <= s; dx++) {
      const v = scores[(dy + s) * side + dx + s]!;
      if (Math.hypot(dx, dy) <= o.maxShift && Math.hypot(dx - bestDx, dy - bestDy) >= 2 && v > inRange) inRange = v;
    }
  }
  if (Math.hypot(bestDx, bestDy) > o.maxShift && scores[best]! - inRange <= AMBIGUOUS) return { ...p, verdict: 'flat', dx: 0, dy: 0, peak: 0, unjudgeable: true };
  const bx = (best % side) - s;
  const by = Math.floor(best / side) - s;
  const score = (dx: number, dy: number): number => scores[(dy + s) * side + (dx + s)]!;
  const vertex = (l: number, c: number, rr: number): number => { const d = l - 2 * c + rr; return d < 0 ? (l - rr) / (2 * d) : 0; };
  const fx = !blindX && Math.abs(bx) < s ? vertex(score(bx - 1, by), score(bx, by), score(bx + 1, by)) : 0;
  const fy = !blindY && Math.abs(by) < s ? vertex(score(bx, by - 1), score(bx, by), score(bx, by + 1)) : 0;
  const dx = bx + fx;
  const dy = by + fy;
  const peak = scores[best]!;
  // a best shift at the search's edge may be a bigger one still: never a pass
  const atEdge = (!blindX && Math.abs(bx) === s) || (!blindY && Math.abs(by) === s);
  const verdict = !atEdge && peak >= o.minPeak && Math.hypot(dx, dy) <= o.maxShift + SHIFT_RESOLUTION ? 'pass' : 'fail';
  return { ...p, verdict, dx: Math.round(dx * 100) / 100, dy: Math.round(dy * 100) / 100, peak: Math.round(peak * 1000) / 1000, ...(blindX ? { blind: 'x' as const } : blindY ? { blind: 'y' as const } : {}) };
}

/**
 * A point's verdict: the fine scale's, unless that failed for a low peak alone (no confident shift was found, so the
 * failure says the window has no usable structure, not that the plate is off), when the coarse scale decides. A shift
 * the fine scale found with a confident peak beyond the limit is never reconsidered.
 */
export function measurePoint(maps: EdgeMaps, p: CheckPoint, o: AlignOptions = ALIGN_DEFAULTS): PointResult {
  const fine = measureShift(maps.a, maps.b, p, o);
  if (fine.verdict !== 'fail' || fine.peak >= o.minPeak || o.coarseRadius <= 0) return fine;
  const c = maps.coarse();
  const coarse = measureShift(c.a, c.b, p, { ...o, radius: o.coarseRadius });
  if (coarse.verdict === 'pass') return { ...coarse, scale: 'coarse' };
  // no confident match at either scale, and neither scale's best shift is beyond the limit: unmeasurable, not misaligned
  const within = (r: PointResult): boolean => Math.hypot(r.dx, r.dy) <= o.maxShift + SHIFT_RESOLUTION;
  if (coarse.peak < o.minPeak && within(fine) && within(coarse)) return { ...fine, verdict: 'flat', lowConfidence: true };
  return fine;
}

export interface AlignReport {
  ok: boolean;
  measured: number;
  total: number;
  /** Points that were skipped as unjudgeable (see PointResult.unjudgeable). */
  unjudgeable?: number;
  /** Points left out as low-confidence (see AlignOptions.maxLowConfidence). */
  lowConfidence?: number;
  /** Edge windows added to the points because too few of them measured. */
  supplemented?: number;
  /** The measured point that is furthest from passing (a failure first, then the largest shift). */
  worst: PointResult | null;
  points: PointResult[];
  /** Per axis: how many judged points measure it, and their median |shift|. */
  axes?: { x: { n: number; median: number }; y: { n: number; median: number } };
  why?: string;
}

/** Compares a plate (any whole multiple of the original's size) with the original, at the original's size. */
export function alignCheck(original: Rgba, plate: Rgba, points: CheckPoint[], o: AlignOptions = ALIGN_DEFAULTS): AlignReport {
  if (plate.width % original.width !== 0 || plate.height % original.height !== 0 || plate.width / original.width !== plate.height / original.height) {
    throw new Error(`alignCheck: a ${plate.width}x${plate.height} plate isn't a whole multiple of the ${original.width}x${original.height} original`);
  }
  const small = plate.width === original.width ? plate : areaResize(plate, original.width, original.height);
  const a = edgeMap(original);
  const b = edgeMap(small);
  let coarse: { a: Gray; b: Gray } | undefined;
  const maps: EdgeMaps = { a, b, coarse: () => (coarse ??= { a: edgeMap(original, o.coarseSigma), b: edgeMap(small, o.coarseSigma) }) };
  const own = points.map(p => measurePoint(maps, p, o));
  const share = (rs: PointResult[], keep: (r: PointResult) => boolean): number => (rs.length ? rs.filter(keep).length / rs.length : 0);
  // too little of the hotspot and floor structure to measure (black or smooth paint): the original's own strongest edges stand in
  const short = points.length === 0 || share(own, r => r.verdict !== 'flat') < o.minMeasured || share(own, r => r.unjudgeable === true) >= o.maxUnjudgeable;
  const added: PointResult[] = short && o.minEdgeCoverage > 0 && !points.some(p => p.source.startsWith('edge'))
    ? edgePoints(original, EDGE_POINTS).map(p => measurePoint(maps, { x: p.x, y: p.y, source: `${p.label} ${p.x},${p.y}` }, o))
    : [];
  const results = [...own, ...added];
  const judged = results.filter(r => r.verdict !== 'flat');
  const failed = judged.filter(r => r.verdict === 'fail');
  const rank = (r: PointResult): number => (r.verdict === 'fail' ? 1000 : 0) + Math.hypot(r.dx, r.dy) + (1 - r.peak);
  const furthest = (rs: PointResult[]): PointResult => rs.reduce((m, r) => (rank(r) > rank(m) ? r : m));
  const worst = judged.length ? furthest(judged) : null;
  const unjudgeable = own.filter(r => r.unjudgeable).length;
  const lowConfidence = results.filter(r => r.lowConfidence).length;
  const edgeJudged = added.filter(r => r.verdict !== 'flat').length;
  let why: string | undefined;
  if (failed.length) why = `${failed.length} of ${judged.length} measured points fail; worst ${furthest(failed).source}`;
  else if (lowConfidence / Math.max(1, results.length) >= o.maxLowConfidence) {
    why = `${lowConfidence} of ${results.length} points have no confident match at either scale (limit ${Math.round(o.maxLowConfidence * 100)}%)`;
  }
  else if (added.length > 0) {
    if (judged.length < o.minEdgeCoverage) why = `only ${judged.length} points measure, ${edgeJudged} of the ${added.length} edge windows added and ${judged.length - edgeJudged} of the ${own.length} hotspot and floor points (need ${o.minEdgeCoverage})`;
  }
  else if (results.length && unjudgeable / results.length >= o.maxUnjudgeable) {
    why = `${unjudgeable} of ${results.length} points are unjudgeable (repeating texture, diagonal edges, border corners; limit ${Math.round(o.maxUnjudgeable * 100)}%)`;
  }
  else if (results.length === 0 || judged.length / results.length < o.minMeasured) {
    why = `only ${judged.length} of ${results.length} points are measurable (need ${Math.round(o.minMeasured * 100)}%)`;
  }
  // a straight edge can't see the shift along it, yet counts as measured: each axis needs enough points that can see it,
  // and those points may not agree on a drift (a plate moved along the blind axis of most points passes point by point)
  const median = (v: number[]): number => {
    const t = [...v].sort((p, q) => p - q);
    return t.length ? (t.length % 2 ? t[(t.length - 1) / 2]! : (t[t.length / 2 - 1]! + t[t.length / 2]!) / 2) : 0;
  };
  const axis = (k: 'x' | 'y'): { n: number; median: number } => {
    const seen = judged.filter(r => r.blind !== k);
    return { n: seen.length, median: Math.round(median(seen.map(r => Math.abs(k === 'x' ? r.dx : r.dy))) * 100) / 100 };
  };
  const axes = { x: axis('x'), y: axis('y') };
  if (why === undefined && judged.length) {
    const need = Math.max(o.minAxis, Math.ceil(o.minAxisShare * judged.length));
    for (const k of ['x', 'y'] as const) {
      if (axes[k].n < need) why = `only ${axes[k].n} of ${judged.length} measured points can see the ${k} axis (need ${need})`;
      else if (axes[k].median > o.maxDrift + DRIFT_RESOLUTION) why = `the plate drifts ${axes[k].median} px along ${k} (median over ${axes[k].n} points, limit ${o.maxDrift})`;
      if (why) break;
    }
  }
  return { ok: why === undefined, measured: judged.length, total: results.length, worst, points: results, unjudgeable, lowConfidence, supplemented: added.length, axes, why };
}

const COLOURS = { pass: [0, 230, 0], fail: [255, 0, 255], flat: [140, 140, 140] } as const;

/** The original's edges in red and the plate's in cyan (white where they coincide), 2x, with each point boxed by its verdict. */
export function overlay(original: Rgba, plate: Rgba, report: AlignReport): Rgba {
  const small = plate.width === original.width ? plate : areaResize(plate, original.width, original.height);
  const a = edgeMap(original);
  const b = edgeMap(small);
  const k = 2;
  const w = original.width * k;
  const h = original.height * k;
  const data = new Uint8Array(w * h * 4);
  // the strongest edges saturate, weak ones still show
  const lift = (v: number): number => Math.min(255, Math.round(255 * Math.sqrt(v) * 1.2));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = Math.floor(y / k) * original.width + Math.floor(x / k);
      const o = (y * w + x) * 4;
      data[o] = lift(a.data[i]!);
      data[o + 1] = data[o + 2] = lift(b.data[i]!);
      data[o + 3] = 255;
    }
  }
  const put = (x: number, y: number, c: readonly number[]): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const o = (y * w + x) * 4;
    data[o] = c[0]!; data[o + 1] = c[1]!; data[o + 2] = c[2]!;
  };
  for (const p of report.points) {
    const c = COLOURS[p.verdict];
    const cx = Math.round(p.x * k);
    const cy = Math.round(p.y * k);
    for (let d = -12; d <= 12; d++) {
      put(cx + d, cy - 12, c); put(cx + d, cy + 12, c); put(cx - 12, cy + d, c); put(cx + 12, cy + d, c);
    }
  }
  return { width: w, height: h, data };
}
