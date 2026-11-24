// SPDX-License-Identifier: GPL-3.0-or-later
import { DataTexture, Mesh, Texture, type MeshBasicMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import type { BattleAssets, LoadedSprite } from './assets';
import type { SpriteEntry } from './files';
import { spriteWait, WARP_SPRITES, warpLayerAt, warpOverlayAt } from './warp';
import { WarpOverlay } from './warpOverlay';

/** Made-up sprites shaped as showWarp's: a static loop of two frames, one masked picture that pauses, a masked build-up of three that loops. */
const frame = (n: number, width: number, height: number): SpriteEntry => ({ type: 'sprite', width, height, frame: n });
const SCAN: SpriteEntry[] = [{ type: 'static' }, frame(0, 120, 24), { type: 'position', x: 318, y: 339 }, { type: 'wait', wait: 777 }, frame(1, 120, 24), { type: 'wait', wait: 777 }, { type: 'jump', target: 0 }, { type: 'exit' }];
const SCREEN: SpriteEntry[] = [{ type: 'mask' }, frame(0, 640, 364), { type: 'position', x: 320, y: 364 }, { type: 'pause' }, { type: 'exit' }];
const WARPED: SpriteEntry[] = [
  { type: 'mask' }, frame(0, 520, 248), { type: 'position', x: 320, y: 313 }, { type: 'wait', wait: 400 }, frame(1, 520, 248), { type: 'wait', wait: 400 },
  frame(2, 520, 248), { type: 'wait', wait: 400 }, { type: 'jump', target: 0 }, { type: 'pause' }, { type: 'exit' },
];
const sheet = (entries: SpriteEntry[], cell: [number, number], frames: number, palette = 'cheap'): LoadedSprite => ({ entries, cell, frames, columns: frames, palette, texture: new Texture() });

describe('the warp overlay\'s sprites (SpritePlayer::update, sprite_player.cpp:241-438; showWarp, tactical.cpp:818-854)', () => {
  it('waits in sixteenths of the original\'s 291.3-a-second ticks', () => {
    // (400 >> 4 = 25 ticks, 85.8 ms; 777 >> 4 = 48, 164.8 ms: truncated, as the C does)
    expect([spriteWait(400), spriteWait(777)]).toEqual([85, 164]);
  });

  it('builds a masked sprite\'s frames up on its canvas, a wait apart, until it jumps back to its mask, which clears it', () => {
    const s = { entries: WARPED, cell: [520, 248] as [number, number] };
    // (at its position less half its width and its height: 320 - 260, 313 - 248)
    expect(warpLayerAt(s, 'w', 0)).toEqual({ file: 'w', frames: [0], left: 60, top: 65 });
    expect(warpLayerAt(s, 'w', 85)!.frames).toEqual([0]);
    expect(warpLayerAt(s, 'w', 86)!.frames).toEqual([0, 1]);
    expect(warpLayerAt(s, 'w', 255)!.frames).toEqual([0, 1, 2]);
    expect(warpLayerAt(s, 'w', 256)!.frames).toEqual([0]);
  });

  it('shows a static sprite\'s current frame alone, and holds a paused one', () => {
    const scan = { entries: SCAN, cell: [120, 24] as [number, number] };
    expect([0, 165, 329].map(ms => warpLayerAt(scan, 's', ms))).toEqual([
      { file: 's', frames: [0], left: 258, top: 315 }, { file: 's', frames: [1], left: 258, top: 315 }, { file: 's', frames: [0], left: 258, top: 315 },
    ]);
    expect(warpLayerAt({ entries: SCREEN, cell: [640, 364] }, 'v', 5000)).toEqual({ file: 'v', frames: [0], left: 0, top: 0 });
  });

  it('draws in Common::sort\'s order: viewscan, then vwwarped, then viewscr on top (their depths -2000, -1500, -1500, a tie its quicksort turns over)', () => {
    expect(WARP_SPRITES.map(w => w.file)).toEqual(['viewscan.spr', 'viewscr.spr', 'vwwarped.spr']);
    const sheets = new Map([['vwwarped.spr', sheet(WARPED, [520, 248], 3)], ['viewscan.spr', sheet(SCAN, [120, 24], 2)], ['viewscr.spr', sheet(SCREEN, [640, 364], 1)]]);
    expect(warpOverlayAt(sheets, 0).map(l => l.file)).toEqual(['viewscan.spr', 'vwwarped.spr', 'viewscr.spr']);
    // (with one not yet drawn, two: the tie as they come)
    sheets.delete('viewscan.spr');
    expect(warpOverlayAt(sheets, 0).map(l => l.file)).toEqual(['viewscr.spr', 'vwwarped.spr']);
  });
});

describe('WarpOverlay', () => {
  /** A set with a 2 x 1 cheap.pic (colours 1 and 2) and the three sprites. */
  function set(palette = 'cheap'): BattleAssets {
    const warpPalette = new Uint8Array(768);
    warpPalette.set([10, 20, 30, 40, 50, 60], 3);
    const sprites = new Map([['viewscan.spr', sheet(SCAN, [120, 24], 2)], ['viewscr.spr', sheet(SCREEN, [640, 364], 1, palette)], ['vwwarped.spr', sheet(WARPED, [520, 248], 3)]]);
    return {
      list: { models: [], sprites: [...sprites.keys()] }, models: new Map(), sprites, missing: [], textures: [], dispose: () => {},
      stills: { console: [], palette: new Uint8Array(768), warp: [{ width: 2, height: 1, pixels: Uint8Array.of(1, 2) }], warpPalette },
    };
  }

  it('draws cheap.pic in its own palette, then each sprite\'s frames at their places, deepest first', () => {
    const overlay = new WarpOverlay(set());
    overlay.update(86);
    const background = overlay.scene.children.find(o => ((o as Mesh).material as MeshBasicMaterial).map instanceof DataTexture) as Mesh;
    expect(Array.from((((background.material as MeshBasicMaterial).map as DataTexture).image.data as Uint8Array))).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
    expect(overlay.shown()).toEqual([
      { file: 'viewscan.spr', frame: 0, left: 258, top: 315 },
      { file: 'vwwarped.spr', frame: 0, left: 60, top: 65 }, { file: 'vwwarped.spr', frame: 1, left: 60, top: 65 },
      { file: 'viewscr.spr', frame: 0, left: 0, top: 0 },
    ]);
    expect(overlay.problems).toEqual([]);
  });

  it('draws every frame from its sheet\'s own texture, the frame in the quad\'s UVs: no copy, no upload a frame (review I2)', () => {
    const s = set();
    const warped = s.sprites.get('vwwarped.spr')!;
    const version = warped.texture.source.version;
    const overlay = new WarpOverlay(s);
    for (const ms of [0, 86, 171, 256]) overlay.update(ms);
    const maps = new Set(overlay.scene.children.map(o => ((o as Mesh).material as MeshBasicMaterial).map).filter(m => !(m instanceof DataTexture)));
    expect([...maps]).toEqual(expect.arrayContaining([...s.sprites.values()].map(x => x.texture)));
    expect([maps.size, warped.texture.source.version]).toEqual([3, version]);
    // (vwwarped's frame 2 of 3 across: u from (2 * 520 + 0.5) / 1560 at its left)
    const quad = overlay.scene.children.find(o => ((o as Mesh).material as MeshBasicMaterial).map === warped.texture && (o as Mesh).geometry.getAttribute('uv').getX(0) > 0.6) as Mesh;
    expect(quad.geometry.getAttribute('uv').getX(0)).toBeCloseTo((2 * 520 + 0.5) / 1560, 6);
  });

  it('draws what it has from an export without the stills or the sheets: no background, no sprites, no throw', () => {
    const bare: BattleAssets = { list: { models: [], sprites: [] }, models: new Map(), sprites: new Map(), stills: null, missing: [], textures: [], dispose: () => {} };
    const overlay = new WarpOverlay(bare);
    overlay.update(500);
    expect([overlay.scene.children.length, overlay.shown(), overlay.problems]).toEqual([0, [], []]);
  });

  it('says when a warp sprite\'s sheet is not in cheap.pic\'s palette (an images export from before Plan 24), and frees only its own', () => {
    const s = set('standard');
    const overlay = new WarpOverlay(s);
    expect(overlay.problems).toEqual(['combat: the warp overlay\'s viewscr.spr is in the standard palette, not cheap.pic\'s: re-export the images (Plan 24, docs/unity-local.md)']);
    overlay.update(0);
    let freed = 0;
    s.sprites.get('viewscr.spr')!.texture.addEventListener('dispose', () => freed++);
    overlay.dispose();
    expect(freed).toBe(0);
  });
});
