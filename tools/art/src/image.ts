// SPDX-License-Identifier: GPL-3.0-or-later
import { PNG } from 'pngjs';

export interface Rgba {
  width: number;
  height: number;
  /** 4 bytes per pixel. */
  data: Uint8Array;
}
export interface Gray {
  width: number;
  height: number;
  /** 0..1 */
  data: Float32Array;
}

/** Palette, grey and 16-bit PNGs all expand to 8-bit RGBA. */
export function decodePng(bytes: Uint8Array): Rgba {
  const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), { skipRescale: false });
  return { width: png.width, height: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length) };
}

export function encodePng(img: Rgba): Uint8Array {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  return new Uint8Array(PNG.sync.write(png));
}

/** Rec. 709 weights on the sRGB-encoded values. */
export function luminance(img: Rgba): Gray {
  const out = new Float32Array(img.width * img.height);
  for (let i = 0; i < out.length; i++) {
    out[i] = (0.2126 * img.data[i * 4]! + 0.7152 * img.data[i * 4 + 1]! + 0.0722 * img.data[i * 4 + 2]!) / 255;
  }
  return { width: img.width, height: img.height, data: out };
}

/** Box filter: exact for integer factors, fractional edge weights otherwise. */
export function areaResize(img: Rgba, width: number, height: number): Rgba {
  const out = new Uint8Array(width * height * 4);
  const sx = img.width / width;
  const sy = img.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = y * sy;
    const y1 = y0 + sy;
    for (let x = 0; x < width; x++) {
      const x0 = x * sx;
      const x1 = x0 + sx;
      const acc = [0, 0, 0, 0];
      let wsum = 0;
      for (let yy = Math.floor(y0); yy < Math.min(img.height, Math.ceil(y1)); yy++) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        for (let xx = Math.floor(x0); xx < Math.min(img.width, Math.ceil(x1)); xx++) {
          const w = wy * (Math.min(xx + 1, x1) - Math.max(xx, x0));
          const i = (yy * img.width + xx) * 4;
          for (let c = 0; c < 4; c++) acc[c]! += img.data[i + c]! * w;
          wsum += w;
        }
      }
      for (let c = 0; c < 4; c++) out[(y * width + x) * 4 + c] = Math.round(acc[c]! / wsum);
    }
  }
  return { width, height, data: out };
}

/** Wrap-around shift: the pixel at (x, y) moves to (x+dx, y+dy). */
export function roll(img: Rgba, dx: number, dy: number): Rgba {
  const { width: w, height: h } = img;
  const out = new Uint8Array(img.data.length);
  for (let y = 0; y < h; y++) {
    const ty = (((y + dy) % h) + h) % h;
    for (let x = 0; x < w; x++) {
      const tx = (((x + dx) % w) + w) % w;
      const s = (y * w + x) * 4;
      out.set(img.data.subarray(s, s + 4), (ty * w + tx) * 4);
    }
  }
  return { width: w, height: h, data: out };
}

/** Per channel (R, G, B and A), 0..255. */
export function meanAbsDiff(a: Rgba, b: Rgba): number {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`meanAbsDiff: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  let sum = 0;
  for (let i = 0; i < a.data.length; i++) sum += Math.abs(a.data[i]! - b.data[i]!);
  return sum / a.data.length;
}
