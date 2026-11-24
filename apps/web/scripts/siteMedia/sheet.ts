// SPDX-License-Identifier: GPL-3.0-or-later
import type { Rgba } from '../../../../tools/art/src/image';

/** Frames (all one size) in a grid, `columns` to a row; unfilled cells and transparent pixels are black. */
export function gridSheet(frames: Rgba[], columns: number): Rgba {
  const fw = frames[0]?.width ?? 1;
  const fh = frames[0]?.height ?? 1;
  const cols = Math.max(1, Math.min(columns, frames.length || 1));
  const rows = Math.max(1, Math.ceil(frames.length / cols));
  const out: Rgba = { width: cols * fw, height: rows * fh, data: new Uint8Array(cols * fw * rows * fh * 4) };
  for (let i = 3; i < out.data.length; i += 4) out.data[i] = 255;
  frames.forEach((f, i) => {
    const ox = (i % cols) * fw;
    const oy = Math.floor(i / cols) * fh;
    for (let y = 0; y < fh; y++)
      for (let x = 0; x < fw; x++) {
        const s = (y * f.width + x) * 4;
        const d = ((oy + y) * out.width + ox + x) * 4;
        const a = f.data[s + 3]! / 255;
        for (let c = 0; c < 3; c++) out.data[d + c] = Math.round(f.data[s + c]! * a);
      }
  });
  return out;
}

/** The i-th cell of a frame grid with `columns` cells per row (the published card images). */
export function frameAt(img: Rgba, cell: [number, number], columns: number, i: number): Rgba {
  const [cw, ch] = cell;
  const ox = (i % columns) * cw;
  const oy = Math.floor(i / columns) * ch;
  const out: Rgba = { width: cw, height: ch, data: new Uint8Array(cw * ch * 4) };
  for (let y = 0; y < ch && oy + y < img.height; y++) {
    const w = Math.min(cw, img.width - ox);
    if (w > 0) out.data.set(img.data.subarray(((oy + y) * img.width + ox) * 4, ((oy + y) * img.width + ox + w) * 4), y * cw * 4);
  }
  return out;
}
