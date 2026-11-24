// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { AssetIndex } from '../view/assets';
import type { World } from '../sim/world';
import { hailStill, viewscreenImage, viewSheet } from './viewscreenImage';

const hails = { viewpent: { image: 'art/ship/view/viewpent.still.webp', scale: 4, at: [319, 311] as [number, number] } };

describe('hailStill', () => {
  it('finds the still of a caller that has one, from the asset index', () => {
    const assets = new AssetIndex([['art/ship/view/viewpent.still.webp', '/still.webp']]);
    expect(hailStill(hails, 'viewpent', assets)).toEqual({ url: '/still.webp', scale: 4, at: [319, 311] });
  });

  it('falls back to the sprite for every other caller, with no entries (art off), or with a still that was not published', () => {
    const assets = new AssetIndex([['art/ship/view/viewpent.still.webp', '/still.webp']]);
    expect(hailStill(hails, 'viewfere', assets)).toBeUndefined();
    expect(hailStill(undefined, 'viewpent', assets)).toBeUndefined();
    expect(hailStill(hails, 'viewpent', new AssetIndex())).toBeUndefined();
  });
});

describe('viewSheet', () => {
  // (a synthetic view: animation 0 one frame that falls into animation 1, a 2-frame loop at twice the sprite's pixels on two pages)
  const c0: [number, number, number, number, number, number, number] = [0, 0, 0, 8, 4, 0, 0];
  const c1: [number, number, number, number, number, number, number] = [1, 0, 0, 16, 8, 0, 0];
  const views = {
    vwtest: {
      0: { images: ['art/ship/view/vwtest.0.0.webp'], pages: [[8, 4]] as [number, number][], cells: [c0], frames: 1, scale: 1, cell: [8, 4] as [number, number], anchor: [0.5, 1] as [number, number], delays: [200], loop: false, next: 1 },
      1: { images: ['art/ship/view/vwtest.1.0.webp', 'art/ship/view/vwtest.1.1.webp'], pages: [[16, 8], [16, 8]] as [number, number][], cells: [[0, 0, 0, 16, 8, 0, 0], c1] as typeof c0[], frames: 2, scale: 2, cell: [16, 8] as [number, number], anchor: [0.25, 0.5] as [number, number], delays: [50, 50], loop: true },
    },
  };

  it('finds a view\'s sheets by animation, from the asset index, each cell in the sprite\'s own pixels', () => {
    const assets = new AssetIndex([['art/ship/view/vwtest.0.0.webp', '/0.webp'], ['art/ship/view/vwtest.1.0.webp', '/1a.webp'], ['art/ship/view/vwtest.1.1.webp', '/1b.webp']]);
    expect(viewSheet(views, 'vwtest', assets)).toEqual({
      urls: { 0: ['/0.webp'], 1: ['/1a.webp', '/1b.webp'] },
      strips: {
        0: { frames: 1, cell: [8, 4], pages: [[8, 4]], cells: [c0], delays: [200], loop: false, next: 1, rect: [0, 0, 8, 4], anchor: [0.5, 1] },
        1: { frames: 2, cell: [16, 8], pages: [[16, 8], [16, 8]], cells: [[0, 0, 0, 16, 8, 0, 0], c1], delays: [50, 50], loop: true, rect: [0, 0, 8, 4], anchor: [0.25, 0.5] },
      },
    });
  });

  it('has none for another sprite, with no entries, or without all of animation 0\'s pages (the first frame shows then)', () => {
    const assets = new AssetIndex([['art/ship/view/vwtest.1.0.webp', '/1a.webp'], ['art/ship/view/vwtest.1.1.webp', '/1b.webp']]);
    expect(viewSheet(views, 'vwother', assets)).toBeUndefined();
    expect(viewSheet(undefined, 'vwtest', assets)).toBeUndefined();
    expect(viewSheet(views, 'vwtest', assets)).toBeUndefined();
  });
});

describe('viewscreenImage, in transit', () => {
  const world = (viewscreen: { target: string | null; caller?: string } | null): World => ({
    state: { ship: { transit: { warp: true }, location: { sector: -1, star: -1, planet: -1 } }, objects: { 'w.ent': { anim: 774 } } },
    content: { ship: { data: { astro: { enterprise: 'w.ent' }, contacts: { comms: [{ object: 'o.caller', file: 'viewdenu' }] }, viewscreenSprites: { 774: 'vwsttrac' } } } },
    viewscreen,
  }) as unknown as World;

  it('shows a hailing caller\'s sprite over the warp, named by the hail or by whoever replies', () => {
    expect(viewscreenImage(world({ target: 'o.caller' }), true)).toEqual({ kind: 'sprite', sprite: 'viewdenu' });
    expect(viewscreenImage(world({ target: null, caller: 'o.caller' }), true)).toEqual({ kind: 'sprite', sprite: 'viewdenu' });
  });

  it('shows the warp when nobody with a sprite is on the line', () => {
    expect(viewscreenImage(world({ target: null }), true)).toEqual({ kind: 'warp' });
    expect(viewscreenImage(world(null), false)).toEqual({ kind: 'warp' });
  });
});

describe('viewscreenImage, the Enterprise\'s own view (unity.cpp:604-610)', () => {
  const world = (anim: number | undefined, transit: { warp: boolean } | null = null, sector = 3): World => ({
    state: {
      ship: { transit, location: { sector, star: 0, planet: 0 } },
      objects: { 'w.ent': anim === undefined ? {} : { anim } },
    },
    content: { ship: { data: { astro: { enterprise: 'w.ent' }, contacts: { comms: [] }, viewscreenSprites: { 774: 'vwsttrac' } } } },
    viewscreen: null,
  }) as unknown as World;

  it('shows the sprite the Enterprise\'s animation names, before the location', () => {
    expect(viewscreenImage(world(774), false)).toEqual({ kind: 'sprite', sprite: 'vwsttrac' });
    expect(viewscreenImage(world(774, null, -1), false)).toEqual({ kind: 'sprite', sprite: 'vwsttrac' });
  });

  it('shows the place with no animation, a stopped one, or one with no sprite in the table', () => {
    for (const anim of [undefined, -1, -2, 0xffff, 0xfffe, 5]) expect(viewscreenImage(world(anim, null, -1), false)).toEqual({ kind: 'space' });
  });

  it('shows the journey in transit, whatever the Enterprise\'s animation', () => {
    expect(viewscreenImage(world(774, { warp: false }), false)).toEqual({ kind: 'space' });
    expect(viewscreenImage(world(774, { warp: true }), false)).toEqual({ kind: 'warp' });
  });

  it('shows a hailing caller over the Enterprise\'s view', () => {
    const w = world(774);
    (w.content.ship!.data.contacts.comms as unknown[]).push({ object: 'o.caller', sprite: true, file: 'viewdenu' });
    (w as { viewscreen: unknown }).viewscreen = { target: 'o.caller' };
    expect(viewscreenImage(w, true)).toEqual({ kind: 'sprite', sprite: 'viewdenu' });
  });
});
