// SPDX-License-Identifier: GPL-3.0-or-later
import { PNG } from 'pngjs';
import { ALIGN_DEFAULTS, alignCheck } from '../../art/src/align';
import type { CheckPoint } from '../../art/src/points';
import { BUTTONS, PAGE, PAGE_RECT, tabRect } from '../../../engine/src/view/combat/console';

/**
 * The screenshot check's comparison (M8 spec §9.3, Decision 20): silhouette and framing, not pixels. In the view's
 * rectangle of each screen, what isn't the background (the rectangle's commonest colour), with the stars taken out, is
 * the ships' mask; the two masks must overlap by IoU 0.9 at least, taken with a 1 px edge tolerance (Plan 31 R9), with their boxes' edges and centroids within 2 px.
 */

export interface Rect { x: number; y: number; width: number; height: number }
/** The Split view's rectangle of the 640 x 480 screen (tactical.cpp:38-41). */
export const VIEW_RECT: Rect = { x: 319, y: 23, width: 320, height: 220 };
/** The thresholds (M8 spec §9.3). */
export const MIN_IOU = 0.9;
export const MAX_SHIFT = 2;
/** A star's largest pattern (drawStars, tactical.cpp:916-921): five pixels across, three down. A component that fits a 5 x 5 box is a star (or a ship too small to tell from one), on both sides alike. */
export const STAR_BOX = 5;
/** Plan 31 R9 (the user's ruling): a pixel in one mask and not the other matches when the other has a pixel within this Chebyshev distance; the port's multisampled edges cover a 1 px ring the original's rasterizer doesn't. */
export const EDGE_TOLERANCE = 1;

/** The mask of a screen's `rect`: 1 where the pixel isn't the rectangle's commonest colour. */
export function viewMask(png: PNG, rect: Rect = VIEW_RECT): Uint8Array {
  const at = (x: number, y: number) => ((rect.y + y) * png.width + rect.x + x) * 4;
  const key = (i: number) => (png.data[i]! << 16) | (png.data[i + 1]! << 8) | png.data[i + 2]!;
  const counts = new Map<number, number>();
  for (let y = 0; y < rect.height; y++) for (let x = 0; x < rect.width; x++) { const k = key(at(x, y)); counts.set(k, (counts.get(k) ?? 0) + 1); }
  let background = 0, most = -1;
  for (const [k, n] of counts) if (n > most) { most = n; background = k; }
  const mask = new Uint8Array(rect.width * rect.height);
  for (let y = 0; y < rect.height; y++) for (let x = 0; x < rect.width; x++) mask[y * rect.width + x] = key(at(x, y)) === background ? 0 : 1;
  return mask;
}

/** The mask with the stars taken out: each 8-connected component that fits a STAR_BOX square cleared. */
export function dropStars(mask: Uint8Array, width: number, height: number): Uint8Array {
  const out = mask.slice();
  const seen = new Uint8Array(mask.length);
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    const comp: number[] = [];
    const stack = [start];
    seen[start] = 1;
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    while (stack.length > 0) {
      const i = stack.pop()!;
      comp.push(i);
      const x = i % width, y = Math.floor(i / width);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        if (mask[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    if (x1 - x0 < STAR_BOX && y1 - y0 < STAR_BOX) for (const i of comp) out[i] = 0;
  }
  return out;
}

/** A mask's area, box ([left, top, right, bottom], inclusive) and centroid; null box and centroid when empty. */
export function maskStats(mask: Uint8Array, width: number): { area: number; box: [number, number, number, number] | null; centroid: [number, number] | null } {
  let area = 0, sx = 0, sy = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  mask.forEach((v, i) => {
    if (!v) return;
    const x = i % width, y = Math.floor(i / width);
    area++; sx += x; sy += y;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  });
  return area === 0 ? { area, box: null, centroid: null } : { area, box: [x0, y0, x1, y1], centroid: [sx / area, sy / area] };
}

/** `iou` is the tolerant one (EDGE_TOLERANCE) that decides `pass`; `strictIou` counts only identical pixels. */
export interface ShotComparison { iou: number; strictIou: number; shift: number; centroid: number; areas: [number, number]; pass: boolean }

/** Compares two 640 x 480 screens' view rectangles: ScummVM's and the port's. Both empty passes (nothing in view on either). */
export function compareShots(scummvm: PNG, port: PNG, rect: Rect = VIEW_RECT): ShotComparison {
  const a = dropStars(viewMask(scummvm, rect), rect.width, rect.height);
  const b = dropStars(viewMask(port, rect), rect.width, rect.height);
  const near = (m: Uint8Array, x: number, y: number) => {
    for (let dy = -EDGE_TOLERANCE; dy <= EDGE_TOLERANCE; dy++) for (let dx = -EDGE_TOLERANCE; dx <= EDGE_TOLERANCE; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < rect.width && ny < rect.height && m[ny * rect.width + nx]) return true;
    }
    return false;
  };
  let both = 0, either = 0, matched = 0;
  for (let i = 0; i < a.length; i++) {
    if (!a[i] && !b[i]) continue;
    either++;
    if (a[i] && b[i]) { both++; matched++; continue; }
    if (near(a[i] ? b : a, i % rect.width, Math.floor(i / rect.width))) matched++;
  }
  const sa = maskStats(a, rect.width), sb = maskStats(b, rect.width);
  if (!sa.box || !sb.box || !sa.centroid || !sb.centroid) {
    const pass = !sa.box && !sb.box;
    return { iou: pass ? 1 : 0, strictIou: pass ? 1 : 0, shift: pass ? 0 : Infinity, centroid: pass ? 0 : Infinity, areas: [sa.area, sb.area], pass };
  }
  const iou = matched / either, strictIou = both / either;
  const shift = Math.max(...sa.box.map((v, i) => Math.abs(v - sb.box![i]!)));
  const centroid = Math.hypot(sa.centroid[0] - sb.centroid[0], sa.centroid[1] - sb.centroid[1]);
  return { iou, strictIou, shift, centroid, areas: [sa.area, sb.area], pass: iou >= MIN_IOU && shift <= MAX_SHIFT && centroid <= MAX_SHIFT };
}

/**
 * The radar's panel (drawRadar's box and floor, and the blips' boxes: a blip at x 12-307, y 30-288, tactical.cpp:1127, draws
 * up to x 312 and from y 25): left out of the console's comparison, as its grid's scroll is the sum of every frame's move since
 * the session began and its target's blink is the wall clock's, neither of which a replayed state has (Plan 27 R17).
 */
export const RADAR_PANEL: Rect = { x: 0, y: 25, width: 313, height: 267 };

/**
 * How far from a point the alignment check looks (tools/art's alignCheck, by its defaults): its coarse window, the shifts it
 * searches, and the coarse edge map's blur (3 sigma). A point this close to the view or the radar would see the masks' edges,
 * the same black edge on both sides, which pull a match towards no shift (Plan 27 R17, amended).
 */
export const MASK_REACH = ALIGN_DEFAULTS.coarseRadius + ALIGN_DEFAULTS.search + Math.ceil(3 * ALIGN_DEFAULTS.coarseSigma);

/**
 * Where the console must line up (Plan 27 R17): the corners of its six tabs, of the page's place and of the five status fields
 * (tactical.cpp:65-67, 1049-1050), and the corner of every button the CONN page shows (kButtons, tactical.cpp:90-121), as the
 * art checks take a room's hotspot corners; none whose window (MASK_REACH) meets the view or the radar.
 */
export function consolePoints(): CheckPoint[] {
  const out: CheckPoint[] = [];
  const corners = (l: number, t: number, r: number, b: number, source: string) => {
    for (const [x, y] of [[l, t], [r - 1, t], [l, b - 1], [r - 1, b - 1]] as const) out.push({ x, y, source: `${source} ${x},${y}` });
  };
  for (let p = 0; p < 6; p++) corners(...tabRect(p), `tab ${p}`);
  corners(...PAGE_RECT, 'page');
  for (let i = 0; i < 5; i++) corners(542, 307 + 11 * i, 603, 317 + 11 * i, `status ${i}`);
  BUTTONS.forEach((b, i) => { if (b.page === -1 || b.page === PAGE.conn) out.push({ x: b.x, y: b.y, source: `button ${i}` }); });
  const meets = (r: Rect, x: number, y: number) => x + MASK_REACH >= r.x && x - MASK_REACH < r.x + r.width && y + MASK_REACH >= r.y && y - MASK_REACH < r.y + r.height;
  return out.filter(p => !meets(VIEW_RECT, p.x, p.y) && !meets(RADAR_PANEL, p.x, p.y));
}
const inside = (r: Rect, x: number, y: number) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;

export interface ConsoleComparison {
  pass: boolean;
  /** Whether the alignment check passed, on how many of its points. */
  aligned: boolean;
  measured: number;
  total: number;
  /** The share of the compared pixels that are the same, and how many aren't. */
  same: number;
  differ: number;
  why?: string;
}

/**
 * The console's comparison (M8 spec §9.3; Plan 27 R17 as amended by the final review): with the art off it passes only when it
 * both lines up, by the 2 px alignment check (tools/art's alignCheck) at consolePoints, and is the same pixel for pixel outside
 * the view's rectangle and the radar's panel, as the port's console is then the original's indices in the original's palette:
 * anything short of identical (a wrong palette entry, a missing word, a button drawn up) is a real difference. The alignment
 * check adds no edge windows of its own (they could see the masks): a console with too little structure to measure fails.
 * With the art on (`art`, Plan 30 R17) the repaint makes the pixels differ by design: it passes when it lines up, and the share of
 * the same pixels is reported, not judged.
 */
export function compareConsole(scummvm: PNG, port: PNG, o: { art?: boolean } = {}): ConsoleComparison {
  const masked = (png: PNG) => {
    const data = new Uint8Array(png.data);
    for (const r of [VIEW_RECT, RADAR_PANEL]) {
      for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) data.fill(0, (y * png.width + x) * 4, (y * png.width + x) * 4 + 3);
    }
    return { width: png.width, height: png.height, data };
  };
  const a = masked(scummvm), b = masked(port);
  let same = 0, of = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const x = (i / 4) % a.width, y = Math.floor(i / 4 / a.width);
    if (inside(VIEW_RECT, x, y) || inside(RADAR_PANEL, x, y)) continue;
    of++;
    if (a.data[i] === b.data[i] && a.data[i + 1] === b.data[i + 1] && a.data[i + 2] === b.data[i + 2]) same++;
  }
  const report = alignCheck(a, b, consolePoints(), { ...ALIGN_DEFAULTS, minEdgeCoverage: 0 });
  const differ = of - same;
  const why = !report.ok ? report.why ?? 'doesn\'t line up' : differ && !o.art ? `${differ} pixels differ` : undefined;
  return {
    pass: report.ok && (o.art === true || differ === 0), aligned: report.ok, measured: report.measured, total: report.total, same: of ? same / of : 1, differ,
    ...(why ? { why } : {}),
  };
}

/** A contact sheet: each row a shot's ScummVM screen beside the port's, at full size. */
export function contactSheet(rows: readonly [PNG, PNG][]): PNG {
  const w = 640, h = 480;
  const sheet = new PNG({ width: 2 * w, height: Math.max(1, rows.length) * h });
  rows.forEach(([a, b], r) => {
    PNG.bitblt(a, sheet, 0, 0, Math.min(w, a.width), Math.min(h, a.height), 0, r * h);
    PNG.bitblt(b, sheet, 0, 0, Math.min(w, b.width), Math.min(h, b.height), w, r * h);
  });
  return sheet;
}
