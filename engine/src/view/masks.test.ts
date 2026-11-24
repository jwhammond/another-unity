// SPDX-License-Identifier: GPL-3.0-or-later
import { PerspectiveCamera, Texture, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { frameCamera } from './room';
import { fitQuad, fullyOccluded, maskQuad, type Occluder } from './masks';

/** A mask over rect [x, y, w, h] that is opaque where `solid` says. */
function mask(rect: [number, number, number, number], depth: number, solid: (x: number, y: number) => boolean = () => true): Occluder {
  const [, , w, h] = rect;
  const alpha = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) alpha[y * w + x] = solid(x, y) ? 255 : 0;
  return { rect, depth, alpha };
}

describe('fullyOccluded', () => {
  const card: [number, number, number, number] = [100, 100, 150, 250];

  it('is true when masks drawn after the card cover all of it', () => {
    expect(fullyOccluded(card, 250, [mask([90, 90, 40, 170], 300)])).toBe(false);
    expect(fullyOccluded(card, 250, [mask([90, 90, 80, 170], 300)])).toBe(true);
    expect(fullyOccluded(card, 250, [mask([90, 90, 40, 170], 300), mask([125, 90, 100, 170], 260)])).toBe(true);
    expect(fullyOccluded(card, 250, [mask([80, 80, 200, 200], 251)])).toBe(true);
  });

  it('is false when a mask leaves any of the card showing: a hole, a part, or a mask the card stands in front of', () => {
    // (the mask covers all but a window the card shows through)
    expect(fullyOccluded(card, 250, [mask([80, 80, 200, 200], 300, (x, y) => !(x > 20 && x < 60 && y > 20 && y < 100))])).toBe(false);
    // (only the lower half)
    expect(fullyOccluded(card, 250, [mask([80, 180, 200, 100], 300)])).toBe(false);
    // (a mask sorted at or above the card's foot row is drawn first: the card is over it)
    expect(fullyOccluded(card, 250, [mask([80, 80, 200, 200], 250)])).toBe(false);
    expect(fullyOccluded(card, 250, [mask([80, 80, 200, 200], 100)])).toBe(false);
  });

  it('a mask whose alpha could not be read hides nothing, and an empty rect is not hidden', () => {
    expect(fullyOccluded(card, 250, [{ rect: [80, 80, 200, 200], depth: 300, alpha: null }])).toBe(false);
    expect(fullyOccluded([10, 10, 10, 10], 10, [mask([0, 0, 50, 50], 99)])).toBe(false);
    expect(fullyOccluded(card, 250, [])).toBe(false);
  });
});

describe('maskQuad above the horizon', () => {
  const camera = () => {
    const c = new PerspectiveCamera(60, 640 / 480, 0.1, 100);
    c.position.set(0, 1.5, 5);
    frameCamera(c, 150);
    c.updateMatrixWorld(true);
    return c;
  };
  const texture = new Texture();
  // (sorted by row 1, above the horizon at row 150, over a rect whose foot is on the floor)
  const high = { object: 'w.o', texture, alpha: null, rect: [300, 250, 40, 60] as [number, number, number, number], depth: 1 };

  it('leaves out a cut of the plate sorted above the horizon', () => {
    expect(maskQuad(camera(), high)).toBeNull();
  });

  it('draws a card sorted above the horizon, behind everything by its sorting row', () => {
    const quad = maskQuad(camera(), { ...high, card: true });
    expect(quad).not.toBeNull();
    expect(quad!.renderOrder).toBe(1);
  });

  it('draws a card whose foot is above the horizon too, on its own rectangle (a decal on the far wall)', () => {
    const cam = camera();
    const rect: [number, number, number, number] = [40, 64, 120, 36];
    const quad = maskQuad(cam, { ...high, card: true, rect, depth: 100 });
    expect(quad).not.toBeNull();
    expect(quad!.renderOrder).toBe(100);
    // (every corner projects back onto the original's rectangle)
    const pos = quad!.geometry.getAttribute('position');
    const px = [0, 1, 2, 3].map(i => {
      const v = new Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).add(quad!.position).project(cam);
      return [((v.x + 1) / 2) * 640, ((1 - v.y) / 2) * 480];
    });
    expect(px[0]![0]).toBeCloseTo(40, 1);
    expect(px[0]![1]).toBeCloseTo(64, 1);
    expect(px[2]![0]).toBeCloseTo(160, 1);
    expect(px[2]![1]).toBeCloseTo(100, 1);
  });

  it('still leaves out a cut of the plate whose foot is above the horizon', () => {
    expect(maskQuad(camera(), { ...high, rect: [300, 20, 40, 60] })).toBeNull();
  });

});

describe('fitQuad', () => {
  it('draws the quad over a part of its rectangle: the part\'s corners project onto the part of the original\'s pixels', () => {
    const cam = new PerspectiveCamera(60, 640 / 480, 0.1, 100);
    cam.position.set(0, 1.5, 5);
    frameCamera(cam, 150);
    cam.updateMatrixWorld(true);
    const rect: [number, number, number, number] = [300, 250, 80, 60];
    const quad = maskQuad(cam, { object: 'w.o', texture: new Texture(), alpha: null, rect, depth: 260, card: true })!;
    // the part from 25% to 75% across, and 10% to 50% down
    fitQuad(quad, [0.25, 0.1, 0.75, 0.5]);
    const pos = quad.geometry.getAttribute('position');
    const px = [0, 1, 2, 3].map(i => {
      const v = new Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).add(quad.position).project(cam);
      return [((v.x + 1) / 2) * 640, ((1 - v.y) / 2) * 480];
    });
    expect(px[0]![0]).toBeCloseTo(320, 1);
    expect(px[0]![1]).toBeCloseTo(256, 1);
    expect(px[2]![0]).toBeCloseTo(360, 1);
    expect(px[2]![1]).toBeCloseTo(280, 1);
    // the whole again
    fitQuad(quad, [0, 0, 1, 1]);
    const v = new Vector3(pos.getX(2), pos.getY(2), pos.getZ(2)).add(quad.position).project(cam);
    expect(((v.x + 1) / 2) * 640).toBeCloseTo(380, 1);
    expect(((1 - v.y) / 2) * 480).toBeCloseTo(310, 1);
  });
});
