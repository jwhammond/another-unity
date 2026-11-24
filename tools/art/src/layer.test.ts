// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { cellGeometry } from './strips';
import { stripLayout } from './layer';
import type { SpriteJson } from './sprites';

/** A door: animation 0 is its closed frame and a pause, animation 1 opens it over three frames (one a different size) and holds. */
const door: SpriteJson = {
  anims: [0, 2],
  entries: [
    { type: 'sprite', width: 26, height: 72, png: 'a.png' },
    { type: 'pause' },
    { type: 'sprite', width: 26, height: 72, png: 'b.png' },
    { type: 'wait', wait: 160 },
    { type: 'sprite', width: 20, height: 70, png: 'c.png' },
    { type: 'relPos', x: 4, y: 0 },
    { type: 'wait', wait: 320 },
    { type: 'sprite', width: 10, height: 72, png: 'd.png' },
    { type: 'pause' },
  ],
};

describe('cellGeometry', () => {
  it('is the cell packAnim makes: the union of the frames, the origin inside it, each frame\'s offset', () => {
    const g = cellGeometry([{ width: 26, height: 72, dx: 0, dy: 0 }, { width: 10, height: 72, dx: 8, dy: 0 }], 4, 4096);
    // frame 0 spans -13..13, frame 1 spans 3..13: the union is 26 wide
    expect(g.cell).toEqual([26 * 4, 72 * 4]);
    expect(g.anchor).toEqual([0.5, 1]);
    expect(g.offsets).toEqual([[0, 0], [16, 0]]);
    expect(g.origin).toEqual([-13, -72]);
    expect(g.columns).toBe(2);
  });
});

describe('stripLayout', () => {
  it('gives every frame the original plays up to its pause, each at its own rectangle, in one cell that is their union', () => {
    const l = stripLayout(door, 1, { x: 145, y: 215 })!;
    expect(l.frames).toBe(3);
    // (frame 0: 26x72 centred on 145, standing on 215; frame 1: moved 4 right by relPos; frame 2 is narrow)
    expect(l.rects[0]).toEqual([132, 143, 26, 72]);
    expect(l.rects[1]).toEqual([139, 145, 20, 70]);
    expect(l.rects[2]).toEqual([144, 143, 10, 72]);
    // the cell is where the union of those lies
    expect(l.rect).toEqual([132, 143, 27, 72]);
    expect(l.cell).toEqual([27 * 4, 72 * 4]);
    expect(l.loop).toBe(false);
    expect(l.delays).toHaveLength(3);
  });

  it('is one frame for an animation that pauses at once, and null for one the sprite does not have', () => {
    expect(stripLayout(door, 0, { x: 145, y: 215 })!.frames).toBe(1);
    expect(stripLayout(door, 7, { x: 145, y: 215 })).toBeNull();
  });

  it('says a looping animation loops, and what an ending one falls into', () => {
    const blink: SpriteJson = { anims: [0], entries: [{ type: 'sprite', width: 4, height: 4, png: 'a.png' }, { type: 'wait', wait: 160 }, { type: 'sprite', width: 4, height: 4, png: 'b.png' }, { type: 'wait', wait: 160 }, { type: 'jump', target: 0 }] };
    const l = stripLayout(blink, 0, { x: 10, y: 10 })!;
    expect(l.loop).toBe(true);
    expect(l.frames).toBe(2);
  });
});

describe('stripLayout of a strip that holds each distinct frame once', () => {
  // a light that blinks: four frames of two pictures
  const f = (png: string) => ({ type: 'sprite', width: 4, height: 4, png });
  const blink: SpriteJson = { anims: [0], entries: [f('a'), { type: 'wait', wait: 160 }, f('b'), { type: 'wait', wait: 160 }, f('a'), { type: 'wait', wait: 160 }, f('b'), { type: 'wait', wait: 160 }, { type: 'jump', target: 0 }] };

  it('says which cell each frame is, and how many cells there are', () => {
    const l = stripLayout(blink, 0, { x: 10, y: 10 }, { of: [0, 1, 0, 1], columns: 2 })!;
    expect(l.frames).toBe(4);
    expect(l.cells).toBe(2);
    expect(l.of).toEqual([0, 1, 0, 1]);
    expect(l.columns).toBe(2);
    expect(l.delays).toHaveLength(4);
  });

  it('is the plain layout, one cell a frame, when nothing repeats or nothing is said', () => {
    expect(stripLayout(blink, 0, { x: 10, y: 10 })).toMatchObject({ cells: 4 });
    expect(stripLayout(blink, 0, { x: 10, y: 10 })!.of).toBeUndefined();
    const same = stripLayout(blink, 0, { x: 10, y: 10 }, { of: [0, 1, 2, 3], columns: 4 })!;
    expect(same.of).toBeUndefined();
  });

  it('refuses a mapping that is not of this animation\'s frames', () => {
    expect(() => stripLayout(blink, 0, { x: 10, y: 10 }, { of: [0, 1], columns: 2 })).toThrow(/4 frames/);
  });
});

describe('stripLayout, an atlas', () => {
  const blink: SpriteJson = { anims: [0], entries: [{ type: 'sprite', width: 4, height: 8, png: 'a' }, { type: 'wait', wait: 160 }, { type: 'sprite', width: 2, height: 8, png: 'b' }, { type: 'wait', wait: 160 }, { type: 'sprite', width: 4, height: 8, png: 'a' }, { type: 'jump', target: 0 }] };
  const atlas = { images: ['art/cards/x/0.0.webp'], pages: [[24, 32]] as [number, number][], cells: [[0, 0, 0, 16, 32, 0, 0], [0, 17, 0, 6, 32, 5, 0]] as [number, number, number, number, number, number, number][] };
  it('carries the atlas and its cells, with the frames\' own rectangles', () => {
    const l = stripLayout(blink, 0, { x: 20, y: 50 }, { of: [0, 1, 0], columns: 2, atlas })!;
    expect(l.atlas).toEqual(atlas);
    expect([l.frames, l.cells, l.of]).toEqual([3, 2, [0, 1, 0]]);
    expect(l.rects[1]).toEqual([19, 42, 2, 8]);
  });
  it('refuses an atlas whose cells are not the animation\'s distinct frames', () => {
    expect(() => stripLayout(blink, 0, { x: 20, y: 50 }, { of: [0, 1, 0], columns: 2, atlas: { ...atlas, cells: [atlas.cells[0]!] } })).toThrow(/1 cells/);
  });
});
