// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { AssetIndex } from '../view/assets';
import { writeImagePack } from '../view/imagePack';
import { parsePresentation } from '../view/package';
import { consoleRepaintLoader, type ConsoleRepaintHost } from './consoleRepaint';

const PRESENTATION_TEXT = [
  'art:',
  '  space:',
  '    console: { plate: art/space/console/plate.webp, half: art/space/console/plate.half.webp, pack: art/space/console.pack, scale: 4, areas: { radar: [5, 21, 310, 275], view: [319, 23, 320, 220] } }',
].join('\n');
const PRESENTATION = parsePresentation(PRESENTATION_TEXT);
const files = new AssetIndex([['art/space/console/plate.webp', '/a/plate.webp'], ['art/space/console/plate.half.webp', '/a/plate.half.webp'], ['art/space/console.pack', '/a/console.pack']]);
const pack = writeImagePack([{ name: '7', type: 'image/webp', width: 40, height: 12, bytes: Uint8Array.of(1) }, { name: '115', type: 'image/webp', width: 28, height: 64, bytes: Uint8Array.of(2) }]);

function host(o: Partial<ConsoleRepaintHost> = {}) {
  const decoded: [number, number][] = [];
  const warnings: string[] = [];
  let bumps = 0;
  const h: ConsoleRepaintHost = {
    presentation: () => PRESENTATION, assets: () => files, lowRes: () => false, bump: () => { bumps++; }, warn: m => warnings.push(m),
    fetchBytes: async url => { if (url === '/a/console.pack') return pack; throw new Error(`404 ${url}`); },
    decode: async (_b, _t, size) => { decoded.push(size); return { width: size[0], height: size[1] }; },
    loadPlate: async () => {},
    ...o,
  };
  return { h, decoded, warnings, bumps: () => bumps };
}
const settle = () => new Promise(r => setTimeout(r, 0));

describe('the console\'s repaint (Plan 30 R7)', () => {
  it('loads once, on first use: the plate\'s URL, the pictures by entry at the pack\'s scale, the radar always from the indices', async () => {
    const { h, decoded, bumps } = host();
    const loader = consoleRepaintLoader(h);
    expect(loader.repaint()).toBeNull();
    await settle();
    expect(bumps()).toBe(1);
    const r = loader.repaint()!;
    expect([r.plate, r.scale, [...r.images.keys()], r.opaque]).toEqual(['/a/plate.webp', 4, [7, 115], [[5, 21, 310, 275]]]);
    expect(decoded).toEqual([[40, 12], [28, 64]]);
  });

  it('takes the half plate and halves the pictures at low resolution', async () => {
    const { h, decoded } = host({ lowRes: () => true });
    const loader = consoleRepaintLoader(h);
    loader.repaint();
    await settle();
    expect([loader.repaint()!.plate, loader.repaint()!.scale]).toEqual(['/a/plate.half.webp', 2]);
    expect(decoded).toEqual([[20, 6], [14, 32]]);
  });

  it('frees its pictures and plate, closing each bitmap, and loads them again when asked', async () => {
    const closed: number[] = [];
    let n = 0;
    const { h, decoded } = host({ decode: async (_b, _t, size) => { const id = n++; decoded.push(size); return { width: size[0], height: size[1], close: () => { closed.push(id); } } as never; } });
    const loader = consoleRepaintLoader(h);
    expect(loader.bytes()).toBe(0);
    loader.repaint();
    await settle();
    expect(loader.bytes()).toBe((40 * 12 + 28 * 64) * 4);
    loader.free();
    expect([closed.sort(), loader.bytes()]).toEqual([[0, 1], 0]);
    // (it asks again, and the new load lands)
    expect(loader.repaint()).toBeNull();
    await settle();
    expect(loader.bytes()).toBeGreaterThan(0);
    expect(loader.repaint()).not.toBeNull();
    // (a decode still running when it is freed closes its bitmaps as it lands, and stores none)
    const late: { close(): void }[] = [];
    let release = () => {};
    const gate = new Promise<void>(r => { release = r; });
    const slow = host({ decode: async (_b, _t, size) => { await gate; const b = { width: size[0], height: size[1], close: () => { late.push(b); } }; return b as never; } });
    const l2 = consoleRepaintLoader(slow.h);
    l2.repaint();
    l2.free();
    release();
    await settle();
    expect([late.length, l2.bytes(), slow.bumps()]).toEqual([2, 0, 0]);
  });

  it('is null for good when it isn\'t published, and says once when the pack fails', async () => {
    const none = consoleRepaintLoader(host({ presentation: () => parsePresentation('music: {}\n') }).h);
    expect(none.repaint()).toBeNull();
    const { h, warnings } = host({ fetchBytes: async () => { throw new Error('offline'); } });
    const failing = consoleRepaintLoader(h);
    failing.repaint();
    await settle();
    expect([failing.repaint(), warnings]).toEqual([null, ['combat: the console\'s repaint did not load (offline): it is the original\'s']]);
  });

  it('waits for the plate to decode before it is the repaint, so no cleared pixel shows through a plate still loading', async () => {
    let release!: () => void;
    const plates: string[] = [];
    const { h, bumps } = host({ loadPlate: url => { plates.push(url); return new Promise<void>(r => { release = r; }); } });
    const loader = consoleRepaintLoader(h);
    loader.repaint();
    await settle();
    expect([loader.repaint(), bumps(), plates]).toEqual([null, 0, ['/a/plate.webp']]);
    release();
    await settle();
    expect([loader.repaint()?.plate, bumps()]).toEqual(['/a/plate.webp', 1]);
  });

  it('says once when art.space.console names files the asset index lacks, and asks again of a new presentation', async () => {
    let presentation = PRESENTATION;
    const { h, warnings, bumps } = host({ presentation: () => presentation, assets: () => new AssetIndex([['art/space/console.pack', '/a/console.pack']]) });
    const loader = consoleRepaintLoader(h);
    expect([loader.repaint(), loader.repaint()]).toEqual([null, null]);
    expect(warnings).toEqual(['combat: art.space.console names files the game lacks (art/space/console/plate.webp): the console is the original\'s']);
    presentation = parsePresentation(PRESENTATION_TEXT);
    h.assets = () => files;
    expect(loader.repaint()).toBeNull();
    await settle();
    expect([loader.repaint()?.plate, bumps(), warnings.length]).toEqual(['/a/plate.webp', 1, 1]);
  });
});
