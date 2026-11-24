// SPDX-License-Identifier: GPL-3.0-or-later
import { alphaAt } from './card';
import type { Rgba } from './image';

/**
 * R15: the viewscreen's window in the original's picture. The original paints it a flat key colour; `at` is a seed inside it. The
 * window is the 4-connected region of exactly the seed's colour. Throws if the seed's 3x3 neighbourhood isn't one colour (a seed on
 * the frame, or off the window). The mask has 1 inside; the box is [x, y, width, height] in original pixels.
 */
export function windowMask(original: Rgba, at: [number, number]): { mask: Uint8Array; bbox: [number, number, number, number] } {
  const { width: w, height: h } = original;
  const colour = (x: number, y: number): number => {
    const i = (y * w + x) * 4;
    return (original.data[i]! << 16) | (original.data[i + 1]! << 8) | original.data[i + 2]!;
  };
  const [sx, sy] = at;
  if (sx < 1 || sy < 1 || sx >= w - 1 || sy >= h - 1) throw new Error(`the window seed (${sx}, ${sy}) is outside the picture's interior`);
  const key = colour(sx, sy);
  for (let y = sy - 1; y <= sy + 1; y++) for (let x = sx - 1; x <= sx + 1; x++) {
    if (colour(x, y) !== key) throw new Error(`the window seed (${sx}, ${sy}) isn't on a flat key-coloured region: its 3x3 neighbourhood has more than one colour`);
  }
  const mask = new Uint8Array(w * h);
  const stack = [sy * w + sx];
  mask[stack[0]!] = 1;
  let [x0, y0, x1, y1] = [sx, sy, sx, sy];
  while (stack.length > 0) {
    const i = stack.pop()!;
    const x = i % w;
    const y = (i - x) / w;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as const) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (mask[j] === 0 && colour(nx, ny) === key) {
        mask[j] = 1;
        stack.push(j);
      }
    }
  }
  return { mask, bbox: [x0, y0, x1 - x0 + 1, y1 - y0 + 1] };
}

/** The mask grown `grow` original pixels (a round brush): 1 within `grow` of the window. */
function grown(mask: Uint8Array, width: number, height: number, grow: number): Uint8Array {
  if (grow <= 0) return mask;
  const out = new Uint8Array(mask);
  const r = Math.ceil(grow);
  const reach: [number, number][] = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= grow * grow) reach.push([dx, dy]);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] === 0) continue;
      for (const [dx, dy] of reach) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < width && ny < height) out[ny * width + nx] = 1;
      }
    }
  }
  return out;
}

/**
 * The window layer's alpha: the mask grown `grow` original pixels, then upscaled `scale`x as card.ts does a card's (bilinear, pushed by a
 * smoothstep), so the edge is smooth and 255 inside. Grown, so the frame's key-coloured rim is covered. The colour channels are 0
 * (the layer's colour is the render target's).
 */
export function windowAlpha(mask: Uint8Array, width: number, height: number, scale: number, grow: number): Rgba {
  const g = grown(mask, width, height, grow);
  const src: Rgba = { width, height, data: new Uint8Array(width * height * 4) };
  for (let i = 0; i < g.length; i++) src.data[i * 4 + 3] = g[i] ? 255 : 0;
  const out: Rgba = { width: width * scale, height: height * scale, data: new Uint8Array(width * scale * height * scale * 4) };
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) out.data[(y * out.width + x) * 4 + 3] = alphaAt(src, (x + 0.5) / scale - 0.5, (y + 0.5) / scale - 0.5);
  }
  return out;
}

/** The part of an RGBA picture inside [x, y, w, h], as its own picture. */
export function crop(img: Rgba, box: [number, number, number, number]): Rgba {
  const [bx, by, bw, bh] = box;
  const out = new Uint8Array(bw * bh * 4);
  for (let y = 0; y < bh; y++) out.set(img.data.subarray(((by + y) * img.width + bx) * 4, ((by + y) * img.width + bx + bw) * 4), y * bw * 4);
  return { width: bw, height: bh, data: out };
}
