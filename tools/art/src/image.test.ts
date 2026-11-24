// SPDX-License-Identifier: GPL-3.0-or-later
import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { areaResize, decodePng, encodePng, luminance, meanAbsDiff, roll, type Rgba } from './image';

const px = (img: Rgba, x: number, y: number): number[] => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
function solid(w: number, h: number, f: (x: number, y: number) => number[]): Rgba {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(f(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
}

/** pngjs cannot write palette PNGs, so build one: 2x1, 8-bit, palette red and blue. */
function palettePng(): Uint8Array {
  const chunk = (type: string, body: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr.set([8, 3, 0, 0, 0], 8);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('PLTE', Buffer.from([255, 0, 0, 0, 0, 255])),
      chunk('IDAT', deflateSync(Buffer.from([0, 0, 1]))),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

describe('image', () => {
  it('decodes a palette PNG to RGBA and round-trips encode/decode', () => {
    const palette = palettePng();
    expect(palette[25]).toBe(3); // IHDR colour type: palette
    const rgba = decodePng(new Uint8Array(palette));
    expect(px(rgba, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(px(rgba, 1, 0)).toEqual([0, 0, 255, 255]);
    const back = decodePng(encodePng(rgba));
    expect(back.width).toBe(2);
    expect(meanAbsDiff(back, rgba)).toBe(0);
  });

  it('areaResize by an integer factor averages exact blocks', () => {
    const img = solid(4, 2, x => (x < 2 ? [0, 0, 0, 255] : [100, 200, 40, 255]));
    const half = areaResize(img, 2, 1);
    expect(px(half, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(px(half, 1, 0)).toEqual([100, 200, 40, 255]);
    const mixed = areaResize(solid(2, 2, (x, y) => [x * 100 + y * 100, 0, 0, 255]), 1, 1);
    expect(px(mixed, 0, 0)[0]).toBe(100);
  });

  it('roll wraps both axes', () => {
    const img = solid(3, 2, (x, y) => [x, y, 0, 255]);
    const r = roll(img, 1, 1);
    expect(px(r, 0, 0)).toEqual([2, 1, 0, 255]);
    expect(px(r, 1, 1)).toEqual([0, 0, 0, 255]);
    expect(meanAbsDiff(roll(roll(img, 2, 1), -2, -1), img)).toBe(0);
  });

  it('luminance uses Rec. 709 weights and meanAbsDiff refuses mismatched sizes', () => {
    expect(luminance(solid(1, 1, () => [255, 255, 255, 255])).data[0]).toBeCloseTo(1, 5);
    expect(luminance(solid(1, 1, () => [0, 255, 0, 255])).data[0]).toBeCloseTo(0.7152, 4);
    expect(() => meanAbsDiff(solid(1, 1, () => [0, 0, 0, 0]), solid(2, 1, () => [0, 0, 0, 0]))).toThrow(/vs/);
  });
});
