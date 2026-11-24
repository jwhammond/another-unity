// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { animationMillis, layerFrame, upcomingFrames, type LayerStrip } from './layerAnim';

const strip = (over: Partial<LayerStrip> = {}): LayerStrip => ({ frames: 3, delays: [100, 100, 100], loop: false, rect: [10, 20, 30, 40], ...over });

describe('layerFrame', () => {
  it('shows the frame whose time it is, and holds the last when the animation ends', () => {
    const strips = { 1: strip() };
    const at = (t: number) => layerFrame(strips, 1, t)!.index;
    expect([0, 99, 100, 199, 200, 299, 300, 100_000].map(at)).toEqual([0, 0, 1, 1, 2, 2, 2, 2]);
  });

  it('loops a looping animation on its own length', () => {
    const strips = { 0: strip({ loop: true, delays: [100, 100, 200] }) };
    const at = (t: number) => layerFrame(strips, 0, t)!.index;
    expect([0, 150, 250, 399, 400, 550, 4_000_050].map(at)).toEqual([0, 1, 2, 2, 0, 1, 0]);
  });

  it('falls into the animation the original jumps to, with the time that is left, and holds if that one is not there', () => {
    const strips = { 1: strip({ frames: 2, delays: [100, 100], next: 2 }), 2: strip({ frames: 2, delays: [50, 50], loop: true }) };
    expect(layerFrame(strips, 1, 150)).toMatchObject({ anim: 1, index: 1 });
    expect(layerFrame(strips, 1, 225)).toMatchObject({ anim: 2, index: 0 });
    expect(layerFrame(strips, 1, 275)).toMatchObject({ anim: 2, index: 1 });
    expect(layerFrame(strips, 1, 1_000_025)).toMatchObject({ anim: 2, index: 0 });
    // (no strip for the animation it falls into: the last frame stays)
    expect(layerFrame({ 1: strips[1] }, 1, 10_000)).toMatchObject({ anim: 1, index: 1 });
  });

  it('is null for an animation it has no strip of (the caller draws the still), and the first frame for one with no time', () => {
    expect(layerFrame({ 1: strip() }, 0, 0)).toBeNull();
    expect(layerFrame({ 0: strip({ delays: [0, 0, 0] }) }, 0, 500)!.index).toBe(0);
    expect(layerFrame({ 0: strip({ frames: 0, delays: [] }) }, 0, 0)).toBeNull();
  });

  it('gives the uv window of the cell, the first row being the top of the image', () => {
    const strips = { 0: strip({ columns: 2 }) };
    expect(layerFrame(strips, 0, 0)!.uv).toEqual([0, 0.5, 0.5, 1]);
    expect(layerFrame(strips, 0, 100)!.uv).toEqual([0.5, 0.5, 1, 1]);
    expect(layerFrame(strips, 0, 200)!.uv).toEqual([0, 0, 0.5, 0.5]);
    // (a strip in one row)
    expect(layerFrame({ 0: strip() }, 0, 100)!.uv).toEqual([1 / 3, 0, 2 / 3, 1]);
  });

  it('says where the cell is drawn: the animation\'s own, which differs from one to the next', () => {
    const strips = { 0: strip(), 1: strip({ rect: [1, 2, 3, 4] }) };
    expect(layerFrame(strips, 0, 0)!.rect).toEqual([10, 20, 30, 40]);
    expect(layerFrame(strips, 1, 0)!.rect).toEqual([1, 2, 3, 4]);
  });

  it('takes the cell of a frame from the strip\'s record where the strip holds each distinct frame once', () => {
    // a light: four frames of two pictures, two cells
    const strips = { 0: strip({ frames: 4, delays: [100, 100, 100, 100], loop: true, of: [0, 1, 0, 1] }) };
    const at = (t: number) => layerFrame(strips, 0, t)!;
    expect([0, 100, 200, 300].map(t => at(t).index)).toEqual([0, 1, 2, 3]);
    expect([0, 100, 200, 300].map(t => at(t).uv)).toEqual([[0, 0, 0.5, 1], [0.5, 0, 1, 1], [0, 0, 0.5, 1], [0.5, 0, 1, 1]]);
  });
});

describe('layerFrame, an atlas', () => {
  // an animation of 3 frames, 2 distinct cells: frame 0 and 2 are cell 0. The union cell is 40x20 pixels; cell 0 is its 10x8 part from (4, 2), on page 0 at (0, 0);
  // cell 1 is the 20x20 part from (16, 0), on page 1 at (8, 4). The pages are 64x32 and 32x32.
  const strip: LayerStrip = {
    frames: 3, delays: [100, 100, 100], loop: true, of: [0, 1, 0], rect: [10, 20, 10, 5], cell: [40, 20], pages: [[64, 32], [32, 32]],
    cells: [[0, 0, 0, 10, 8, 4, 2], [1, 8, 4, 20, 20, 16, 0]],
  };
  it('picks the cell\'s page, its uv window in the page and its part of the union rectangle', () => {
    const f0 = layerFrame({ 0: strip }, 0, 0)!;
    expect(f0).toMatchObject({ page: 0, sub: [0.1, 0.1, 0.35, 0.5], empty: false });
    expect(f0.uv).toEqual([0, 1 - 8 / 32, 10 / 64, 1]);
    const f1 = layerFrame({ 0: strip }, 0, 150)!;
    expect(f1.index).toBe(1);
    expect(f1).toMatchObject({ page: 1, sub: [0.4, 0, 0.9, 1] });
    expect(f1.uv).toEqual([8 / 32, 1 - 24 / 32, 28 / 32, 1 - 4 / 32]);
    expect(layerFrame({ 0: strip }, 0, 250)!.page).toBe(0);
  });
  it('says empty for a cell with nothing visible', () => {
    const blank: LayerStrip = { ...strip, cells: [[0, 0, 0, 0, 0, 0, 0], strip.cells![1]!] };
    expect(layerFrame({ 0: blank }, 0, 0)!.empty).toBe(true);
  });
  it('is the whole rectangle for a grid strip', () => {
    const grid: LayerStrip = { frames: 2, delays: [1, 1], loop: true, rect: [0, 0, 4, 4] };
    expect(layerFrame({ 0: grid }, 0, 0)).toMatchObject({ page: 0, sub: [0, 0, 1, 1], empty: false });
  });
});

describe('upcomingFrames', () => {
  const strip = (over: Partial<LayerStrip> = {}): LayerStrip => ({ frames: 3, delays: [100, 100, 100], loop: false, rect: [0, 0, 4, 4], of: [0, 1, 0], ...over });
  it('lists the frames that follow, in order, with the cell each is, and says how long the frame has left', () => {
    expect(layerFrame({ 0: strip() }, 0, 30)).toMatchObject({ index: 0, cell: 0, until: 70 });
    expect(upcomingFrames({ 0: strip() }, 0, 30, 2).map(f => [f.index, f.cell])).toEqual([[1, 1], [2, 0]]);
  });
  it('stops where the animation holds for good, and goes round a loop', () => {
    expect(upcomingFrames({ 0: strip() }, 0, 150, 3).map(f => f.index)).toEqual([2]);
    expect(layerFrame({ 0: strip() }, 0, 500)!.until).toBe(Infinity);
    expect(upcomingFrames({ 0: strip({ loop: true }) }, 0, 150, 3).map(f => f.index)).toEqual([2, 0, 1]);
  });
  it('goes on into the animation it falls into', () => {
    const strips = { 0: strip({ next: 1 }), 1: strip({ frames: 2, delays: [50, 50], of: [1, 0], loop: true }) };
    expect(upcomingFrames(strips, 0, 250, 3).map(f => [f.anim, f.index])).toEqual([[1, 0], [1, 1], [1, 0]]);
  });
});

describe('animationMillis', () => {
  it("is the frames' delays, and the animation it falls into, until one holds", () => {
    const strips = { 1: strip({ delays: [100, 200, 300] }), 2: strip({ frames: 2, delays: [50, 50], next: 3 }), 3: strip({ frames: 1, delays: [400] }) };
    expect(animationMillis(strips, 1)).toBe(600);
    expect(animationMillis(strips, 2)).toBe(500);
  });

  it('is Infinity for a loop (and one it falls into), and null for an animation with no strip', () => {
    expect(animationMillis({ 0: strip({ loop: true }) }, 0)).toBe(Infinity);
    expect(animationMillis({ 1: strip({ next: 2 }), 2: strip({ loop: true }) }, 1)).toBe(Infinity);
    expect(animationMillis({ 0: strip({ next: 0 }) }, 0)).toBe(Infinity);
    expect(animationMillis({ 1: strip() }, 0)).toBeNull();
    // (it falls into one with no strip: it stops where it is)
    expect(animationMillis({ 1: strip({ next: 9 }) }, 1)).toBe(300);
  });
});
