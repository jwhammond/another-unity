// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * What an animated layer keeps resident while its room is up (Batch 8c). A strip is an atlas of pages that stay as the WebP bytes they were fetched as; the layer
 * has one texture, as big as its largest cell (plus the canvas a cell is drawn on to be uploaded: the same size again), and a ring of decoded cells (the one
 * showing and the next two). A strip that is a plain grid (a one-cell animation, or one published before the atlases) is still a whole texture.
 */
export const RING_FRAMES = 3;
/** The layer's texture and the canvas that stages each frame for it. */
export const SURFACE_COPIES = 2;

/** One published strip, as far as its memory goes. `cells` is an atlas's [page, x, y, w, h, ...] per distinct cell. */
export interface ResidentStrip {
  cells?: readonly (readonly number[])[];
  /** An atlas's pages, [w, h] each: what they cost when they are uploaded whole. */
  pages?: readonly (readonly number[])[];
  /** The page files' names, to count a page two strips (or layers) share once. Default: every page is its own. */
  files?: readonly string[];
  /** A grid strip's decoded size in bytes (the whole image is a texture). */
  gridBytes?: number;
}

/** How a layer's atlas strips are held: streamed (encoded pages, one texture, a ring) or uploaded as whole page textures. */
export type LayerMode = 'stream' | 'whole';

export interface LayerResident {
  mode: LayerMode;
  /** For a whole layer: each page file's decoded bytes (RGBA8, no mips), by file. Empty for a streamed one (its files count encoded). */
  pages: Map<string, number>;
  /** The decoded cells waiting their turn: at most RING_FRAMES of the largest. */
  ring: number;
  /** The layer's texture and its staging canvas. */
  surface: number;
  /** Grid strips, decoded whole. */
  grid: number;
  /** The layer's largest cell, and so its texture, in pixels. */
  texture: [number, number];
}

/** The decoded bytes of every page the strips' atlases have, by file (a page two strips share is one entry). */
function pageBytes(strips: readonly ResidentStrip[]): Map<string, number> {
  const out = new Map<string, number>();
  strips.forEach((s, n) => (s.pages ?? []).forEach((p, i) => out.set(s.files?.[i] ?? `#${n}.${i}`, (p[0] ?? 0) * (p[1] ?? 0) * 4)));
  return out;
}

/**
 * Whichever of the two costs less, decoded (the encoded pages a stream also keeps are a few percent and are not in the comparison, which the engine makes
 * from the presentation alone): the pages uploaded whole, or the stream's ring and texture. Few big cells (horst3.glow: 4 of 1088x760) cost more streamed;
 * many (the hologram's 119) cost far less. A tie, and a layer with no atlas, streams as it did. The engine, `art masks` and the e2e budget all call this.
 */
export function layerMode(strips: readonly ResidentStrip[]): LayerMode {
  const stream = layerResident(strips, 'stream');
  if (stream.surface === 0) return 'stream';
  const sizes = pageBytes(strips);
  // (pages not given: nothing to compare)
  if (sizes.size === 0) return 'stream';
  let whole = 0;
  for (const b of sizes.values()) whole += b;
  return whole < stream.ring + stream.surface ? 'whole' : 'stream';
}

/** A layer's resident bytes apart from its encoded files (which two layers can share: the caller counts each file once). */
export function layerResident(strips: readonly ResidentStrip[], mode: LayerMode = layerMode(strips)): LayerResident {
  let w = 0;
  let h = 0;
  let biggest = 0;
  let cells = 0;
  for (const s of strips) {
    for (const c of s.cells ?? []) {
      const cw = c[3] ?? 0;
      const ch = c[4] ?? 0;
      if (cw === 0 || ch === 0) continue;
      w = Math.max(w, cw);
      h = Math.max(h, ch);
      biggest = Math.max(biggest, cw * ch);
      cells++;
    }
  }
  const grid = strips.reduce((n, s) => n + (s.gridBytes ?? 0), 0);
  if (mode === 'whole') return { mode, pages: pageBytes(strips), ring: 0, surface: 0, grid, texture: [w, h] };
  const ring = Math.min(RING_FRAMES, cells) * biggest * 4;
  const surface = SURFACE_COPIES * w * h * 4;
  return { mode, pages: new Map(), ring, surface, grid, texture: [w, h] };
}
