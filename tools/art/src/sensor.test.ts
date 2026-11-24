// SPDX-License-Identifier: GPL-3.0-or-later
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { decodePng } from './image';
import { publishSensor, SENSOR_AT, SENSOR_SPRITES, sensorSprites } from './sensor';

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
const screen = new Uint8Array(640 * 480 + 128 * 3).map((_, i) => (i < 128 * 3 ? Math.floor(i / 3) % 64 : 0));
const copyCodec = { encode: (png: string, out: string) => copyFile(png, out), decode: async (f: string) => decodePng(new Uint8Array(await readFile(f))) };

describe('sensorSprites', () => {
  it('names entry 3 the button up and entry 1 the button down, scaled up nearest-neighbour, index 13 clear', () => {
    expect(SENSOR_SPRITES).toEqual({ 3: 'viewscreen', 1: 'viewscreenDown' });
    const s = sensorSprites(fakeMrg(4), screen, standard, 4);
    const up = s.find(x => x.name === 'viewscreen')!;
    expect([up.image.width, up.image.height, up.width, up.height]).toEqual([8, 4, 2, 1]);
    expect(up.image.data[3]).toBe(0);
    // (entry 3 is colour index 4, from the screen's own half, 6-bit shifted left by two)
    expect([...up.image.data.subarray(16, 20)]).toEqual([4 << 2, 4 << 2, 4 << 2, 255]);
    expect(s.find(x => x.name === 'viewscreenDown')!.image.data[19]).toBe(255);
  });

  it('refuses an MRG without those entries', () => {
    expect(() => sensorSprites(fakeMrg(3), screen, standard)).toThrow(/entry 3 \(viewscreen\)/);
  });
});

describe('publishSensor', () => {
  it('writes both buttons and records art.sensor: the scale and each one\'s file and rectangle at the original\'s place', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'sensor-test-'));
    const written = await publishSensor(tmp, fakeMrg(4), screen, standard, copyCodec);
    expect([...written].sort()).toEqual(['art/sensor/viewscreen.webp', 'art/sensor/viewscreenDown.webp']);
    expect(existsSync(join(tmp, 'art/sensor/viewscreenDown.webp'))).toBe(true);
    const y = parse(await readFile(join(tmp, 'presentation.yaml'), 'utf8')) as { art: { sensor: { scale: number; sprites: Record<string, { image: string; rect: number[] }> } } };
    expect(y.art.sensor.scale).toBe(4);
    expect(y.art.sensor.sprites.viewscreen).toEqual({ image: 'art/sensor/viewscreen.webp', rect: [...SENSOR_AT, 2, 1] });
    expect(SENSOR_AT).toEqual([484, 426]);
  });

  it('publishes nothing when a WebP does not read back exactly', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'sensor-test-'));
    const bad = { ...copyCodec, decode: async () => ({ width: 8, height: 4, data: new Uint8Array(128).fill(7) }) };
    await expect(publishSensor(tmp, fakeMrg(4), screen, standard, bad)).rejects.toThrow(/nothing was published/);
    expect(existsSync(join(tmp, 'presentation.yaml'))).toBe(false);
    expect(existsSync(join(tmp, 'art/sensor/viewscreen.webp'))).toBe(false);
  });
});
