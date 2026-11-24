// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { AssetIndex } from '../view/assets';
import type { PresentationConfig } from '../view/package';
import { astroFontsPort, type AstroFontsHost } from './astroFontsSession';

const font = new Uint8Array([1, 1, 0x20, 0x20, 2, 0, 0, 0, 0, 4, 0]);
function setup(over: Partial<AstroFontsHost> = {}) {
  const log: string[] = [];
  const presentation = { art: { fonts: { files: ['a', 'b', 'c', 'd', 'e', 'f'] }, astro: { scale: 4, palette: 'p', sprites: {} } } } as unknown as PresentationConfig;
  const host: AstroFontsHost = {
    artOn: () => true, presentation: () => presentation,
    assets: () => new AssetIndex([['a', 'ua'], ['b', 'ub'], ['c', 'uc'], ['d', 'ud'], ['e', 'ue'], ['f', 'uf'], ['p', 'up']]),
    bump: () => { log.push('bump'); }, fetchBytes: async url => { log.push(`fetch ${url}`); return url === 'up' ? new Uint8Array(768) : font; }, ...over,
  };
  return { log, port: astroFontsPort(host) };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('astrogation\'s fonts port', () => {
  it('loads the fonts and the palette on first use, once, tells the panels, and then has them', async () => {
    const { port, log } = setup();
    expect(port.astroFonts()).toBeNull();
    expect(port.astroFonts()).toBeNull();
    await flush();
    expect(log.filter(l => l.startsWith('fetch'))).toHaveLength(6);
    expect(log).toContain('bump');
    expect(port.astroFonts()!.fonts).toHaveLength(5);
  });
  it('does not load them with the art off', async () => {
    const { port, log } = setup({ artOn: () => false });
    expect(port.astroFonts()).toBeNull();
    await flush();
    expect(log).toEqual([]);
  });
  it('stays without, with a warning, when a fetch fails', async () => {
    const { port } = setup({ fetchBytes: async () => { throw new Error('offline'); } });
    expect(port.astroFonts()).toBeNull();
    await flush();
    expect(port.astroFonts()).toBeNull();
  });
});
