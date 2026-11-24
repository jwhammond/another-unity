// SPDX-License-Identifier: GPL-3.0-or-later
/** The room's rectangle a layer covers: [x, y, w, h] in the original's pixels. */
export type LayerRect = [number, number, number, number];

/**
 * One animation of an animated layer (a prop whose picture follows the object's animation): a strip of equal cells, as a crew card's is
 * (CardAnim), and where the original draws the cell in the room. The cell is the union of the animation's frames, so a frame that
 * moves or changes size stays where the original draws it inside the cell.
 */
export interface LayerStrip {
  frames: number;
  /** Cells to a row of the image; it wraps into rows when it is wide. */
  columns?: number;
  /** Milliseconds each frame shows. */
  delays: number[];
  loop: boolean;
  /** The animation it falls into when it ends. */
  next?: number;
  /** The cell each frame is, where the strip holds each distinct frame once. Absent: frame i is cell i. */
  of?: number[];
  rect: LayerRect;
  /** One cell in pixels (the union of the frames), where the strip is an atlas. */
  cell?: [number, number];
  /** An atlas's pages: their sizes in pixels. */
  pages?: [number, number][];
  /** An atlas's distinct cells, [page, x, y, w, h, ox, oy]: the page's pixels x, y, w, h are the cell's pixels from ox, oy (w and h 0: nothing visible). */
  cells?: [number, number, number, number, number, number, number][];
}

/** What to draw for one animation at one time. */
export interface LayerFrame {
  /** The animation actually playing (the one asked for, or one it has fallen into). */
  anim: number;
  index: number;
  /** The strip's uv window of the cell: [u0, v0, u1, v1], v up (the first row is the top of the image). */
  uv: [number, number, number, number];
  rect: LayerRect;
  /** The page (texture) of the strip the uv window is in: 0 unless the strip is an atlas of several. */
  page: number;
  /**
   * The part of `rect` (fractions, [left, top, right, bottom], top-left origin) the uv window covers: the whole of it for a grid strip, the cropped cell's place in the
   * union for an atlas. `empty` where an atlas cell has nothing visible: draw nothing.
   */
  sub: [number, number, number, number];
  empty: boolean;
  /** The distinct cell of the strip the frame is (frame `index` for a strip with no `of`). */
  cell: number;
  /** Milliseconds until the frame changes (the animation's own time; Infinity where it holds for good): what a streamer looks ahead by. */
  until: number;
}

/**
 * The frame an animation shows `elapsed` milliseconds after it started: the sprite player's rule, as CardPlayer plays a crew card. Each frame shows for
 * its delay; an animation that loops goes round on its own length; one that ends falls into the animation the original jumps to, with the time that is
 * left (bounded: a chain can loop), and holds its last frame where there is none. Null when the animation has no strip: the caller draws the still.
 */
export function layerFrame(strips: Readonly<Record<number, LayerStrip>>, anim: number, elapsed: number): LayerFrame | null {
  let at = anim;
  let a = strips[at];
  if (!a || a.frames < 1) return null;
  let t = Math.max(0, elapsed);
  for (let hops = 0; hops < 8; hops++) {
    const total = a.delays.reduce((x, y) => x + y, 0);
    if (a.loop || t < total || total <= 0) break;
    const next = a.next !== undefined ? strips[a.next] : undefined;
    if (!next || next.frames < 1) {
      t = total;
      break;
    }
    t -= total;
    at = a.next!;
    a = next;
  }
  const total = a.delays.reduce((x, y) => x + y, 0);
  if (a.loop && total > 0) t %= total;
  let index = 0;
  let end = 0;
  if (total > 0) {
    for (let acc = 0; index < a.frames - 1; index++) {
      acc += a.delays[index] ?? 0;
      end = acc;
      if (t < acc) break;
    }
    if (index === a.frames - 1) end = total;
  }
  // (the last frame of an animation that neither loops nor falls into another holds for good)
  const holds = index === a.frames - 1 && !a.loop && (a.next === undefined || !strips[a.next] || strips[a.next]!.frames < 1);
  const until = total <= 0 || holds ? Infinity : Math.max(end - t, 0);
  const cell = a.of?.[index] ?? index;
  if (a.cells && a.pages && a.cell) {
    const c = a.cells[cell];
    if (!c) return null;
    const [page, x, y, w, h, ox, oy] = c;
    const [pw, ph] = a.pages[page] ?? [1, 1];
    return { anim: at, index, uv: [x / pw, 1 - (y + h) / ph, (x + w) / pw, 1 - y / ph], rect: a.rect, page, sub: [ox / a.cell[0], oy / a.cell[1], (ox + w) / a.cell[0], (oy + h) / a.cell[1]], empty: w === 0 || h === 0, cell, until };
  }
  const cells = a.of ? Math.max(...a.of) + 1 : a.frames;
  const columns = Math.min(cells, a.columns ?? cells);
  const rows = Math.ceil(cells / columns);
  const col = cell % columns;
  const row = Math.floor(cell / columns);
  return { anim: at, index, uv: [col / columns, 1 - (row + 1) / rows, (col + 1) / columns, 1 - row / rows], rect: a.rect, page: 0, sub: [0, 0, 1, 1], empty: false, cell, until };
}

/**
 * The frames that follow the one an animation shows at `elapsed`, up to `count` of them, in the order they will be drawn (what a streamer decodes ahead). A
 * frame that holds for good has none after it; a loop comes back round; one that falls into another animation goes on into it.
 */
export function upcomingFrames(strips: Readonly<Record<number, LayerStrip>>, anim: number, elapsed: number, count: number): LayerFrame[] {
  const out: LayerFrame[] = [];
  let t = Math.max(0, elapsed);
  let f = layerFrame(strips, anim, t);
  for (let i = 0; f && i < count && Number.isFinite(f.until); i++) {
    // (a hair past the boundary, so that the frame on the other side is the one looked at)
    t += f.until + 0.001;
    const next = layerFrame(strips, anim, t);
    if (!next) break;
    out.push(next);
    f = next;
  }
  return out;
}

/**
 * How long an animation plays from its start until it stops, in milliseconds: its frames' delays, and the animation it falls into (and so on), until one
 * holds its last frame. Infinity for one that loops; null when the animation has no strip. What a `wait: true` play waits for (UnityEngine::waitForAnim).
 */
export function animationMillis(strips: Readonly<Record<number, LayerStrip>>, anim: number): number | null {
  let at = anim;
  let total = 0;
  for (let hops = 0; hops < 8; hops++) {
    const a = strips[at];
    if (!a || a.frames < 1) return hops === 0 ? null : total;
    if (a.loop) return Infinity;
    total += a.delays.reduce((x, y) => x + y, 0);
    if (a.next === undefined) return total;
    at = a.next;
  }
  return Infinity;
}
