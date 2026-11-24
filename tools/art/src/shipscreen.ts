// SPDX-License-Identifier: GPL-3.0-or-later
import type { Rgba } from './image';
import type { MaskGeometry } from './maskdenoise';
import { edgePoints, EDGE_POINTS, type CheckPoint } from './points';
import type { PlateStation, Rect, RepaintRecipe } from './recipe';
import type { ShipYaml } from './shiplayout';
import { windowMask } from './window';

/** The part of games/unity/ship.yaml a plate needs, read at run time (never committed). */
export type ShipLift = ShipYaml & {
  /** Pad `rect` is [left, top, right, bottom] in 640x480 pixels (the export's own corners), `stand` the feet. */
  transporter?: { pads?: { rect: [number, number, number, number]; stand: [number, number]; scale: number }[] };
};
export interface ShipInputs {
  points: CheckPoint[];
  geometry: MaskGeometry;
}

const W = 640;
const inside = (x: number, y: number, r: Rect): boolean => x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3];

/** A copy of the image with each keep rect painted over by the row of pixels just above it (below it, at the top), so no edge is left at its border. */
function blanked(img: Rgba, keep: Rect[]): Rgba {
  const data = new Uint8Array(img.data);
  for (const [x0, y0, w, h] of keep) {
    const from = y0 > 0 ? y0 - 1 : Math.min(img.height - 1, y0 + h);
    for (let y = y0; y < Math.min(img.height, y0 + h); y++) for (let x = x0; x < Math.min(img.width, x0 + w); x++) data.copyWithin((y * img.width + x) * 4, (from * img.width + x) * 4, (from * img.width + x) * 4 + 4);
  }
  return { width: img.width, height: img.height, data };
}

/**
 * R13: a ship plate's alignment points and mask geometry, from the recipe's areas, the lift (read at run time) and the original.
 * Points: the corners of every area, the bridge's item corners, the transporter's pad corners and stand points, 8 outline points of a
 * viewscreen's `window` area, and up to EDGE_POINTS edge points chosen on the original with every keep rect blanked.
 * Points inside a keep rect still count and pass trivially: the plate is the original's upscale there.
 */
export function shipInputs(station: PlateStation | 'tactical' | 'admin', recipe: RepaintRecipe, lift: ShipLift | null, original: Rgba, pictures: readonly { name: string; rect: Rect }[] = []): ShipInputs {
  const points: CheckPoint[] = [];
  const seen = new Set<string>();
  const add = (x: number, y: number, source: string): void => {
    // (the original's own size: the admin console and the F1 screen are smaller than the screen)
    const cx = Math.min(original.width - 1, Math.max(0, Math.round(x)));
    const cy = Math.min(original.height - 1, Math.max(0, Math.round(y)));
    const key = `${cx},${cy}`;
    if (seen.has(key)) return;
    seen.add(key);
    points.push({ x: cx, y: cy, source });
  };
  const corners = (name: string, x0: number, y0: number, x1: number, y1: number): void => {
    add(x0, y0, `${name} top-left`);
    add(x1, y0, `${name} top-right`);
    add(x0, y1, `${name} bottom-left`);
    add(x1, y1, `${name} bottom-right`);
  };
  // [x0, y0, x1, y1]: what the mask's geometry takes
  const rects: [number, number, number, number][] = [];

  if (station === 'bridge' && lift) {
    lift.bridge.items.forEach((it, i) => {
      corners(`item ${i}`, it.x, it.y, it.x + it.width, it.y + it.height);
      rects.push([it.x, it.y, it.x + it.width, it.y + it.height]);
    });
  }
  if (station === 'transporter' && lift) {
    (lift.transporter?.pads ?? []).forEach((p, i) => {
      corners(`pad ${i}`, p.rect[0], p.rect[1], p.rect[2], p.rect[3]);
      add(p.stand[0], p.stand[1], `pad ${i} stand`);
      rects.push([p.rect[0], p.rect[1], p.rect[2], p.rect[3]]);
    });
  }
  // (Plan 30 R5: tactical's pages' atlas, each picture a rectangle that must hold still, as an area)
  for (const { name, rect: [x, y, w, h] } of pictures) {
    rects.push([x, y, x + w, y + h]);
    corners(`picture ${name}`, x, y, x + w, y + h);
  }
  for (const [name, [x, y, w, h]] of Object.entries(recipe.areas)) {
    rects.push([x, y, x + w, y + h]);
    corners(`area ${name}`, x, y, x + w, y + h);
  }
  // R15: the viewscreen's window is the key-coloured region at `window.at`: held at mask 0, and 8 outline points from its centroid
  let keepMask: MaskGeometry['keepMask'];
  if (station === 'viewscreen' && recipe.window) {
    const { mask } = windowMask(original, recipe.window.at);
    keepMask = { mask, width: original.width, height: original.height };
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) { sx += i % original.width; sy += Math.floor(i / original.width); n++; }
    const cx = sx / n;
    const cy = sy / n;
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      // (y goes down: 90 degrees is up on the screen)
      const dx = Math.cos(a);
      const dy = -Math.sin(a);
      let t = 0;
      const on = (u: number): boolean => {
        const x = Math.round(cx + dx * u);
        const y = Math.round(cy + dy * u);
        return x >= 0 && y >= 0 && x < original.width && y < original.height && mask[y * original.width + x] === 1;
      };
      while (on(t + 0.5)) t += 0.5;
      add(cx + dx * t, cy + dy * t, `window outline ${k * 45}deg`);
    }
  }
  for (const p of edgePoints(blanked(original, recipe.keep), EDGE_POINTS)) {
    if (recipe.keep.some(k => inside(p.x, p.y, k))) continue;
    add(p.x, p.y, `${p.label} ${p.x},${p.y}`);
  }
  return { points, geometry: { rects, polygons: [], keep: recipe.keep, ...(keepMask ? { keepMask } : {}) } };
}

/**
 * R12: inside each keep rect the upscale, blended over `feather` original pixels inside the rect's edge; elsewhere the repaint.
 * Sizes are the plate's (`upscaled` is the same size); `keep` is in original pixels, `originalWidth` the original's width. An edge of
 * the rect that lies on the picture's border doesn't blend: there is nothing outside it to meet.
 */
export function keepComposite(plate: Rgba, upscaled: Rgba, keep: Rect[], feather: number, originalWidth = W): Rgba {
  if (plate.width !== upscaled.width || plate.height !== upscaled.height) throw new Error(`keepComposite: the plate is ${plate.width}x${plate.height} and the upscale ${upscaled.width}x${upscaled.height}`);
  const s = plate.width / originalWidth;
  const band = feather * s;
  const weight = new Float32Array(plate.width * plate.height);
  for (const [rx, ry, rw, rh] of keep) {
    const x0 = rx * s;
    const y0 = ry * s;
    const x1 = (rx + rw) * s;
    const y1 = (ry + rh) * s;
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(plate.height, Math.ceil(y1)); y++) {
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(plate.width, Math.ceil(x1)); x++) {
        const cx = x + 0.5;
        const cy = y + 0.5;
        if (cx < x0 || cx >= x1 || cy < y0 || cy >= y1) continue;
        let w = 1;
        if (x0 > 0) w = Math.min(w, (cx - x0) / band);
        if (x1 < plate.width) w = Math.min(w, (x1 - cx) / band);
        if (y0 > 0) w = Math.min(w, (cy - y0) / band);
        if (y1 < plate.height) w = Math.min(w, (y1 - cy) / band);
        const i = y * plate.width + x;
        weight[i] = Math.max(weight[i]!, Math.min(1, Math.max(0, w)));
      }
    }
  }
  const data = new Uint8Array(plate.data);
  for (let i = 0; i < weight.length; i++) {
    const w = weight[i]!;
    if (w <= 0) continue;
    for (let k = 0; k < 4; k++) data[i * 4 + k] = w >= 1 ? upscaled.data[i * 4 + k]! : Math.round(plate.data[i * 4 + k]! * (1 - w) + upscaled.data[i * 4 + k]! * w);
  }
  return { width: plate.width, height: plate.height, data };
}
