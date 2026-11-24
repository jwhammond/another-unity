// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IndexedScreen, Palette, writePack } from '../../../../engine/src/view/indexed';
import { renderEngineering, renderHolodeck, toPicture } from './screens';

describe('toPicture', () => {
  it('turns indices into the palette\'s opaque colours', () => {
    const rgb = new Uint8Array(768);
    rgb.set([10, 20, 30], 3);
    rgb.set([200, 100, 50], 6);
    const s = new IndexedScreen(2, 1);
    s.pixels.set([1, 2]);
    const p = toPicture(s, new Palette(rgb));
    expect([p.width, p.height]).toEqual([2, 1]);
    expect(Array.from(p.data)).toEqual([10, 20, 30, 255, 200, 100, 50, 255]);
  });
});

describe('the screens without the art', () => {
  it('give nothing, or fail naming the file, when the game is not here', async () => {
    await expect(renderEngineering('/nonexistent-game-dir')).rejects.toThrow();
    await expect(renderHolodeck('/nonexistent-game-dir')).rejects.toThrow();
  });
});

describe('renderHolodeck', () => {
  it('draws the pack\'s background in the palette, from files on disk, and is null without the published art', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'screens-'));
    mkdirSync(join(dir, 'art/holodeck'), { recursive: true });
    mkdirSync(join(dir, 'art/fonts'), { recursive: true });
    const bg = { width: 640, height: 480, pixels: new Uint8Array(640 * 480).fill(9) };
    writeFileSync(join(dir, 'art/holodeck/holodeck.pack'), writePack([bg, ...Array.from({ length: 31 }, () => ({ width: 2, height: 2, pixels: new Uint8Array(4).fill(1) }))]));
    const pal = new Uint8Array(768);
    pal.set([11, 22, 33], 27);
    writeFileSync(join(dir, 'art/holodeck/palette.rgb'), pal);
    const font = new Uint8Array([1, 1, 0x20, 0x7e, 5, 0, 0, 1, 4, ...Array.from({ length: 0x5f }, () => [4, 1, 1, 1, 1]).flat()]);
    const files = [0, 1, 2, 3].map(i => `art/fonts/font${i}.fon`);
    for (const f of files) writeFileSync(join(dir, f), font);
    const yaml = (art: string) => `movieMap:\n  - stem: a\n    title: Prologue\nart:\n${art}`;
    writeFileSync(join(dir, 'presentation.yaml'), yaml(`  holodeck:\n    pack: art/holodeck/holodeck.pack\n    palette: art/holodeck/palette.rgb\n  fonts:\n    files: [${files.join(', ')}]\n`));
    const pic = (await renderHolodeck(dir))!;
    expect([pic.width, pic.height]).toEqual([640, 480]);
    expect(Array.from(pic.data.subarray(0, 4))).toEqual([11, 22, 33, 255]);
    writeFileSync(join(dir, 'presentation.yaml'), yaml('  fonts:\n    files: []\n'));
    expect(await renderHolodeck(dir)).toBeNull();
  });
});
