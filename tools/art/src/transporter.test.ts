// SPDX-License-Identifier: GPL-3.0-or-later
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { decodePng } from './image';
import { block, comp, sprite, u32 } from './spritefixture';
import { publishTransporter, TRANSPORTER_AT, TRANSPORTER_SPRITES, transporterMapSprites, transporterSprites } from './transporter';

let tmp = '';
afterEach(() => rm(tmp, { recursive: true, force: true }));

/** An MRG of `n` entries, each 2x1: [index 13 (COLOUR_BLANK, transparent), the entry's number as a colour index (from 1)]. */
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
    bytes[off + 5] = 1 + i;
  }
  return bytes;
}
const standard = new Uint8Array(128 * 3).map((_, i) => i % 64);
// (transp.rm: a 6-bit palette of 128 colours first; colour n is (n, n, n))
const screen = new Uint8Array(640 * 480 + 128 * 3).map((_, i) => (i < 128 * 3 ? Math.floor(i / 3) % 64 : 0));
const copyCodec = { encode: (png: string, out: string) => copyFile(png, out), decode: async (f: string) => decodePng(new Uint8Array(await readFile(f))) };

describe('transporterSprites', () => {
  it('names the console\'s thirteen pictures (the arrows with their grey twins, the kit slot, the lists and map buttons), scaled up nearest-neighbour', () => {
    expect(Object.keys(TRANSPORTER_SPRITES).map(Number)).toEqual([0, 2, 3, 5, 6, 8, 9, 11, 13, 14, 15, 16, 17]);
    expect(TRANSPORTER_SPRITES[2]).toBe('up_grey');
    expect(TRANSPORTER_SPRITES[15]).toBe('lists_on');
    expect(TRANSPORTER_SPRITES[16]).toBe('map');
    expect(TRANSPORTER_SPRITES[17]).toBe('map_on');
    expect(Object.keys(TRANSPORTER_AT).sort()).toEqual(Object.values(TRANSPORTER_SPRITES).sort());
    const s = transporterSprites(fakeMrg(20), screen, standard, 4);
    const kit = s.find(x => x.name === 'kit_slot')!;
    expect([kit.image.width, kit.image.height, kit.width, kit.height]).toEqual([8, 4, 2, 1]);
    // (index 13 is clear; entry 13 is colour index 14, from the screen's own half, 6-bit shifted left by two)
    expect(kit.image.data[3]).toBe(0);
    expect([...kit.image.data.subarray(16, 20)]).toEqual([14 << 2, 14 << 2, 14 << 2, 255]);
  });

  it('draws index 0 (the room palette\'s first colour) and clears only 13', () => {
    const mrg = fakeMrg(20);
    const off = new DataView(mrg.buffer).getUint32(2 + 13 * 4, true);
    mrg[off + 4] = 0;
    const kit = transporterSprites(mrg, screen, standard, 1).find(x => x.name === 'kit_slot')!;
    expect([...kit.image.data.subarray(0, 4)]).toEqual([0, 0, 0, 255]);
  });

  it('refuses an MRG without those entries', () => {
    expect(() => transporterSprites(fakeMrg(15), screen, standard)).toThrow(/entry 15 \(lists_on\)/);
  });
});

describe('publishTransporter', () => {
  it('writes each sprite and records art.transporter: the scale, and each sprite\'s file and rectangle at the original\'s place', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'transporter-test-'));
    const written = await publishTransporter(tmp, fakeMrg(20), screen, standard, copyCodec);
    expect(written).toHaveLength(13);
    expect(existsSync(join(tmp, 'art/transporter/lists_on.webp'))).toBe(true);
    const y = parse(await readFile(join(tmp, 'presentation.yaml'), 'utf8')) as { art: { transporter: { scale: number; sprites: Record<string, { image: string; rect: number[] }> } } };
    expect(y.art.transporter.scale).toBe(4);
    expect(y.art.transporter.sprites.up).toEqual({ image: 'art/transporter/up.webp', rect: [210, 359, 2, 1] });
    expect(y.art.transporter.sprites.right_grey.rect.slice(0, 2)).toEqual([321, 424]);
    expect(y.art.transporter.sprites.kit_slot.rect.slice(0, 2)).toEqual([71, 424]);
  });

  it('keeps the rest of presentation.yaml, and publishes nothing when a WebP does not read back exactly', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'transporter-test-'));
    const bad = { ...copyCodec, decode: async () => ({ width: 8, height: 4, data: new Uint8Array(128).fill(7) }) };
    await expect(publishTransporter(tmp, fakeMrg(20), screen, standard, bad)).rejects.toThrow(/nothing was published/);
    expect(existsSync(join(tmp, 'presentation.yaml'))).toBe(false);
  });
});

/** The map's four sprites, as small as the fixtures go (every picture 2x1): tmaps with three worlds, a blip with two frames after its still one (the second animation). */
function fakeMap() {
  const posn = block('POSN', [...u32(234), ...u32(414)]);
  const tmaps = sprite([posn, comp(), block('PAUS', []), posn, comp(), block('PAUS', []), posn, comp(), block('PAUS', [])], [0, 3, 6]);
  const still = sprite([comp(), block('TIME', u32(466)), block('PAUS', []), block('EXIT', [])], [0]);
  const blip = sprite([comp(), block('TIME', u32(466)), block('PAUS', []), comp(), block('TIME', u32(480)), comp(), block('TIME', u32(480)), block('JUMP', u32(1))], [0, 3]);
  return { tmaps, beamhori: still, beamvert: still, tranblip: blip };
}

describe('transporterMapSprites', () => {
  it('has one picture per world at the map\'s place, the two scan lines where showMap adds them, and the blip\'s frames with their wait', () => {
    const s = transporterMapSprites(fakeMap(), screen, standard, 4);
    expect(s.map(x => x.name)).toEqual(['map_world_0', 'map_world_1', 'map_world_2', 'scan_across', 'scan_down', 'blip_0', 'blip_1']);
    // (bottom centre (234, 414): left is 234 minus half the width, top is 414 minus the height)
    expect(s[0]!.rect).toEqual([233, 413, 2, 1]);
    // (beamhori at (kMapX, kMapTop + 2) and beamvert at (kMapLeft + 1, kMapY))
    expect(s.find(x => x.name === 'scan_across')!.rect).toEqual([233, 298, 2, 1]);
    expect(s.find(x => x.name === 'scan_down')!.rect).toEqual([51, 413, 2, 1]);
    expect(s.find(x => x.name === 'blip_1')!.delayMs).toBe(103);
    expect(s[0]!.image.width).toBe(8);
    // (index 13 clear; colours 5 and 6 are the room's own)
    expect(s[0]!.image.data[3]).toBe(255);
  });
  it('is published with the console\'s, with the blip\'s wait recorded', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'transporter-test-'));
    const written = await publishTransporter(tmp, fakeMrg(20), screen, standard, { ...copyCodec, map: fakeMap() });
    expect(written).toHaveLength(13 + 7);
    const y = parse(await readFile(join(tmp, 'presentation.yaml'), 'utf8')) as { art: { transporter: { blipMs: number; sprites: Record<string, { image: string; rect: number[] }> } } };
    expect(y.art.transporter.blipMs).toBe(103);
    expect(y.art.transporter.sprites.map_world_2).toEqual({ image: 'art/transporter/map_world_2.webp', rect: [233, 413, 2, 1] });
    expect(y.art.transporter.sprites.lists_on.rect.slice(0, 2)).toEqual([7, 300]);
  });
});
