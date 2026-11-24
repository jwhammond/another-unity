// SPDX-License-Identifier: GPL-3.0-or-later
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { decodePng } from './image';
import { CURSOR_FRAMES, CURSOR_HOTSPOTS, cursorSprites, parseCursors, publishCursors } from './cursors';

let tmp = '';
afterEach(() => rm(tmp, { recursive: true, force: true }));

/** A cursor.dat of `n` frames, each 2x1: [index 13 (clear), 128 + frame]. */
function fakeDat(n: number): Uint8Array {
  const bytes = new Uint8Array(n * 6);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < n; i++) {
    dv.setUint16(i * 6, 2, true);
    dv.setUint16(i * 6 + 2, 1, true);
    bytes[i * 6 + 4] = 13;
    bytes[i * 6 + 5] = 128 + i;
  }
  return bytes;
}
const pal = new Uint8Array(128 * 3).map((_, i) => i % 64);
const copyCodec = { encode: (png: string, out: string) => copyFile(png, out), decode: async (f: string) => decodePng(new Uint8Array(await readFile(f))) };

describe('parseCursors', () => {
  it('reads the run of frames, each its own size', () => {
    const dat = new Uint8Array([2, 0, 1, 0, 5, 6, 1, 0, 2, 0, 7, 8]);
    expect(parseCursors(dat).map(f => [f.width, f.height, [...f.pixels]])).toEqual([[2, 1, [5, 6]], [1, 2, [7, 8]]]);
  });
  it('refuses a frame that runs past the end', () => {
    expect(() => parseCursors(new Uint8Array([4, 0, 4, 0, 1, 2]))).toThrow(/runs past the end/);
  });
});

describe('cursorSprites', () => {
  it('names the verbs, each with its lit frame after it, and the four exit arrows; index 13 is clear, the rest from standard.pal, scaled up 4x', () => {
    expect(Object.values(CURSOR_FRAMES)).toEqual(['look', 'look_lit', 'use', 'use_lit', 'talk', 'talk_lit', 'walk', 'walk_lit', 'exit_down', 'exit_left', 'exit_right', 'exit_up']);
    expect(Object.keys(CURSOR_HOTSPOTS)).toEqual(['look', 'use', 'talk', 'walk']);
    const s = cursorSprites(fakeDat(12), pal);
    const lit = s.find(x => x.name === 'look_lit')!;
    expect([lit.image.width, lit.image.height, lit.width, lit.height]).toEqual([8, 4, 2, 1]);
    // (the left half is index 13: clear; the right half is the second frame's colour)
    expect(lit.image.data[3]).toBe(0);
    expect([...lit.image.data.subarray(16, 20)]).toEqual([...[3, 4, 5].map(v => (v % 64) << 2), 255]);
  });
  it('refuses a file without all twelve frames', () => {
    expect(() => cursorSprites(fakeDat(11), pal)).toThrow(/no frame 11 \(exit_up\)/);
  });
});

describe('publishCursors', () => {
  it('writes each picture and records art.cursors: the scale, the pictures and the click points', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'cursors-test-'));
    const written = await publishCursors(tmp, fakeDat(12), pal, copyCodec);
    expect(written).toHaveLength(12);
    expect(existsSync(join(tmp, 'art/cursors/walk_lit.webp'))).toBe(true);
    const y = parse(await readFile(join(tmp, 'presentation.yaml'), 'utf8')) as { art: { cursors: { scale: number; sprites: Record<string, string>; hotspots: Record<string, number[]> } } };
    expect(y.art.cursors.scale).toBe(4);
    expect(y.art.cursors.sprites.look_lit).toBe('art/cursors/look_lit.webp');
    expect(y.art.cursors.hotspots.walk).toEqual([33, 22]);
  });
  it('publishes nothing when a WebP does not read back exactly', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'cursors-test-'));
    const bad = { ...copyCodec, decode: async () => ({ width: 8, height: 4, data: new Uint8Array(128).fill(7) }) };
    await expect(publishCursors(tmp, fakeDat(12), pal, bad)).rejects.toThrow(/nothing was published/);
    expect(existsSync(join(tmp, 'presentation.yaml'))).toBe(false);
    expect(existsSync(join(tmp, 'art/cursors/look.webp'))).toBe(false);
  });
});
