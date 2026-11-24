// SPDX-License-Identifier: GPL-3.0-or-later
import { alignCheck, ALIGN_DEFAULTS, type PointResult } from './align';
import type { Rgba } from './image';
import type { CheckPoint } from './points';

/**
 * The local warp post-step: a touch-up for a plate that is right nearly everywhere and off by a few pixels at a point or two.
 * It never changes what the alignment check asks (the check runs after it, with its own thresholds); it only moves the plate's
 * own pixels, never gameplay data (hotspots, walk polygons and markers are read from the lift, not from the plate).
 */
export interface WarpOptions {
  /** Falloff radius of each correction, in original pixels. */
  radius: number;
  /** A point is warped only when its measured shift is more than this (original pixels). */
  minShift: number;
  /** Measure-and-warp rounds. */
  passes: number;
  /** A point whose measured shift is beyond this is not warped (original pixels): the plate there is too far off for a touch-up. */
  maxWarp: number;
  /** The warp is refused outright when more than this share of the measured points need it: a plate that is off everywhere is not touched up. */
  maxShare: number;
}
export const WARP_DEFAULTS: WarpOptions = { radius: 24, minShift: 1, passes: 2, maxWarp: 5, maxShare: 0.25 };

/** The measurement search is wider than the check's (4), so a shift of 4 px can be told from a shift beyond the window. */
const WARP_SEARCH = 6;

export interface WarpedPoint {
  source: string;
  x: number;
  y: number;
  /** Where the plate's content was measured against the original (original pixels); it is moved back by this. */
  dx: number;
  dy: number;
  peak: number;
}
export interface WarpPass {
  measured: number;
  warped: WarpedPoint[];
  /** Points that are off by more than minShift but not warped, and why. */
  skipped: { source: string; why: string }[];
}
export interface WarpReport {
  /** True when the plate was changed. */
  changed: boolean;
  passes: WarpPass[];
  /** Why the warp did nothing (too many points need it). */
  refused?: string;
  options: WarpOptions;
}

/** A point's shift is usable for a warp: the match is confident, and the point was measured (not flat, not at the search edge). */
function confident(r: PointResult, o: WarpOptions): { ok: true } | { ok: false; why: string } {
  if (r.verdict === 'flat') return { ok: false, why: 'unmeasurable' };
  if (r.peak < ALIGN_DEFAULTS.minPeak) return { ok: false, why: `low match peak ${r.peak}` };
  const d = Math.hypot(r.dx, r.dy);
  if (d > o.maxWarp) return { ok: false, why: `shift ${d.toFixed(2)} px is beyond the ${o.maxWarp} px a warp may move` };
  return { ok: true };
}

/** Bilinear sample of `img` at (x, y) in its own pixels, the edge repeated. */
function sample(img: Rgba, x: number, y: number, out: Uint8Array, at: number): void {
  const { width: w, height: h } = img;
  const cx = Math.min(w - 1, Math.max(0, x));
  const cy = Math.min(h - 1, Math.max(0, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  for (let c = 0; c < 4; c++) {
    const a = img.data[(y0 * w + x0) * 4 + c]!;
    const b = img.data[(y0 * w + x1) * 4 + c]!;
    const d = img.data[(y1 * w + x0) * 4 + c]!;
    const e = img.data[(y1 * w + x1) * 4 + c]!;
    out[at + c] = Math.round((a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy);
  }
}

/**
 * Moves the plate's content back by each point's shift, smoothly: a Gaussian-weighted blend of the points' corrections
 * (sigma = radius / 2, cut to zero at radius), normalised by max(1, total weight) so that a lone point is corrected in full at
 * its centre and the field is zero beyond every radius. `scale` is the plate's pixels per original pixel.
 */
export function applyWarp(plate: Rgba, scale: number, points: { x: number; y: number; dx: number; dy: number }[], radius: number): Rgba {
  const { width: w, height: h } = plate;
  const wsum = new Float32Array(w * h);
  const fx = new Float32Array(w * h);
  const fy = new Float32Array(w * h);
  const sigma = radius / 2;
  const tail = Math.exp(-(radius * radius) / (2 * sigma * sigma));
  const R = radius * scale;
  for (const p of points) {
    const cx = p.x * scale;
    const cy = p.y * scale;
    const y0 = Math.max(0, Math.floor(cy - R));
    const y1 = Math.min(h - 1, Math.ceil(cy + R));
    const x0 = Math.max(0, Math.floor(cx - R));
    const x1 = Math.min(w - 1, Math.ceil(cx + R));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const r2 = ((x - cx) ** 2 + (y - cy) ** 2) / (scale * scale);
        if (r2 >= radius * radius) continue;
        const wt = (Math.exp(-r2 / (2 * sigma * sigma)) - tail) / (1 - tail);
        const i = y * w + x;
        wsum[i]! += wt;
        fx[i]! += wt * p.dx;
        fy[i]! += wt * p.dy;
      }
    }
  }
  const out = new Uint8Array(plate.data);
  for (let i = 0; i < w * h; i++) {
    if (wsum[i]! === 0) continue;
    const n = Math.max(1, wsum[i]!);
    // the plate's content sits at +shift: the output at x takes the plate at x + shift
    sample(plate, (i % w) + (fx[i]! / n) * scale, Math.floor(i / w) + (fy[i]! / n) * scale, out, i * 4);
  }
  return { width: w, height: h, data: out };
}

/**
 * Measures the plate against the original, moves the points that are off by more than `minShift` (and measured confidently,
 * within maxWarp) back, and measures again, up to `passes` times. The plate is returned as it was when nothing needs warping
 * and when too many points do (maxShare of the measured points: a global drift is not papered over; the check then fails it).
 */
export function warpPlate(original: Rgba, plate: Rgba, points: CheckPoint[], opts: Partial<WarpOptions> = {}): { plate: Rgba; report: WarpReport } {
  const o: WarpOptions = { ...WARP_DEFAULTS, ...opts };
  if (plate.width % original.width !== 0) throw new Error(`warpPlate: a ${plate.width}x${plate.height} plate isn't a whole multiple of the ${original.width}x${original.height} original`);
  const scale = plate.width / original.width;
  const report: WarpReport = { changed: false, passes: [], options: o };
  let cur = plate;
  for (let pass = 0; pass < o.passes; pass++) {
    const r = alignCheck(original, cur, points, { ...ALIGN_DEFAULTS, search: WARP_SEARCH });
    const judged = r.points.filter(p => p.verdict !== 'flat');
    const off = judged.filter(p => Math.hypot(p.dx, p.dy) > o.minShift);
    const step: WarpPass = { measured: judged.length, warped: [], skipped: [] };
    const todo: WarpedPoint[] = [];
    for (const p of off) {
      const c = confident(p, o);
      if (c.ok) todo.push({ source: p.source, x: p.x, y: p.y, dx: p.dx, dy: p.dy, peak: p.peak });
      else step.skipped.push({ source: p.source, why: c.why });
    }
    if (judged.length > 0 && off.length / judged.length > o.maxShare) {
      report.refused = `${off.length} of ${judged.length} measured points are off by more than ${o.minShift} px (limit ${Math.round(o.maxShare * 100)}%): a plate that is off that widely is not a local touch-up`;
      report.passes.push(step);
      return { plate: report.changed ? cur : plate, report };
    }
    report.passes.push(step);
    if (todo.length === 0) break;
    step.warped = todo;
    cur = applyWarp(cur, scale, todo, o.radius);
    report.changed = true;
  }
  return { plate: cur, report };
}
