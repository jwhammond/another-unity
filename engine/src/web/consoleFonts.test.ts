// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { AssetIndex } from '../view/assets';
import type { PresentationConfig } from '../view/package';
import { consoleFontsLoader, type ConsoleFontsHost } from './consoleFonts';

/** A one-glyph one-bit font file (a space, 2 wide). */
const font = new Uint8Array([1, 1, 0x20, 0x20, 1, 0, 0, 0, 0, 2, 0]);
function setup(files: string[] | null, over: Partial<ConsoleFontsHost> = {}) {
  const log: string[] = [];
  const presentation = { art: files ? { fonts: { files } } : {} } as unknown as PresentationConfig;
  const host: ConsoleFontsHost = {
    presentation: () => presentation, assets: () => new AssetIndex([['a', 'ua'], ['b', 'ub'], ['c', 'uc'], ['d', 'ud']]),
    bump: () => { log.push('bump'); }, warn: m => { log.push(`warn ${m}`); },
    fetchBytes: async url => { log.push(`fetch ${url}`); return font; }, ...over,
  };
  return { log, loader: consoleFontsLoader(host) };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('the console\'s fonts (Plan 27 R14)', () => {
  it('loads the first three of art.fonts on first use, once, whatever the art setting, and tells the panels', async () => {
    const { loader, log } = setup(['a', 'b', 'c', 'd']);
    expect([loader.settled(), loader.fonts(), loader.fonts(), loader.settled()]).toEqual([false, null, null, false]);
    await flush();
    expect(log).toEqual(['fetch ua', 'fetch ub', 'fetch uc', 'bump']);
    expect([loader.fonts()!.map(f => f.charWidth(0x20)), loader.settled()]).toEqual([[2, 2, 2], true]);
  });

  it('says once that the fonts aren\'t published, and draws without them for good', async () => {
    const none = setup(null);
    expect([none.loader.fonts(), none.loader.fonts(), none.loader.settled()]).toEqual([null, null, true]);
    expect(none.log.filter(l => l.startsWith('warn')).length).toBe(1);
    const missing = setup(['a', 'b', 'zz']);
    expect(missing.loader.fonts()).toBeNull();
    expect(missing.log.filter(l => l.startsWith('fetch'))).toEqual([]);
    const failing = setup(['a', 'b', 'c'], { fetchBytes: async () => { throw new Error('offline'); } });
    expect(failing.loader.fonts()).toBeNull();
    await flush();
    expect([failing.loader.fonts(), failing.log.filter(l => l.includes('offline')).length, failing.loader.settled()]).toEqual([null, 1, true]);
  });
});
