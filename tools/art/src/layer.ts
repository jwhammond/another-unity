// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MaskRect } from './masks';
import { CARD_SCALE, MAX_STRIP_WIDTH } from './card';
import { canonicalAnim, playAnim, type SpriteJson } from './sprites';
import { cellGeometry } from './strips';
import type { AtlasCell } from './atlas';

/** The published atlas of an animation's distinct cells (Batch 8b): the game-relative file of each page, its size, and where each cell lies (`packAtlas`). */
export interface StripAtlas {
  images: string[];
  pages: [number, number][];
  cells: AtlasCell[];
}

/**
 * What an animated layer needs to know about one animation of a sprite on one object (Batch 8): the frames the original plays, up to
 * the pause or exit (or the jump back: a loop), where each is drawn in the room, and the cell they share in the published strip.
 * It is worked out from the sprite file alone, with the same packing `makeStrips` does, so the published strip and this agree.
 */
export interface StripLayout {
  /** The sprite animation this is, canonical (an animation that only jumps is its target). */
  anim: number;
  /** Frames the animation plays. */
  frames: number;
  /** Cells in the strip: `frames`, or fewer where the strip holds each distinct frame once. */
  cells: number;
  /** The cell each frame is, where the strip holds each distinct frame once (a blinking light's forty frames are two cells). Absent: frame i is cell i. */
  of?: number[];
  /** Cells to a row of the strip (an atlas has no rows: its cells). */
  columns: number;
  /** Where the distinct cells lie, when the strip is a packed atlas of cropped cells (the pages are `atlas.images`). Absent: the strip is a grid of whole cells. */
  atlas?: StripAtlas;
  /** One cell, in card pixels. */
  cell: [number, number];
  /** The sprite's origin in fractions of a cell. */
  anchor: [number, number];
  /** Milliseconds each frame shows. */
  delays: number[];
  loop: boolean;
  /** The animation it falls into when it ends. */
  next?: number;
  /** Where the original draws the cell in the room ([x, y, w, h], its pixels): the union of the frames' rectangles. */
  rect: MaskRect;
  /** Where it draws each frame ([x, y, w, h]; graphics.cpp drawSprite). */
  rects: MaskRect[];
}

/**
 * The layout of animation `anim` for an object whose sprite origin is `origin` (its position, or the sprite's own where it has one).
 * Null where the sprite has no such animation or it has no frames. `packed` is what the pipeline recorded when it published a strip of only the distinct
 * frames (`of`: the cell of each frame, `columns`): the strip's cells then are not the frames'.
 */
export function stripLayout(sprite: SpriteJson, anim: number, origin: { x: number; y: number }, packed?: StripPack): StripLayout | null {
  const at = canonicalAnim(sprite, anim);
  const body = playAnim(sprite, at).get(at);
  if (!body || body.frames.length === 0) return null;
  const g = cellGeometry(body.frames, CARD_SCALE, MAX_STRIP_WIDTH);
  if (packed && packed.of.length !== body.frames.length) throw new Error(`the strip records ${packed.of.length} frames of animation ${anim}, which plays ${body.frames.length} frames`);
  const cells = packed ? Math.max(...packed.of) + 1 : body.frames.length;
  if (packed?.atlas && packed.atlas.cells.length !== cells) throw new Error(`the atlas of animation ${anim} has ${packed.atlas.cells.length} cells, but its frames are ${cells} distinct ones`);
  const dedup = packed !== undefined && cells < body.frames.length;
  return {
    anim: at,
    frames: body.frames.length,
    cells,
    ...(dedup ? { of: packed!.of } : {}),
    columns: packed ? packed.columns : g.columns,
    ...(packed?.atlas ? { atlas: packed.atlas } : {}),
    cell: g.cell,
    anchor: g.anchor,
    delays: body.frames.map(f => f.wait),
    loop: body.loop,
    ...(body.next !== undefined ? { next: body.next } : {}),
    rect: [origin.x + g.origin[0], origin.y + g.origin[1], g.cell[0] / CARD_SCALE, g.cell[1] / CARD_SCALE],
    rects: body.frames.map(f => [origin.x + f.dx - Math.trunc(f.width / 2), origin.y + f.dy - f.height, f.width, f.height]),
  };
}

/** What the pipeline recorded beside an animated prop's strip: the cell each frame is, and (a packed one) its atlas. */
export interface StripPack {
  of: number[];
  columns: number;
  atlas?: StripAtlas;
}

/** What `publishPropAtlas` recorded beside a prop card's strip (`art/cards/<object>/<anim>.json`), or null where there is no record (a grid strip, as published before batch 8b). */
export async function readStripPack(gameDir: string, object: string, anim: number): Promise<StripPack | null> {
  try {
    const { of, columns, atlas } = JSON.parse(await readFile(join(gameDir, 'art', 'cards', object, `${anim}.json`), 'utf8')) as StripPack;
    return { of, columns, ...(atlas ? { atlas } : {}) };
  } catch {
    return null;
  }
}
