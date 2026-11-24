// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { AssetIndex } from '../view/assets';
import { writePack } from '../view/indexed';
import type { PresentationConfig } from '../view/package';
import { holodeckPort, type HolodeckHost } from './holodeckSession';

const font = new Uint8Array([1, 1, 0x20, 0x7e, 5, 0, 0, 1, 4, ...Array.from({ length: 0x5f }, () => [4, 1, 1, 1, 1]).flat()]);
function setup(over: Partial<HolodeckHost> = {}) {
  const log: string[] = [];
  const bytes: Record<string, Uint8Array> = {
    pack: writePack([{ width: 640, height: 480, pixels: new Uint8Array(640 * 480) }, ...Array.from({ length: 31 }, () => ({ width: 1, height: 1, pixels: new Uint8Array(1) }))]),
    pal: new Uint8Array(768), f: font,
  };
  const presentation = { art: { holodeck: { pack: 'h.pack', palette: 'h.pal' }, fonts: { files: ['a', 'b', 'c', 'd'] } } } as unknown as PresentationConfig;
  const host: HolodeckHost = {
    artOn: () => true, presentation: () => presentation, assets: () => new AssetIndex([['h.pack', 'pack'], ['h.pal', 'pal'], ['a', 'f'], ['b', 'f'], ['c', 'f'], ['d', 'f']]),
    bump: () => { log.push('bump'); }, fetchBytes: async url => { log.push(`fetch ${url}`); return bytes[url]!; }, ...over,
  };
  return { log, port: holodeckPort(host) };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('the holodeck\'s port', () => {
  it('loads the pictures on first use, once, tells the panels, and then has them', async () => {
    const { port, log } = setup();
    expect(port.holodeckArt()).toBeNull();
    expect(port.holodeckArt()).toBeNull();
    await flush();
    expect(log.filter(l => l.startsWith('fetch'))).toHaveLength(4);
    expect(log).toContain('bump');
    expect(port.holodeckArt()!.frames).toHaveLength(31);
  });
  it('does not load them with the art off', async () => {
    const { port, log } = setup({ artOn: () => false });
    expect(port.holodeckArt()).toBeNull();
    await flush();
    expect(log).toEqual([]);
  });
  it('stays plain, with a warning, when a fetch fails', async () => {
    const { port } = setup({ fetchBytes: async () => { throw new Error('offline'); } });
    expect(port.holodeckArt()).toBeNull();
    await flush();
    expect(port.holodeckArt()).toBeNull();
  });
});
