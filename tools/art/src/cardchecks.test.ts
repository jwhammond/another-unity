// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { checkAnim, checkTransition, transitionFlicker, CARD_CHECK_DEFAULTS, type Placed } from './cardchecks';
import { encodePng, type Rgba } from './image';

const W = 40;
const H = 60;
const S = 4;

/** A walk of `n` frames: a figure with a striped torso and a head, legs swinging with the frame (alpha identical across versions). */
function walk(n: number, scale: number, tint: (frame: number, x: number, y: number, c: number) => number = () => 0, shift: (frame: number) => [number, number] = () => [0, 0]): Rgba[] {
  return Array.from({ length: n }, (_, f) => {
    const w = W * scale;
    const h = H * scale;
    const data = new Uint8Array(w * h * 4);
    const [sx, sy] = shift(f);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const ox = Math.floor(x / scale) - sx;
        const oy = Math.floor(y / scale) - sy;
        const body = ox >= 12 && ox < 28 && oy >= 8 && oy < 50;
        const leg = oy >= 40 && oy < 50 && (ox < 12 + (f % 2) * 2 ? false : true);
        const inside = body && (oy < 40 || leg);
        if (!inside) continue;
        // a costume (blue-grey), with a vertical stripe every 3 px so edges exist inside the figure
        const stripe = ox % 3 === 0 ? 40 : 0;
        const colour = [70 + stripe, 90 + stripe, 160 + stripe];
        const o = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) data[o + c] = Math.max(0, Math.min(255, colour[c]! + tint(f, x, y, c)));
        data[o + 3] = 255;
      }
    }
    return { width: w, height: h, data };
  });
}
const alphaOf = (frames: Rgba[]): Rgba[] => frames;
void encodePng;

describe('checkAnim', () => {
  const orig = walk(6, 1);
  const up = walk(6, S);

  it('passes a consistent synthetic walk (a repaint that recolours every frame alike)', () => {
    const rep = walk(6, S, () => 6);
    const r = checkAnim(orig, up, rep, CARD_CHECK_DEFAULTS);
    expect(r.why).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.alignment).toHaveLength(6);
    expect(r.flicker).toHaveLength(5);
  });

  describe('speckle (opt in: a glittering patch whose speckle any repaint draws afresh)', () => {
    const noise = (seed: number) => (x: number, y: number): number => {
      const h = Math.sin((x * 12.9898 + y * 78.233 + seed) * 43758.5453) * 43758.5453;
      return (h - Math.floor(h) - 0.5) * 240;
    };
    const inPatch = (x: number, y: number): boolean => x >= 6 && x < 14 && y >= 8 && y < 18;
    /** A wide figure (so there are windows beside the patch): stripes, plus the patch's noise from `fill`. */
    const wide = (scale: number, fill: (x: number, y: number, c: number) => number, shift: (f: number) => number = () => 0): Rgba[] =>
      Array.from({ length: 6 }, (_, f) => {
        const w = W * scale;
        const h = H * scale;
        const data = new Uint8Array(w * h * 4);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const ox = Math.floor(x / scale) - shift(f);
            const oy = Math.floor(y / scale);
            if (!(ox >= 4 && ox < 36 && oy >= 4 && oy < 56)) continue;
            const stripe = Math.floor(ox / 6) % 2 === 0 ? 0 : 60;
            const o = (y * w + x) * 4;
            for (let c = 0; c < 3; c++) data[o + c] = Math.max(0, Math.min(255, [70, 90, 160][c]! + stripe + (inPatch(Math.floor(x / scale), oy) ? fill(Math.floor(x / scale), oy, c) : 0)));
            data[o + 3] = 255;
          }
        }
        return { width: w, height: h, data };
      });
    const o = wide(1, (x, y, c) => noise(c)(x, y));
    const u = wide(S, () => 0);
    const r = wide(S, (x, y, c) => noise(97 + c)(x, y));

    it('judges the next strongest windows instead when it is set, and still fails a shifted frame', () => {
      const c = { ...CARD_CHECK_DEFAULTS, speckle: 0.9 };
      expect(checkAnim(o, u, r, c).why).toBeUndefined();
      const shifted = wide(S, (x, y, ch) => noise(97 + ch)(x, y), f => (f === 3 ? 3 : 0));
      expect(checkAnim(o, u, shifted, c).why).toMatch(/frame 3/);
    });

    it('fails a frame that is mostly speckle, which no window can judge', () => {
      const all = Array.from({ length: 6 }, () => ({ width: W, height: H, data: new Uint8Array(W * H * 4).map((_, k) => (k % 4 === 3 ? 255 : 128 + noise(k % 4)(Math.floor(k / 4) % W, Math.floor(k / 4 / W)) / 2)) }));
      expect(checkAnim(all, walk(6, S), walk(6, S), { ...CARD_CHECK_DEFAULTS, speckle: 0.9 }).why).toMatch(/speckle/);
    });
  });

  it('fails a frame shifted 3 px', () => {
    const rep = walk(6, S, () => 6, f => (f === 3 ? [3, 0] : [0, 0]));
    const r = checkAnim(orig, up, rep, CARD_CHECK_DEFAULTS);
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/frame 3/);
    expect(r.alignment[3]).toBeGreaterThan(1);
  });

  it('fails a frame with a strobing patch', () => {
    const rep = walk(6, S, (f, x, y) => (f === 2 && x > 60 && x < 100 && y > 100 && y < 160 ? 60 : 6));
    const r = checkAnim(orig, up, rep, CARD_CHECK_DEFAULTS);
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/flicker/);
  });

  it('fails a costume recoloured beyond deltaE', () => {
    const rep = walk(6, S, (f, x, y, c) => (c === 0 ? 90 : -30));
    const r = checkAnim(orig, up, rep, CARD_CHECK_DEFAULTS);
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/costume/);
    expect(Math.max(...r.deltaE)).toBeGreaterThan(12);
  });

  it("fails a repaint whose alpha isn't the upscaled original's", () => {
    const rep = walk(6, S);
    rep[1]!.data[(100 * rep[1]!.width + 60) * 4 + 3] = 0;
    expect(checkAnim(orig, up, rep, CARD_CHECK_DEFAULTS).why).toMatch(/alpha/);
  });

  it('fails a frame where no window can be measured, rather than pass it on a median of nothing', () => {
    // (the figure is the grey it is judged on: every window inside it is flat)
    const flat = (scale: number) => walk(6, scale).map(f => ({ ...f, data: f.data.map((v, k) => (k % 4 === 3 ? v : v === 0 && f.data[k - (k % 4) + 3] === 0 ? 0 : 128)) }));
    const r = checkAnim(flat(1), flat(S), flat(S), CARD_CHECK_DEFAULTS);
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/windows could be measured/);
  });

  it('skips the alignment (only) when asked, for an upscale-only card with nothing to measure', () => {
    const flat = (scale: number) => walk(6, scale).map(f => ({ ...f, data: f.data.map((v, k) => (k % 4 === 3 ? v : v === 0 && f.data[k - (k % 4) + 3] === 0 ? 0 : 128)) }));
    const r = checkAnim(flat(1), flat(S), flat(S), CARD_CHECK_DEFAULTS, { skipAlign: true });
    expect(r.ok).toBe(true);
    expect(r.alignment).toEqual([]);
    // (the alpha is still checked)
    const bad = flat(S).map(f => ({ ...f, data: f.data.map((v, k) => (k === 3 ? 255 - v : v)) }));
    expect(checkAnim(flat(1), flat(S), bad, CARD_CHECK_DEFAULTS, { skipAlign: true }).why).toMatch(/alpha/);
  });

  it('rejects mismatched lengths', () => {
    expect(() => checkAnim(orig, up, walk(5, S), CARD_CHECK_DEFAULTS)).toThrow(/length/);
  });
  void alphaOf;
});

describe('transitions between animations', () => {
  /** A w x h cell, opaque where `on` says, every pixel `value` in its colour channels. */
  const cell = (w: number, h: number, value: number, on: (x: number, y: number) => boolean = () => true): Rgba => {
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(on(x, y) ? [value, value, value, 255] : [0, 0, 0, 0], (y * w + x) * 4);
    return { width: w, height: h, data };
  };
  const placed = (up: Rgba, rep: Rgba, anchor: [number, number] = [0.5, 1]): Placed => ({ up, rep, anchor });

  it('is nothing when the repaint changes the two frames as the upscale does', () => {
    // (the same recolour of both: what differs between them is what differed in the upscale)
    expect(transitionFlicker(placed(cell(8, 8, 100), cell(8, 8, 130)), placed(cell(8, 8, 120), cell(8, 8, 150)))).toBe(0);
  });

  it('is the repaint\'s own change where it recolours the two differently', () => {
    expect(transitionFlicker(placed(cell(8, 8, 100), cell(8, 8, 130)), placed(cell(8, 8, 100), cell(8, 8, 150)))).toBe(20);
  });

  it('puts the two cells on their shared origin: cells of other sizes compare where the sprite\'s feet are', () => {
    // a 4 x 4 frame whose feet are the middle of its bottom row, against an 8 x 8 cell with a 4 x 4 patch at the same place: only the patch is compared
    const small = placed(cell(4, 4, 100), cell(4, 4, 140));
    const wide = placed(cell(8, 8, 100, (x, y) => x >= 2 && x < 6 && y >= 4), cell(8, 8, 160, (x, y) => x >= 2 && x < 6 && y >= 4));
    expect(transitionFlicker(small, wide)).toBe(20);
    // (and pixels outside the other's cell, or clear in either, are not compared)
    expect(transitionFlicker(small, placed(cell(8, 8, 100, x => x >= 6), cell(8, 8, 160, x => x >= 6)))).toBe(0);
  });

  it('fails a switch that jumps by more than the animation\'s own frames do, by the rules frames within one do', () => {
    const calm = placed(cell(8, 8, 100), cell(8, 8, 100));
    const jump = placed(cell(8, 8, 100), cell(8, 8, 140));
    expect(checkTransition(calm, calm, 0.5, CARD_CHECK_DEFAULTS)).toBeNull();
    expect(checkTransition(calm, jump, 0.5, CARD_CHECK_DEFAULTS)).toMatch(/flicker 40\.0/);
    // (within the absolute limit and the floor: not a failure however small the median)
    expect(checkTransition(calm, placed(cell(8, 8, 100), cell(8, 8, 101)), 0, CARD_CHECK_DEFAULTS)).toBeNull();
    // (an animation of one frame has no flicker of its own to be a multiple of: only the recipe's limit applies to a switch between such)
    expect(checkTransition(calm, placed(cell(8, 8, 100), cell(8, 8, 108)), null, CARD_CHECK_DEFAULTS)).toBeNull();
    expect(checkTransition(calm, jump, null, { ...CARD_CHECK_DEFAULTS, flickerMax: 12 })).toMatch(/limit 12/);
    // (and never over the recipe's own limit)
    expect(checkTransition(calm, jump, 30, { ...CARD_CHECK_DEFAULTS, flickerMax: 12 })).toMatch(/limit 12/);
  });
});
