// SPDX-License-Identifier: GPL-3.0-or-later
import type { Rgba } from './image';

/** R3: an item passes when its ID-pass silhouette covers at least this much of its rectangle... */
export const MIN_COVERAGE = 0.8;
/** ...and spills outside it by at most this much of the rectangle's area. */
export const MAX_SPILL = 0.12;
/** Workbench's flat, unsmoothed output is exact up to rounding in the colour transform. */
const TOLERANCE = 3;

export interface ItemFit {
  index: number;
  action: string;
  coverage: number;
  spill: number;
  pass: boolean;
}
export interface IdItem {
  index: number;
  action: string;
  /** [x, y, width, height], 640x480 pixels. */
  rect: [number, number, number, number];
  /** 0xRRGGBB, as the ID pass draws the item. */
  colour: number;
}

const near = (img: Rgba, i: number, colour: number): boolean =>
  Math.abs(img.data[i]! - ((colour >> 16) & 255)) <= TOLERANCE && Math.abs(img.data[i + 1]! - ((colour >> 8) & 255)) <= TOLERANCE && Math.abs(img.data[i + 2]! - (colour & 255)) <= TOLERANCE;

/**
 * Per item: coverage is the share of the rectangle's pixels drawn in the item's colour; spill is the item's pixels outside the
 * rectangle, over the rectangle's area. Several meshes tagged with the item share its colour, so they count as their union.
 * The rectangle's area is its full area, even where it leaves the frame.
 */
export function alignIds(idPass: Rgba, items: IdItem[]): ItemFit[] {
  return items.map(it => {
    const [x, y, w, h] = it.rect;
    let inside = 0;
    let outside = 0;
    for (let py = 0; py < idPass.height; py++)
      for (let px = 0; px < idPass.width; px++) {
        if (!near(idPass, (py * idPass.width + px) * 4, it.colour)) continue;
        if (px >= x && px < x + w && py >= y && py < y + h) inside++;
        else outside++;
      }
    const area = w * h;
    const coverage = inside / area;
    const spill = outside / area;
    return { index: it.index, action: it.action, coverage, spill, pass: coverage >= MIN_COVERAGE && spill <= MAX_SPILL };
  });
}

/**
 * The check's picture: the original at 50%, the ID pass's silhouette edges in cyan, each rectangle in yellow, and a failing
 * item's rectangle in red.
 */
export function alignOverlay(original: Rgba, idPass: Rgba, items: IdItem[], fits: ItemFit[]): Rgba {
  const out: Rgba = { width: original.width, height: original.height, data: new Uint8Array(original.data) };
  for (let i = 0; i < out.data.length; i += 4) for (let k = 0; k < 3; k++) out.data[i + k] = Math.round(out.data[i + k]! * 0.5);
  const same = (a: number, b: number): boolean => idPass.data[a]! === idPass.data[b]! && idPass.data[a + 1]! === idPass.data[b + 1]! && idPass.data[a + 2]! === idPass.data[b + 2]!;
  const W = idPass.width;
  const put = (x: number, y: number, rgb: [number, number, number]): void => {
    if (x < 0 || y < 0 || x >= out.width || y >= out.height) return;
    out.data.set(rgb, (y * out.width + x) * 4);
  };
  for (let y = 0; y < idPass.height - 1; y++)
    for (let x = 0; x < W - 1; x++) {
      const i = (y * W + x) * 4;
      if (!same(i, i + 4) || !same(i, i + W * 4)) put(x, y, [0, 255, 255]);
    }
  for (const it of items) {
    const fit = fits.find(f => f.index === it.index);
    const rgb: [number, number, number] = fit && !fit.pass ? [255, 0, 0] : [255, 230, 0];
    const [x, y, w, h] = it.rect;
    for (let k = 0; k < w; k++) (put(x + k, y, rgb), put(x + k, y + h - 1, rgb));
    for (let k = 0; k < h; k++) (put(x, y + k, rgb), put(x + w - 1, y + k, rgb));
  }
  return out;
}
