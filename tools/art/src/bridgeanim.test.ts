// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { bridgeStrips, gateStrip, playBridgeAnim, readScript, type CrewFrame } from './bridgeanim';
import type { Rgba } from './image';
import { COLOUR_BLANK } from './shipsprite';

const u32 = (n: number): number[] => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
const block = (type: string, body: number[]): number[] => [...[...type].map(c => c.charCodeAt(0)), ...u32(body.length + 8), ...body];
/** A type-2 image of single pixels (01 + 8-bit colour each). */
const image = (type: 'PMOC' | 'MOCS', width: number, colours: number[]): number[] => {
  const bits = colours.map(c => '01' + c.toString(2).padStart(8, '0')).join('');
  const bytes: number[] = [];
  for (let i = 0; i < bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8).padEnd(8, '0'), 2));
  return block(type, [...u32(width), ...u32(colours.length / width), 0x0d, 0, 2, 0, ...bytes]);
};
const signed = (n: number): number[] => u32(n >>> 0);

/** Animation 0: a 2x1 frame at POSN (10, 20), a wait, a 2x1 frame, a relPos of (3, 0), a wait, a jump to itself. */
function sprite(): Uint8Array {
  const blocks = [
    block('NSOP', [...u32(10), ...u32(20)]),
    image('PMOC', 2, [5, 6]),
    block('EMIT', u32(16 * 16)),
    image('PMOC', 2, [7, 8]),
    block('SOPR', [...signed(3), ...signed(0)]),
    block('EMIT', u32(16 * 16)),
    block('PMUJ', u32(0)),
  ];
  const body = [...u32(1), ...u32(8 + 4 + 4), ...blocks.flat()];
  // (the offset of animation 0 is its first block, from the LIST's start: 8 header bytes, the count, one offset)
  return new Uint8Array(block('TRPS', [...u32(0x1000), ...block('TSIL', body)]));
}

describe('bridge animations', () => {
  it('reads a sprite\'s script and plays it with every frame at its own offset from the origin', () => {
    const script = readScript(sprite());
    expect(script.entries.map(e => e.type)).toEqual(['position', 'sprite', 'wait', 'sprite', 'relPos', 'wait', 'jump']);
    const played = playBridgeAnim(script, 0, [0, 0], [10, 20]);
    const body = played.get(0)!;
    expect(body.loop).toBe(true);
    expect(body.frames.length).toBe(2);
    // (the feet at the POSN: a 2x1 frame's left is x - 1, top y - 1; the relPos of 3 moves the second frame right)
    expect(body.frames.map(f => [f.left, f.top])).toEqual([[-1, -1], [2, -1]]);
    expect(body.frames[0]!.wait).toBeGreaterThan(0);
  });

  it('packs the frames into one strip: each a cell, the frames at their offsets, the same anchor for all', async () => {
    const pal = new Uint8Array(256 * 3);
    pal.set([200, 0, 0], 5 * 3);
    pal.set([0, 200, 0], 7 * 3);
    const strips = await bridgeStrips(readScript(sprite()), pal, [0, 0], [10, 20], undefined, [0]);
    const a = strips.get(0)!;
    expect(a.frames).toBe(2);
    expect(a.loop).toBe(true);
    // (the cell is the union of both frames' rectangles, 5 wide: the second frame is 3 to the right)
    expect(a.cell).toEqual([5, 1]);
    expect(a.delays.length).toBe(2);
    expect(COLOUR_BLANK).toBe(13);
  });

  it('upscales each distinct frame once and packs the strip at the new scale', async () => {
    const pal = new Uint8Array(256 * 3);
    pal.set([200, 0, 0], 5 * 3);
    pal.set([0, 200, 0], 7 * 3);
    let calls = 0;
    const nearest = (f: { width: number; height: number; data: Uint8Array }) => {
      calls++;
      const out = { width: f.width * 4, height: f.height * 4, data: new Uint8Array(f.width * 4 * f.height * 4 * 4) };
      for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) out.data.set(f.data.subarray((Math.floor(y / 4) * f.width + Math.floor(x / 4)) * 4, (Math.floor(y / 4) * f.width + Math.floor(x / 4)) * 4 + 4), (y * out.width + x) * 4);
      return Promise.resolve(out);
    };
    const strips = await bridgeStrips(readScript(sprite()), pal, [0, 0], [10, 20], undefined, [0], { scale: 4, run: nearest });
    const a = strips.get(0)!;
    expect(a.scale).toBe(4);
    expect(calls).toBe(a.frames);
    // (the cell is still 5x1 original pixels, so 20x4 strip pixels)
    expect(a.cell).toEqual([20, 4]);
    expect(a.strip.width).toBe(20 * a.columns);
  });

  const gatePal = (): Uint8Array => {
    const pal = new Uint8Array(256 * 3);
    pal.set([200, 0, 0], 5 * 3);
    pal.set([0, 200, 0], 7 * 3);
    return pal;
  };
  const nearest = (f: { width: number; height: number; data: Uint8Array }) => {
    const out = { width: f.width * 4, height: f.height * 4, data: new Uint8Array(f.width * 4 * f.height * 4 * 4) };
    for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) out.data.set(f.data.subarray((Math.floor(y / 4) * f.width + Math.floor(x / 4)) * 4, (Math.floor(y / 4) * f.width + Math.floor(x / 4)) * 4 + 4), (y * out.width + x) * 4);
    return Promise.resolve(out);
  };
  const checks = { flickerRatio: Infinity, flickerMax: 12, deltaE: 12 };

  it('repaints each distinct upscaled frame of the sprite once, first frame first, and packs what passes the gate', async () => {
    const seen: { dx: number; dy: number; red: number }[][] = [];
    const log: string[] = [];
    const strips = await bridgeStrips(readScript(sprite()), gatePal(), [0, 0], [10, 20], undefined, [0], { scale: 4, run: nearest }, 'brdgtest.spr', {
      checks,
      log: l => log.push(l),
      paint: async (frames: CrewFrame[]) => {
        seen.push(frames.map(f => ({ dx: f.dx, dy: f.dy, red: f.png.data[0]! })));
        // (a light repaint: every colour 2 darker, the alpha kept)
        return frames.map(f => ({ ...f.png, data: f.png.data.map((v, i) => (i % 4 === 3 ? v : Math.max(0, v - 2))) }));
      },
    });
    expect(seen).toEqual([[{ dx: 0, dy: 0, red: 200 }, { dx: 3, dy: 0, red: 0 }]]);
    expect(log).toEqual([]);
    // (the first cell's first pixel is the painted frame's)
    expect([...strips.get(0)!.strip.data.subarray(0, 4)]).toEqual([198, 0, 0, 255]);
  });

  it('refuses a repainted strip that fails the gate, and publishes its upscale, saying why', async () => {
    for (const paint of [
      // (the colour far off: deltaE)
      (f: CrewFrame) => ({ ...f.png, data: f.png.data.map((v, i) => (i % 4 === 3 ? v : i % 4 === 2 ? 255 : 0)) }),
      // (the alpha changed)
      (f: CrewFrame) => ({ ...f.png, data: f.png.data.map((v, i) => (i % 4 === 3 ? 128 : v)) }),
    ]) {
      const log: string[] = [];
      const strips = await bridgeStrips(readScript(sprite()), gatePal(), [0, 0], [10, 20], undefined, [0], { scale: 4, run: nearest }, 'brdgtest.spr', { checks, log: l => log.push(l), paint: async frames => frames.map(paint) });
      expect([...strips.get(0)!.strip.data.subarray(0, 4)]).toEqual([200, 0, 0, 255]);
      expect(log.length).toBe(1);
      expect(log[0]).toMatch(/^brdgtest\.spr anim 0: the repaint is refused \(.+\); its strip is the upscale$/);
    }
  });

  it('gates on every frame pair\'s flicker, with no ratio', () => {
    // (two equal 8x8 frames: a repaint that changes between them flickers though the upscale doesn't)
    const flat = (v: number): Rgba => ({ width: 8, height: 8, data: new Uint8Array(8 * 8 * 4).map((_, i) => (i % 4 === 3 ? 255 : v)) });
    const small = { width: 2, height: 2, data: new Uint8Array(16).map((_, i) => (i % 4 === 3 ? 255 : 100)) };
    const orig = [{ png: small, dx: 1, dy: 2 }, { png: small, dx: 1, dy: 2 }];
    const up = [{ png: flat(100), dx: 1, dy: 2 }, { png: flat(100), dx: 1, dy: 2 }];
    expect(gateStrip(orig, up, [flat(100), flat(101)], 4, checks)).toBeNull();
    expect(gateStrip(orig, up, [flat(100), flat(130)], 4, { ...checks, deltaE: 100 })).toMatch(/flicker/);
  });
});
