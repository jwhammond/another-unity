// SPDX-License-Identifier: GPL-3.0-or-later
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { decodePng } from './image';
import { block, comp, sprite } from './spritefixture';
import { publishTricorder, TRICORDER_BUTTONS, tricorderSprites } from './tricorder';

let tmp = '';
afterEach(() => rm(tmp, { recursive: true, force: true }));

/** tricord.spr: the frame is the first animation's one picture (2x1, colours 5 and 6). */
const spr = sprite([comp(), block('EXIT', [])], [0]);
/** An MRG of `n` entries, each 2x1: [index 13 (COLOUR_BLANK, clear), 128 + entry]. */
function fakeMrg(n: number): Uint8Array {
  const header = 2 + n * 4;
  const bytes = new Uint8Array(header + n * 6);
  const dv = new DataView(bytes.buffer);
  dv.setUint16(0, n, true);
  for (let i = 0; i < n; i++) {
    const off = header + i * 6;
    dv.setUint32(2 + i * 4, off, true);
    dv.setUint16(off, 2, true);
    dv.setUint16(off + 2, 1, true);
    bytes[off + 4] = 13;
    bytes[off + 5] = 128 + i;
  }
  return bytes;
}
const pal = new Uint8Array(128 * 3).map((_, i) => i % 64);
const copyCodec = { encode: (png: string, out: string) => copyFile(png, out), decode: async (f: string) => decodePng(new Uint8Array(await readFile(f))) };

describe('tricorderSprites', () => {
  it('has the frame, then each button with its greyed and lit twins, scaled up 4x; index 13 is clear', () => {
    const s = tricorderSprites(spr, fakeMrg(16), pal);
    expect(s.map(x => x.name)).toEqual(['frame', ...Object.values(TRICORDER_BUTTONS)]);
    expect(Object.values(TRICORDER_BUTTONS)).toEqual(expect.arrayContaining(['page_up_off', 'prev_hover', 'next', 'resume_hover']));
    const frame = s[0]!;
    expect([frame.image.width, frame.image.height, frame.width, frame.height]).toEqual([8, 4, 2, 1]);
    // (colours 5 and 6 are the room's half, which the frame doesn't use: black, but drawn)
    expect(frame.image.data[3]).toBe(255);
    const hover = s.find(x => x.name === 'resume_hover')!;
    // (the left half is index 13, clear; the right half the entry's colour from standard.pal)
    expect(hover.image.data[3]).toBe(0);
    expect([...hover.image.data.subarray(16, 20)]).toEqual([...[15 * 3, 15 * 3 + 1, 15 * 3 + 2].map(v => (v % 64) << 2), 255]);
  });
  it('refuses an MRG without the buttons', () => {
    expect(() => tricorderSprites(spr, fakeMrg(15), pal)).toThrow(/entry 15 \(resume_hover\)/);
  });
});

describe('publishTricorder', () => {
  it('writes each picture and records art.tricorder: the scale and the pictures by name', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'tricorder-test-'));
    const written = await publishTricorder(tmp, spr, fakeMrg(16), pal, copyCodec);
    expect(written).toHaveLength(1 + 16);
    expect(existsSync(join(tmp, 'art/tricorder/frame.webp'))).toBe(true);
    const y = parse(await readFile(join(tmp, 'presentation.yaml'), 'utf8')) as { art: { tricorder: { scale: number; sprites: Record<string, string> } } };
    expect(y.art.tricorder.scale).toBe(4);
    expect(y.art.tricorder.sprites.frame).toBe('art/tricorder/frame.webp');
    expect(y.art.tricorder.sprites.prev_off).toBe('art/tricorder/prev_off.webp');
  });
  it('publishes nothing when a WebP does not read back exactly', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'tricorder-test-'));
    const bad = { ...copyCodec, decode: async () => ({ width: 8, height: 4, data: new Uint8Array(128).fill(7) }) };
    await expect(publishTricorder(tmp, spr, fakeMrg(16), pal, bad)).rejects.toThrow(/nothing was published/);
    expect(existsSync(join(tmp, 'presentation.yaml'))).toBe(false);
    expect(existsSync(join(tmp, 'art/tricorder/frame.webp'))).toBe(false);
  });
});
