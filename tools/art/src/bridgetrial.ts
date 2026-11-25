// SPDX-License-Identifier: GPL-3.0-or-later
import type { BridgeStrip } from './bridgeanim';
import type { Rgba } from './image';

/**
 * `art bridge trial`: a crew member's strips made from a recipe file and looked at over the bridge's plate, published nowhere. Each animation's
 * frames are set over the plate where the crew member stands, as the engine draws them, so variants of a recipe can be compared side by side
 * and in motion (bridgeTrial in cli.ts writes the frames, a sheet and a video).
 */

/** One cell of a strip (its frame `k`), at the strip's scale. */
export function cellOf(s: BridgeStrip, k: number): Rgba {
  const [cw, ch] = s.cell;
  const col = k % s.columns;
  const row = Math.floor(k / s.columns);
  const out: Rgba = { width: cw, height: ch, data: new Uint8Array(cw * ch * 4) };
  for (let y = 0; y < ch; y++) {
    const from = ((row * ch + y) * s.strip.width + col * cw) * 4;
    out.data.set(s.strip.data.subarray(from, from + cw * 4), y * cw * 4);
  }
  return out;
}

/**
 * Frame `k` of a strip over the plate: the plate's `box` ([x, y, w, h], the original's pixels) at the plate's own scale (`plate.width / 640`), with
 * the cell's anchor on `at` (the crew member's place). The cell is drawn at the strip's scale over the plate's: they are the same for the bridge (4).
 */
export function overPlate(plate: Rgba, s: BridgeStrip, k: number, at: [number, number], box: [number, number, number, number]): Rgba {
  const ps = plate.width / 640;
  const [bx, by, bw, bh] = box.map(v => Math.round(v * ps)) as [number, number, number, number];
  const out: Rgba = { width: bw, height: bh, data: new Uint8Array(bw * bh * 4) };
  for (let y = 0; y < bh; y++) out.data.set(plate.data.subarray(((by + y) * plate.width + bx) * 4, ((by + y) * plate.width + bx + bw) * 4), y * bw * 4);
  const cell = cellOf(s, k);
  const k2 = ps / s.scale;
  const left = at[0] * ps - s.anchor[0] * cell.width * k2 - bx;
  const top = at[1] * ps - s.anchor[1] * cell.height * k2 - by;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const u = Math.floor((x - left) / k2);
      const v = Math.floor((y - top) / k2);
      if (u < 0 || v < 0 || u >= cell.width || v >= cell.height) continue;
      const c = (v * cell.width + u) * 4;
      const a = cell.data[c + 3]! / 255;
      if (a === 0) continue;
      const o = (y * bw + x) * 4;
      for (let i = 0; i < 3; i++) out.data[o + i] = Math.round(out.data[o + i]! * (1 - a) + cell.data[c + i]! * a);
      out.data[o + 3] = 255;
    }
  }
  return out;
}

/** The frame shown at each tick of `fps` over `loops` plays of a strip's delays (ms): what a video of it shows. */
export function ticks(delays: readonly number[], fps: number, loops: number): number[] {
  const d = delays.map(v => Math.max(1, v));
  const cycle = d.reduce((a, b) => a + b, 0);
  const out: number[] = [];
  for (let n = 0; ; n++) {
    const t = (n * 1000) / fps;
    if (t >= cycle * loops) return out;
    let into = t % cycle;
    let k = 0;
    while (into >= d[k]!) into -= d[k++]!;
    out.push(k);
  }
}

/** Frames side by side in a grid of `columns` (all the same size), on black. */
export function grid(frames: Rgba[], columns: number): Rgba {
  const { width: w, height: h } = frames[0]!;
  const rows = Math.ceil(frames.length / columns);
  const out: Rgba = { width: w * Math.min(columns, frames.length), height: h * rows, data: new Uint8Array(w * Math.min(columns, frames.length) * h * rows * 4) };
  for (let i = 3; i < out.data.length; i += 4) out.data[i] = 255;
  frames.forEach((f, i) => {
    const x0 = (i % columns) * w;
    const y0 = Math.floor(i / columns) * h;
    for (let y = 0; y < h; y++) out.data.set(f.data.subarray(y * w * 4, (y + 1) * w * 4), ((y0 + y) * out.width + x0) * 4);
  });
  return out;
}
