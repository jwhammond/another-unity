// SPDX-License-Identifier: GPL-3.0-or-later
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { decodePng } from './image';
import { palHex, PANEL_SPRITES, panelSprites, publishPanel } from './panel';

let tmp = '';
afterEach(() => rm(tmp, { recursive: true, force: true }));

/** An MRG of `n` entries, each 2x1: [index 13 (COLOUR_BLANK, transparent), 128 + entry]. */
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

describe('panelSprites', () => {
  it('colours each named entry from standard.pal, index 13 clear, scaled up nearest-neighbour', () => {
    const s = panelSprites(fakeMrg(24), pal, 4);
    expect(s.map(x => x.name)).toEqual(Object.values(PANEL_SPRITES));
    const look = s.find(x => x.name === 'look')!;
    expect([look.image.width, look.image.height, look.width, look.height]).toEqual([8, 4, 2, 1]);
    // the left half (index 13) is transparent, the right half the 13th standard colour, every one of its 4x4 pixels
    expect(look.image.data[3]).toBe(0);
    const at = (x: number, y: number) => [...look.image.data.subarray((y * 8 + x) * 4, (y * 8 + x) * 4 + 4)];
    expect(at(4, 0)).toEqual([...[13 * 3, 13 * 3 + 1, 13 * 3 + 2].map(v => (v % 64) << 2), 255]);
    expect(at(7, 3)).toEqual(at(4, 0));
  });
  it('draws index 0 (black in the original) and clears only 13', () => {
    const mrg = fakeMrg(24);
    const off = new DataView(mrg.buffer).getUint32(2 + 13 * 4, true);
    mrg[off + 4] = 0; // entry 13 ('look'): [0, 141]
    const look = panelSprites(mrg, pal, 1).find(x => x.name === 'look')!;
    expect([...look.image.data.subarray(0, 4)]).toEqual([0, 0, 0, 255]);
  });
  it('refuses an MRG without the panel\'s entries', () => {
    expect(() => panelSprites(fakeMrg(5), pal)).toThrow(/entry 5 \(marker2\)/);
  });
});

describe('palHex', () => {
  it('reads the 6-bit standard half', () => {
    expect(palHex(pal, 128)).toBe('#000408');
    expect(() => palHex(pal, 2)).toThrow();
  });
});

describe('publishPanel', () => {
  it('writes each sprite and records art.panel: scale, sprites and colours', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'panel-test-'));
    const written = await publishPanel(tmp, fakeMrg(24), pal, copyCodec);
    expect(written).toContain('art/panel/panel.webp');
    expect(existsSync(join(tmp, 'art/panel/use_on.webp'))).toBe(true);
    const y = parse(await readFile(join(tmp, 'presentation.yaml'), 'utf8')) as { art: { panel: { scale: number; sprites: Record<string, string>; colours: Record<string, string> } } };
    expect(y.art.panel.scale).toBe(4);
    expect(y.art.panel.sprites.marker2).toBe('art/panel/marker2.webp');
    expect(y.art.panel.colours.healthy).toMatch(/^#[0-9a-f]{6}$/);
  });
  it('publishes nothing when a WebP does not read back exactly', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'panel-test-'));
    const bad = { ...copyCodec, decode: async () => ({ width: 8, height: 4, data: new Uint8Array(128).fill(7) }) };
    await expect(publishPanel(tmp, fakeMrg(24), pal, bad)).rejects.toThrow(/nothing was published/);
    expect(existsSync(join(tmp, 'presentation.yaml'))).toBe(false);
    expect(existsSync(join(tmp, 'art/panel/panel.webp'))).toBe(false);
  });
});
