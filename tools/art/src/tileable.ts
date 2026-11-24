// SPDX-License-Identifier: GPL-3.0-or-later
import { roll, type Rgba } from './image';

/**
 * R5's seam fix: roll by half so the wrap's seam is at the centre, blend a `band` px cosine cross there with the unrolled
 * image (whose centre is continuous), and roll back. The centre quarter of the result is the input's, and the wrap is
 * continuous. A fixed pattern (a layout) should keep clear of the band around the edges and the centre lines.
 */
export function makeTileable(img: Rgba, band: number): Rgba {
  const { width: w, height: h } = img;
  if (band <= 0) return { width: w, height: h, data: img.data.slice() };
  const hw = w >> 1;
  const hh = h >> 1;
  const rolled = roll(img, hw, hh);
  const half = band / 2;
  // 1 on the centre line, falling to 0 at `half` px by a cosine
  const line = (p: number, c: number): number => {
    const d = Math.abs(p - c);
    return d >= half ? 0 : 0.5 * (1 + Math.cos((Math.PI * d) / half));
  };
  const out = new Uint8Array(img.data.length);
  for (let y = 0; y < h; y++) {
    const wy = line(y, hh);
    for (let x = 0; x < w; x++) {
      const k = 1 - (1 - line(x, hw)) * (1 - wy);
      const i = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) out[i + c] = Math.round(rolled.data[i + c]! * (1 - k) + img.data[i + c]! * k);
    }
  }
  return roll({ width: w, height: h, data: out }, -hw, -hh);
}
