// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { makeMrg, makePic } from '../testing/space-files';
import { decodeMrg, decodePic } from './stills';

describe('decodePic (Graphics::setBackgroundImage, graphics.cpp:311-342)', () => {
  it('reads the 256 6-bit colours, shifted left by two, and the 640x480 indices', () => {
    // (entry 1 is 6-bit (63, 32, 1): 8-bit (252, 128, 4))
    const palette = new Uint8Array(768);
    palette.set([63, 32, 1], 3);
    const pic = decodePic(makePic(palette, 7, [1, 2, 3]))!;
    expect([...pic.palette.subarray(3, 6)]).toEqual([252, 128, 4]);
    expect(pic.image).toMatchObject({ width: 640, height: 480 });
    expect(pic.image.pixels).toHaveLength(640 * 480);
    expect([...pic.image.pixels.subarray(0, 4)]).toEqual([1, 2, 3, 7]);
    expect(pic.image.pixels[640 * 480 - 1]).toBe(7);
  });

  it('refuses a file too short to hold the picture', () => {
    expect(decodePic(new Uint8Array(768 + 640 * 480 - 1))).toBeNull();
  });
});

describe('decodeMrg (Graphics::loadMRG, graphics.cpp:262-286)', () => {
  it('reads each entry at its offset, with its own size', () => {
    const mrg = decodeMrg(makeMrg([{ width: 2, height: 1, pixels: [5, 6] }, { width: 1, height: 3, pixels: [245, 13, 255] }]))!;
    expect(mrg.map(e => [e.width, e.height, [...e.pixels]])).toEqual([[2, 1, [5, 6]], [1, 3, [245, 13, 255]]]);
  });

  it('refuses an entry that runs past the end of the file', () => {
    const whole = makeMrg([{ width: 4, height: 4, pixels: new Array(16).fill(1) }]);
    expect(decodeMrg(whole.subarray(0, whole.length - 1))).toBeNull();
    expect(decodeMrg(new Uint8Array(1))).toBeNull();
  });
});
