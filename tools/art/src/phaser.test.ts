// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { phaserTable, publishPhaser } from './phaser';

let tmp = '';
afterEach(() => rm(tmp, { recursive: true, force: true }));

const muzzles = Array.from({ length: 120 }, (_, i) => ({ x: i, y: 2 * i, frame: i % 9 }));
const objects = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`00000${i}`, `crew${i}`]));
// (standard.pal: 6-bit colours, 3 bytes each, the standard half of the 256-colour palette)
const pal = new Uint8Array(128 * 3);
pal.set([63, 0, 0], (0xcd - 128) * 3);
pal.set([0, 63, 0], (0xa6 - 128) * 3);
pal.set([0, 0, 63], (0xa5 - 128) * 3);
pal.set([10, 20, 30], (0xa7 - 128) * 3);

describe('phaserTable', () => {
  it("takes the first ten crew's twelve muzzles, the crew by their ids, and the four beam colours from the standard palette (6 bit, shifted by 2)", () => {
    const t = phaserTable(muzzles, objects, pal);
    expect(t.muzzles).toHaveLength(120);
    expect(t.muzzles[13]).toEqual([13, 26, 4]);
    expect(t.crew).toEqual(['crew0', 'crew1', 'crew2', 'crew3', 'crew4', 'crew5', 'crew6', 'crew7', 'crew8', 'crew9']);
    expect(t.colours).toEqual({ beam: '#fc0000', beamEdge: '#00fc00', pulse: '#0000fc', pulseEdge: '#285078' });
  });

  it('refuses a table that is short or a crew the ids lack', () => {
    expect(() => phaserTable(muzzles.slice(0, 5), objects, pal)).toThrow('need 120');
    expect(() => phaserTable(muzzles, { '000000': 'a' }, pal)).toThrow('no object 000001');
  });
});

describe('publishPhaser', () => {
  it('sets art.phaser and keeps the file\'s header and other keys', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'phaser-'));
    await writeFile(join(tmp, 'presentation.yaml'), '# header\nmusic:\n  w: a\nart:\n  rooms:\n    w.s01:\n      plate: art/p.png\n');
    await publishPhaser(tmp, phaserTable(muzzles, objects, pal));
    const text = await readFile(join(tmp, 'presentation.yaml'), 'utf8');
    expect(text.startsWith('# header')).toBe(true);
    const doc = parse(text);
    expect(doc.music).toEqual({ w: 'a' });
    expect(doc.art.rooms['w.s01']).toEqual({ plate: 'art/p.png' });
    expect(doc.art.phaser.muzzles).toHaveLength(120);
    expect(doc.art.phaser.colours.beam).toBe('#fc0000');
  });
});
