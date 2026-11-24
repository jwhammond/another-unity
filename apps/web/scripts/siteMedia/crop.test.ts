// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { crop, sceneRect } from './crop';

describe('sceneRect', () => {
  it('is the top 400 of the 480 rows at the game size and at the site size', () => {
    expect(sceneRect(640, 480)).toEqual({ x: 0, y: 0, w: 640, h: 400 });
    expect(sceneRect(960, 720)).toEqual({ x: 0, y: 0, w: 960, h: 600 });
  });
  it('scales with the picture, whatever its size, and never trims columns', () => {
    expect(sceneRect(320, 240)).toEqual({ x: 0, y: 0, w: 320, h: 200 });
    expect(sceneRect(1280, 960).w).toBe(1280);
  });
});

describe('crop', () => {
  const pic = (w: number, h: number, v: number) => {
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) data.set([v, v, v, 255], i * 4);
    return { width: w, height: h, data };
  };
  it('copies the rectangle, pixel for pixel', () => {
    const p = pic(6, 4, 90);
    const c = crop(p, { x: 1, y: 1, w: 2, h: 2 });
    expect([c.width, c.height, c.data.length]).toEqual([2, 2, 16]);
    expect([...c.data.subarray(0, 4)]).toEqual([90, 90, 90, 255]);
  });
  it('keeps a dark scene whole: a near-black picture loses only the rows below the scene', () => {
    const p = pic(960, 720, 3);
    const c = crop(p, sceneRect(p.width, p.height));
    expect([c.width, c.height]).toEqual([960, 600]);
    expect(c.data[0]).toBe(3);
  });
});
