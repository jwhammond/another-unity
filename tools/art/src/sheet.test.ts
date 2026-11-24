// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodePng, encodePng, type Rgba } from './image';
import { writeSheet } from './sheet';

function solid(width: number, height: number, rgb: [number, number, number]): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([...rgb, 255], i);
  return encodePng({ width, height, data } as Rgba);
}

describe('writeSheet', () => {
  it('fits cells, keeps aspect, writes captions in the html in order, and escapes them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sheet-'));
    const out = join(dir, 'board');
    await writeSheet(
      [
        [{ png: solid(40, 20, [255, 0, 0]), caption: 'wide <one>' }, { png: solid(10, 40, [0, 255, 0]), caption: 'tall & "two"' }],
        [{ png: solid(20, 20, [0, 0, 255]), caption: 'third' }],
      ],
      out,
      { cell: [40, 40] },
    );
    const img = decodePng(new Uint8Array(readFileSync(`${out}.png`)));
    expect([img.width, img.height]).toEqual([80, 80]);
    const px = (x: number, y: number): number[] => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)];
    // wide cell: full width, letterboxed top and bottom in mid-grey
    expect(px(20, 20)).toEqual([255, 0, 0]);
    expect(px(20, 2)).toEqual([128, 128, 128]);
    // tall cell: full height (10 px wide centred), grey at its left edge
    expect(px(60, 20)).toEqual([0, 255, 0]);
    expect(px(42, 20)).toEqual([128, 128, 128]);
    // the short row leaves its second cell grey
    expect(px(60, 60)).toEqual([128, 128, 128]);
    const html = readFileSync(`${out}.html`, 'utf8');
    const order = ['wide &lt;one&gt;', 'tall &amp; &quot;two&quot;', 'third'].map(c => html.indexOf(c));
    expect(order.every(i => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).not.toContain('<one>');
  });
});
