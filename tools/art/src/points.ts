// SPDX-License-Identifier: GPL-3.0-or-later
import { edgeMap } from './align';
import type { Rgba } from './image';

/** A place in the original's pixels where the plate must still line up. */
export interface CheckPoint {
  x: number;
  y: number;
  /** For reports: 'hotspot lab.transporter top-left', 'floor r18 #3'. */
  source: string;
}

/** The part of a lifted room file this needs (tools/lift's RoomFile). */
export interface RoomHotspots {
  hotspots: { object: string; rect: [number, number, number, number]; pickable?: boolean }[];
}

const W = 640;
const H = 480;

/**
 * Every pickable hotspot rect's corners and every walk-polygon vertex, inside 0..639 x 0..479, deduplicated (the first source wins).
 * An unpickable hotspot is a light or mask overlay: its rect is the sprite's bounding box, whose corners lie on no edge
 * of the scene, and nobody clicks it, so it gives no point.
 */
export function checkPoints(
  room: RoomHotspots,
  screen: { pixelMetric?: { floor: { region: string; points: { x: number; y: number }[] }[] } },
): CheckPoint[] {
  const out: CheckPoint[] = [];
  const seen = new Set<string>();
  const add = (x: number, y: number, source: string): void => {
    if (!(x >= 0 && x < W && y >= 0 && y < H)) return;
    const key = `${x},${y}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ x, y, source });
  };
  for (const h of room.hotspots) {
    if (h.pickable === false) continue;
    const [x0, y0, x1, y1] = h.rect;
    add(x0, y0, `hotspot ${h.object} top-left`);
    add(x1, y0, `hotspot ${h.object} top-right`);
    add(x0, y1, `hotspot ${h.object} bottom-left`);
    add(x1, y1, `hotspot ${h.object} bottom-right`);
  }
  for (const r of screen.pixelMetric?.floor ?? []) r.points.forEach((p, i) => add(p.x, p.y, `floor ${r.region} #${i}`));
  return out;
}

const WINDOW = 12;
/** Mean edge strength (normalised Sobel, 0..1) a window needs: below this it is flat and measures nothing. */
const FLAT = 0.02;

/**
 * Up to `n` window centres where the original has the most edge, at most one per cell of a 4x4 grid (a flat cell gives none),
 * strongest first. For close-ups, whose few hotspot corners can't show a drift (plan R5). The windows stay inside the image.
 */
export function edgePoints(original: Rgba, n: number): { x: number; y: number; label: 'edge' }[] {
  const e = edgeMap(original);
  const { width: w, height: h } = e;
  // integral image, so each window's sum is four reads
  const ii = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += e.data[y * w + x]!;
      ii[(y + 1) * (w + 1) + x + 1] = ii[y * (w + 1) + x + 1]! + row;
    }
  }
  const side = 2 * WINDOW + 1;
  const sum = (cx: number, cy: number): number => {
    const x0 = cx - WINDOW;
    const y0 = cy - WINDOW;
    return ii[(y0 + side) * (w + 1) + x0 + side]! - ii[y0 * (w + 1) + x0 + side]! - ii[(y0 + side) * (w + 1) + x0]! + ii[y0 * (w + 1) + x0]!;
  };
  const best: { x: number; y: number; s: number }[] = [];
  for (let gy = 0; gy < 4; gy++) {
    for (let gx = 0; gx < 4; gx++) {
      let top: { x: number; y: number; s: number } | undefined;
      const x1 = Math.min(w - WINDOW - 1, Math.floor(((gx + 1) * w) / 4) - 1);
      const y1 = Math.min(h - WINDOW - 1, Math.floor(((gy + 1) * h) / 4) - 1);
      for (let y = Math.max(WINDOW, Math.floor((gy * h) / 4)); y <= y1; y += 2) {
        for (let x = Math.max(WINDOW, Math.floor((gx * w) / 4)); x <= x1; x += 2) {
          const s = sum(x, y);
          if (!top || s > top.s) top = { x, y, s };
        }
      }
      if (top && top.s / (side * side) >= FLAT) best.push(top);
    }
  }
  best.sort((a, b) => b.s - a.s || a.y - b.y || a.x - b.x);
  return best.slice(0, n).map(p => ({ x: p.x, y: p.y, label: 'edge' as const }));
}

/** A screen with fewer hotspot and floor points than this is a close-up and gets edge points too. */
export const CLOSE_UP_POINTS = 8;
/** At most this many edge points are added. */
export const EDGE_POINTS = 16;
