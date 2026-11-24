// SPDX-License-Identifier: GPL-3.0-or-later
import type { Rgba } from './image';

/**
 * Where one distinct cell of an animated layer's strip lies in the published atlas (Batch 8b). Only the cell's opaque bounds (and a pixel of margin) are
 * stored, so a rock fall whose frames are a third of their union costs a third. `[page, x, y, w, h, ox, oy]`: the pixels `x, y, w, h` of atlas page `page`
 * are the cell's pixels `ox, oy` onward (the cell is the union of the animation's frames). A cell with nothing visible is `[0, 0, 0, 0, 0, 0, 0]`: nothing is drawn.
 */
export type AtlasCell = [page: number, x: number, y: number, w: number, h: number, ox: number, oy: number];

export interface Atlas {
  /** The pages' sizes, in pixels. */
  pages: [number, number][];
  /** One entry per distinct cell, in the order they were given. */
  cells: AtlasCell[];
}

/** A texture's largest side that a lean device is trusted with. */
export const MAX_ATLAS_SIDE = 4096;
/** Transparent pixels between cells, so bilinear sampling at one cell's edge never reads its neighbour. */
const GUTTER = 1;
/** Pixels kept around the opaque bounds, so the edge samples what the whole cell would have. */
const MARGIN = 1;
/** How much more than the least a page layout may take and still be chosen for being squarer. */
const WASTE_SLACK = 1.08;

/** The smallest rectangle of `cell` (x, y, w, h) holding every pixel that is not fully transparent, grown by `margin` and kept inside the cell. Null where there is none. */
export function opaqueBounds(cell: Rgba, margin = MARGIN): { x: number; y: number; w: number; h: number } | null {
  let x0 = cell.width;
  let y0 = cell.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < cell.height; y++) {
    for (let x = 0; x < cell.width; x++) {
      if (cell.data[(y * cell.width + x) * 4 + 3] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  if (x1 < 0) return null;
  const left = Math.max(0, x0 - margin);
  const top = Math.max(0, y0 - margin);
  const right = Math.min(cell.width, x1 + 1 + margin);
  const bottom = Math.min(cell.height, y1 + 1 + margin);
  return { x: left, y: top, w: right - left, h: bottom - top };
}


/** Shelf-packs `order` (tallest first) into pages `width` wide and at most `maxSide` tall: where each cell lies, and each page's size (as much as is used). */
function layout(order: { i: number; box: { x: number; y: number; w: number; h: number } }[], width: number, maxSide: number): { placed: Map<number, AtlasCell>; sizes: [number, number][]; bytes: number; squareness: number } {
  const placed = new Map<number, AtlasCell>();
  let page = 0;
  let x = 0;
  let shelfTop = 0;
  let shelfHeight = 0;
  const heights: number[] = [];
  const widths: number[] = [];
  for (const { i, box } of order) {
    if (x + box.w > width) {
      shelfTop += shelfHeight + GUTTER;
      x = 0;
      shelfHeight = 0;
    }
    if (shelfTop + box.h > maxSide) {
      heights[page] = shelfTop - GUTTER;
      page++;
      shelfTop = 0;
      x = 0;
      shelfHeight = 0;
    }
    placed.set(i, [page, x, shelfTop, box.w, box.h, box.x, box.y]);
    widths[page] = Math.max(widths[page] ?? 0, x + box.w);
    x += box.w + GUTTER;
    shelfHeight = Math.max(shelfHeight, box.h);
  }
  if (order.length > 0) heights[page] = shelfTop + shelfHeight;
  const sizes = heights.map((h, p) => [widths[p]!, h] as [number, number]);
  return { placed, sizes, bytes: 0, squareness: 0 };
}

/**
 * Packs cells into pages no wider or taller than `maxSide`, each cell cropped to its own opaque bounds (not the union's), shelf by shelf, tallest first.
 * The page width is the one of several that wastes least (a whole number of average cells across); the height and width are what is used.
 */
export function packAtlas(cells: Rgba[], maxSide = MAX_ATLAS_SIDE): { atlas: Atlas; pages: Rgba[] } {
  const crops = cells.map(c => ({ cell: c, box: opaqueBounds(c) }));
  const items = crops.map((c, i) => ({ i, ...c })).filter((c): c is { i: number; cell: Rgba; box: NonNullable<typeof c.box> } => c.box !== null);
  for (const { i, box } of items) if (box.w > maxSide || box.h > maxSide) throw new Error(`cell ${i} is ${box.w}x${box.h} after cropping, over the ${maxSide} px a texture may be`);
  const widest = items.reduce((n, { box }) => Math.max(n, box.w), 0);
  const order = [...items].sort((a, b) => b.box.h - a.box.h || a.i - b.i);
  // a page's width is the one that wastes least: shelves are laid out at each width a whole number of average cells across (and at the widest cell), and the smallest total wins
  const average = items.length > 0 ? items.reduce((n, { box }) => n + box.w + GUTTER, 0) / items.length : 1;
  const widths = new Set<number>([Math.min(maxSide, widest)]);
  for (let n = 1; n <= items.length; n++) widths.add(Math.min(maxSide, Math.max(widest, Math.ceil(n * average))));
  const trials = [...widths].map(width => {
    const trial = layout(order, width, maxSide);
    return { ...trial, bytes: trial.sizes.reduce((n, [w, h]) => n + w * h, 0), squareness: trial.sizes.reduce((n, [w, h]) => n + Math.abs(w - h), 0) };
  });
  // (the least waste, give or take a few percent: among those, the fewest pages, then the squarest, as a texture of 100x4000 is a poor one)
  const least = Math.min(...trials.map(t => t.bytes));
  const best = trials.filter(t => t.bytes <= least * WASTE_SLACK).sort((a, b) => a.sizes.length - b.sizes.length || a.squareness - b.squareness || a.bytes - b.bytes)[0];
  const { placed, sizes } = best ?? { placed: new Map<number, AtlasCell>(), sizes: [] as [number, number][] };
  const pages: Rgba[] = sizes.map(([w, h]) => ({ width: w, height: h, data: new Uint8Array(w * h * 4) }));
  const out: AtlasCell[] = cells.map((_, i) => placed.get(i) ?? [0, 0, 0, 0, 0, 0, 0]);
  for (const { i, cell } of items) {
    const [p, px, py, w, h, ox, oy] = placed.get(i)!;
    const dst = pages[p]!;
    for (let row = 0; row < h; row++) {
      const src = ((oy + row) * cell.width + ox) * 4;
      dst.data.set(cell.data.subarray(src, src + w * 4), ((py + row) * dst.width + px) * 4);
    }
  }
  return { atlas: { pages: sizes, cells: out }, pages };
}

/** Cell `i` of an atlas laid back into a cell of `size` (the union), transparent where nothing was stored: the picture the layer draws for it. */
export function unpackCell(pages: Rgba[], atlas: Atlas, i: number, size: [number, number]): Rgba {
  const out: Rgba = { width: size[0], height: size[1], data: new Uint8Array(size[0] * size[1] * 4) };
  const [p, x, y, w, h, ox, oy] = atlas.cells[i]!;
  if (w === 0 || h === 0) return out;
  const src = pages[p]!;
  for (let row = 0; row < h; row++) out.data.set(src.data.subarray(((y + row) * src.width + x) * 4, ((y + row) * src.width + x + w) * 4), ((oy + row) * size[0] + ox) * 4);
  return out;
}

/**
 * The mean difference (levels of 255) over the pixels of `a` that can be seen (alpha above 0), colour and alpha: what the atlas changed. What lies under a
 * transparent pixel is not drawn, and the crop does not keep it.
 */
export function visibleDiff(a: Rgba[], b: Rgba[]): number {
  let sum = 0;
  let n = 0;
  a.forEach((cell, k) => {
    const other = b[k]!;
    if (cell.width !== other.width || cell.height !== other.height) throw new Error(`visibleDiff: cell ${k} changed size`);
    for (let p = 0; p < cell.data.length; p += 4) {
      if (cell.data[p + 3] === 0 && other.data[p + 3] === 0) continue;
      for (let c = 0; c < 4; c++) sum += Math.abs(cell.data[p + c]! - other.data[p + c]!);
      n += 4;
    }
  });
  return n === 0 ? 0 : sum / n;
}

/** The decoded size of an atlas's pages, in bytes (RGBA, no mip chain). */
export const atlasBytes = (atlas: Pick<Atlas, 'pages'>): number => atlas.pages.reduce((n, [w, h]) => n + w * h * 4, 0);
