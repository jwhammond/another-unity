// SPDX-License-Identifier: GPL-3.0-or-later
import { DoubleSide, Mesh } from 'three';
import { describe, expect, it } from 'vitest';
import { focalLength } from './projection';
import { MARK_EDGE, TargetMarksLayer, targetMarks } from './targetMarks';

describe('targetMarks (the brackets 0x94e89 and the off-screen pointer 0x9694e)', () => {
  const W = 320, H = 220;

  it('puts four corner brackets about a target on screen, around its projected box', () => {
    // (straight ahead, 1000 deep, 100 in size: its box's half is 100 x focal / 1000 about the window's middle, half a pixel right and down)
    const marks = targetMarks({ at: { x: 0, y: 0, z: 1000 }, size: 100 }, true, W, H)!;
    expect(marks.kind).toBe('brackets');
    const half = (100 * focalLength(W)) / 1000;
    expect(marks.box!.map(n => Math.round(n * 10) / 10)).toEqual([160.5 - half, 110.5 - half, 160.5 + half, 110.5 + half].map(n => Math.round(n * 10) / 10));
    // (two arms at each corner, each from that corner along an edge, no longer than a third of the side)
    expect(marks.lines).toHaveLength(8);
    const [x0, y0, x1, y1] = marks.box!;
    const corners = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]];
    for (const [cx, cy] of corners) {
      const arms = marks.lines.filter(l => l[0] === cx && l[1] === cy);
      expect(arms).toHaveLength(2);
      for (const l of arms) expect(Math.hypot(l[2] - l[0], l[3] - l[1])).toBeLessThanOrEqual((x1 - x0) / 3 + 1e-9);
    }
  });

  it('keeps a far target\'s brackets a few pixels wide, so they never close up on it', () => {
    const marks = targetMarks({ at: { x: 0, y: 0, z: 200000 }, size: 50 }, true, W, H)!;
    expect(marks.kind).toBe('brackets');
    expect(marks.box![2] - marks.box![0]).toBeGreaterThanOrEqual(12);
  });

  it('points at a target off the window\'s side with an arrow at that edge, and at one behind from the edge it lies toward', () => {
    const right = targetMarks({ at: { x: 5000, y: 0, z: 1000 }, size: 100 }, true, W, H)!;
    expect(right.kind).toBe('arrow');
    expect(right.tip!.x).toBeCloseTo(W - MARK_EDGE, 6);
    expect(right.tip!.y).toBeCloseTo(H / 2, 6);
    expect(right.angle).toBeCloseTo(0, 6);
    // (a chevron's two arms and its base, behind the tip)
    expect(right.lines).toHaveLength(3);
    for (const l of right.lines) expect(Math.max(l[0], l[2])).toBeLessThanOrEqual(W - MARK_EDGE + 1e-9);
    // (behind and above: the top edge, pointing up; y is down the window)
    const above = targetMarks({ at: { x: 0, y: -300, z: -1000 }, size: 100 }, true, W, H)!;
    expect(above.kind).toBe('arrow');
    expect(above.tip!.y).toBeCloseTo(MARK_EDGE, 6);
    expect(above.angle).toBeCloseTo(-Math.PI / 2, 6);
    // (dead behind: the bottom edge)
    const behind = targetMarks({ at: { x: 0, y: 0, z: -1000 }, size: 100 }, true, W, H)!;
    expect(behind.tip!.y).toBeCloseTo(H - MARK_EDGE, 6);
  });

  it('keeps the arrow clear of the wide view\'s panels: off every box over the view, in each direction and into each corner', () => {
    // (a wide window and the HUD's boxes over it as the session measures them: the top strip, the target in the top right, the
    // log in the bottom left, the lamps and buttons in the bottom right, and the game's bar under the HUD)
    const w = 640, h = 360;
    const boxes: [number, number, number, number][] = [[0, 0, 448, 30], [460, 0, 640, 64], [0, 290, 290, 340], [350, 250, 640, 340], [0, 340, 640, 360]];
    const inside = (x: number, y: number) => boxes.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);
    const directions = [[0, -1], [1, 0], [0, 1], [-1, 0], [1, -1], [1, 1], [-1, 1], [-1, -1], [0.3, -1], [1, -0.15]];
    for (const [dx, dy] of directions) {
      const marks = targetMarks({ at: { x: dx! * 1000, y: dy! * 1000, z: -10 }, size: 50 }, true, w, h, boxes)!;
      expect(marks.kind).toBe('arrow');
      // (the tip and every end of its lines off the boxes, and on the window)
      for (const [x0, y0, x1, y1] of marks.lines) {
        for (const [x, y] of [[x0, y0], [x1, y1]]) {
          expect(inside(x!, y!), `toward (${dx}, ${dy}): (${x}, ${y})`).toBe(false);
          expect(x! >= 0 && x! <= w && y! >= 0 && y! <= h).toBe(true);
        }
      }
      // (still toward the target: the tip on the ray from the middle)
      const tx = marks.tip!.x - w / 2, ty = marks.tip!.y - h / 2;
      expect(Math.abs(tx * dy! - ty * dx!)).toBeLessThan(1e-6 * Math.hypot(tx, ty) + 1e-6);
    }
    // (straight below, the console drawer's handle at the bottom middle, between the log and the fire buttons: above it)
    const handle: [number, number, number, number] = [292, 316, 348, 340];
    const below = targetMarks({ at: { x: 0, y: 1000, z: -10 }, size: 50 }, true, w, h, [...boxes, handle])!;
    expect(below.kind).toBe('arrow');
    expect(below.tip!.x).toBeCloseTo(w / 2, 6);
    expect(below.tip!.y).toBeLessThan(handle[1]);
    for (const [, y0, , y1] of below.lines) expect(Math.max(y0, y1)).toBeLessThan(handle[1]);
    // (with nothing over the view, the edge as before)
    expect(targetMarks({ at: { x: 0, y: -1000, z: -10 }, size: 50 }, true, w, h, [])!.tip!.y).toBeCloseTo(MARK_EDGE, 6);
  });

  it('marks nothing without a target, or with the sensors down (0x167f94)', () => {
    expect(targetMarks(null, true, W, H)).toBeNull();
    expect(targetMarks({ at: { x: 0, y: 0, z: 1000 }, size: 100 }, false, W, H)).toBeNull();
  });
});

describe('TargetMarksLayer', () => {
  it('draws the marks as thin quads over everything, one window pixel wide, and nothing without them', () => {
    const layer = new TargetMarksLayer(null);
    expect(layer.mesh).toBeInstanceOf(Mesh);
    // (both faces: the window's y runs down, so a quad's winding depends on the line's way)
    expect([layer.mesh.material.depthTest, layer.mesh.material.side, layer.mesh.renderOrder > 0, layer.mesh.frustumCulled]).toEqual([false, DoubleSide, true, false]);
    layer.set(targetMarks({ at: { x: 0, y: 0, z: 1000 }, size: 100 }, true, 320, 220), 320, 220);
    // (8 segments, two triangles each)
    expect([layer.mesh.visible, layer.mesh.geometry.drawRange.count]).toEqual([true, 8 * 6]);
    // (half a unit each side where a unit is two device pixels; at half a device pixel a unit (Resolution 2 on a small canvas),
    // at least a device pixel each side: two units)
    const across = () => {
      const p = layer.mesh.geometry.attributes.position!.array;
      // (the first line runs along x: its first two corners are across it)
      return Math.abs(p[1]! - p[4]!);
    };
    layer.set(targetMarks({ at: { x: 0, y: 0, z: 1000 }, size: 100 }, true, 320, 220), 320, 220, 2);
    expect(across()).toBeCloseTo(1, 6);
    layer.set(targetMarks({ at: { x: 0, y: 0, z: 1000 }, size: 100 }, true, 320, 220), 320, 220, 0.5);
    expect(across()).toBeCloseTo(4, 6);
    layer.set(null, 320, 220);
    expect(layer.mesh.visible).toBe(false);
    layer.dispose();
  });
});
