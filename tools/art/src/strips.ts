// SPDX-License-Identifier: GPL-3.0-or-later
import type { Rgba } from './image';

const blank = (width: number, height: number): Rgba => ({ width, height, data: new Uint8Array(width * height * 4) });

/**
 * Packs an animation's frames into equal cells, each frame at its offset from the sprite's origin, so that one anchor
 * (the origin: the feet) is the same point of every cell. `png`s are `scale` times their original size; `dx`/`dy` are in
 * original pixels. A frame's left is dx - trunc(width / 2) and its top is dy - height (graphics.cpp drawSprite), with
 * width and height in original pixels. The cell is the union of the frames' rectangles; `anchor` is the origin in
 * fractions of a cell. The cells run left to right; a strip wider than `maxWidth` wraps into rows of `columns` cells
 * (a GPU's texture size is limited, and a wider one is resized down).
 */
export function packAnim(
  frames: { png: Rgba; dx: number; dy: number; wait: number }[],
  scale = 1,
  maxWidth = Infinity,
): { strip: Rgba; cell: [number, number]; anchor: [number, number]; delays: number[]; columns: number } {
  if (frames.length === 0) throw new Error('packAnim: no frames');
  const geometry = cellGeometry(
    frames.map(f => {
      const w = f.png.width / scale;
      const h = f.png.height / scale;
      if (!Number.isInteger(w) || !Number.isInteger(h)) throw new Error(`packAnim: a ${f.png.width}x${f.png.height} frame isn't a whole number of pixels at scale ${scale}`);
      return { width: w, height: h, dx: f.dx, dy: f.dy };
    }),
    scale,
    maxWidth,
  );
  const { cell: [cw, ch], columns } = geometry;
  const rows = Math.ceil(frames.length / columns);
  const strip = blank(cw * columns, ch * rows);
  frames.forEach((f, i) => {
    const ox = (i % columns) * cw + geometry.offsets[i]![0] * scale;
    const oy = Math.floor(i / columns) * ch + geometry.offsets[i]![1] * scale;
    for (let y = 0; y < f.png.height; y++) {
      const src = y * f.png.width * 4;
      strip.data.set(f.png.data.subarray(src, src + f.png.width * 4), ((oy + y) * strip.width + ox) * 4);
    }
  });
  return { strip, cell: [cw, ch], anchor: geometry.anchor, delays: frames.map(f => f.wait), columns };
}

/**
 * The cell packAnim makes for frames of these sizes (in original pixels) and offsets, with no pixels: the cell and the origin's place in
 * it (the same numbers packAnim returns), the cells to a row, each frame's offset inside its cell (original pixels), and the cell's
 * left and top from the origin (original pixels, <= 0). A layer's rectangle in the room is the sprite's origin plus these.
 */
export function cellGeometry(
  frames: { width: number; height: number; dx: number; dy: number }[],
  scale = 1,
  maxWidth = Infinity,
): { cell: [number, number]; anchor: [number, number]; columns: number; offsets: [number, number][]; origin: [number, number] } {
  const rects = frames.map(f => {
    const left = f.dx - Math.trunc(f.width / 2);
    const top = f.dy - f.height;
    return { left, top, right: left + f.width, bottom: top + f.height };
  });
  const minLeft = Math.min(...rects.map(r => r.left));
  const maxRight = Math.max(...rects.map(r => r.right));
  const minTop = Math.min(...rects.map(r => r.top));
  const maxBottom = Math.max(...rects.map(r => r.bottom));
  const cw = (maxRight - minLeft) * scale;
  const ch = (maxBottom - minTop) * scale;
  return {
    cell: [cw, ch],
    anchor: [(-minLeft * scale) / cw, (-minTop * scale) / ch],
    columns: Math.max(1, Math.min(frames.length, Math.floor(maxWidth / cw))),
    offsets: rects.map(r => [r.left - minLeft, r.top - minTop]),
    origin: [minLeft, minTop],
  };
}

const OPAQUE = 128;
/** The shadow lies in the frame's lowest rows: this fraction of its opaque height. */
const FOOT_BAND = 0.12;
/** How dark a shadow gets under its middle (the dither is half black, so full density is half the pixels). */
const SHADOW_OPACITY = 0.45;
/** The blur's radius, in original pixels. */
const SHADOW_RADIUS = 1.6;

const isShadowColour = (frame: Rgba, p: number, colours: [number, number, number][]): boolean =>
  frame.data[p + 3]! >= OPAQUE && colours.some(c => frame.data[p] === c[0] && frame.data[p + 1] === c[1] && frame.data[p + 2] === c[2]);

/**
 * The dither's pixels: shadow-coloured, in the frame's lowest rows, with no opaque pixel above, below or beside them
 * (a checkerboard's pixels touch only at corners; a shoe's outline is a line). 1 where a pixel is one.
 */
export function findFootShadow(frame: Rgba, shadowColours: [number, number, number][]): Uint8Array {
  const { width: w, height: h } = frame;
  const mask = new Uint8Array(w * h);
  let top = h;
  let bottom = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (frame.data[(y * w + x) * 4 + 3]! >= OPAQUE) {
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  }
  if (bottom < 0) return mask;
  const from = bottom - Math.max(2, Math.round((bottom - top + 1) * FOOT_BAND));
  const opaque = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h && frame.data[(y * w + x) * 4 + 3]! >= OPAQUE;
  for (let y = Math.max(0, from); y <= bottom; y++) {
    for (let x = 0; x < w; x++) {
      if (isShadowColour(frame, (y * w + x) * 4, shadowColours) && !opaque(x - 1, y) && !opaque(x + 1, y) && !opaque(x, y - 1) && !opaque(x, y + 1)) mask[y * w + x] = 1;
    }
  }
  return mask;
}

/** A separable box blur of a 0..1 field, `radius` pixels each way, with the edges treated as empty. */
function blur(field: Float32Array, w: number, h: number, radius: number): Float32Array {
  const r = Math.max(1, Math.round(radius));
  const pass = (src: Float32Array, horizontal: boolean): Float32Array => {
    const out = new Float32Array(src.length);
    const n = horizontal ? w : h;
    const lines = horizontal ? h : w;
    for (let line = 0; line < lines; line++) {
      let sum = 0;
      const at = (i: number): number => (i < 0 || i >= n ? 0 : src[horizontal ? line * w + i : i * w + line]!);
      for (let i = -r; i <= r; i++) sum += at(i);
      for (let i = 0; i < n; i++) {
        out[horizontal ? line * w + i : i * w + line] = sum / (2 * r + 1);
        sum += at(i + r + 1) - at(i - r);
      }
    }
    return out;
  };
  // (three passes of a box are close to a gaussian)
  let f = field;
  for (let k = 0; k < 3; k++) f = pass(pass(f, true), false);
  return f;
}

/**
 * Turns a mask of dither pixels into a smooth translucent shadow: the shadow pixels leave the figure, and the local
 * density of the mask, blurred, becomes the alpha of a black shadow laid only where the figure is not. `scale` is how
 * many pixels one original pixel is in `frame`.
 */
export function smoothShadow(frame: Rgba, mask: Uint8Array, shadowColour: [number, number, number], scale = 1): Rgba {
  const { width: w, height: h } = frame;
  const out: Rgba = { width: w, height: h, data: new Uint8Array(frame.data) };
  let any = false;
  const density = new Float32Array(w * h);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    any = true;
    density[i] = 1;
    // (the dither pixel is no longer part of the figure)
    out.data[i * 4 + 3] = 0;
  }
  if (!any) return out;
  const smooth = blur(density, w, h, SHADOW_RADIUS * scale);
  // (a half-black checkerboard blurs to 0.5 at its middle: that is full shadow)
  for (let i = 0; i < w * h; i++) {
    if (out.data[i * 4 + 3]! > 0) continue;
    const a = Math.min(1, smooth[i]! / 0.5) * SHADOW_OPACITY;
    if (a < 1 / 255) continue;
    out.data.set([shadowColour[0], shadowColour[1], shadowColour[2], Math.round(a * 255)], i * 4);
  }
  return out;
}

/** Turns the dithered shadow below the feet into a smooth translucent shadow (alpha from local dither density, blurred). */
export function fixFootShadow(frame: Rgba, shadowColours: [number, number, number][]): Rgba {
  return smoothShadow(frame, findFootShadow(frame, shadowColours), shadowColours[0] ?? [0, 0, 0], 1);
}

/** The mask of an original frame, as nearest-neighbour blocks at `scale` times the size (for a card made from it). */
export function scaleMask(mask: Uint8Array, width: number, height: number, scale: number): Uint8Array {
  const out = new Uint8Array(width * scale * height * scale);
  for (let y = 0; y < height * scale; y++) {
    for (let x = 0; x < width * scale; x++) out[y * width * scale + x] = mask[Math.floor(y / scale) * width + Math.floor(x / scale)]!;
  }
  return out;
}

/** Blits `over` onto `base` at (x, y) where `over` is opaque (a speech frame's mouth on its marked frame). */
export function overlayFrame(base: Rgba, over: Rgba, x: number, y: number): Rgba {
  const out: Rgba = { width: base.width, height: base.height, data: new Uint8Array(base.data) };
  for (let j = 0; j < over.height; j++) {
    for (let i = 0; i < over.width; i++) {
      const px = x + i;
      const py = y + j;
      if (px < 0 || py < 0 || px >= out.width || py >= out.height) continue;
      const s = (j * over.width + i) * 4;
      if (over.data[s + 3]! < OPAQUE) continue;
      out.data.set(over.data.subarray(s, s + 4), (py * out.width + px) * 4);
    }
  }
  return out;
}

/**
 * A speech frame as it is drawn over a repaint of its marked frame: `repainted` (the repaint of the frame without its mouth) with the mouth's pixels put back where the
 * frame with the mouth (`up`) differs from the one without (`plain`, both the upscaler's output). The body is then the same in every frame of a talk animation, and the same as the
 * animation the character stands in, so a switch between them shows only the mouth; the mouth is the original's own sprite, as the original draws it.
 */
export function mouthOver(repainted: Rgba, up: Rgba, plain: Rgba): Rgba {
  if (repainted.width !== up.width || repainted.height !== up.height || plain.width !== up.width || plain.height !== up.height) throw new Error('mouthOver: the cells are not the same size');
  const out: Rgba = { width: repainted.width, height: repainted.height, data: new Uint8Array(repainted.data) };
  for (let i = 0; i < up.width * up.height * 4; i += 4) {
    if (up.data[i] !== plain.data[i] || up.data[i + 1] !== plain.data[i + 1] || up.data[i + 2] !== plain.data[i + 2] || up.data[i + 3] !== plain.data[i + 3]) out.data.set(up.data.subarray(i, i + 4), i);
  }
  return out;
}
