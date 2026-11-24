// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { CardAnim } from './art';
import { BeamRun, beamMillis, beamPhase, dissolveHides, DISSOLVE_STEP_MS, firstMillis, sparkleFrame, SPARKLE_FALLBACK_MS, type BeamTarget, type SparkleArt } from './beam';

describe('beamPhase', () => {
  it('beaming in: hidden while the sparkle plays, then a level up every step, then done', () => {
    expect(beamPhase(false, 0, 1000)).toEqual({ sparkle: 0, sparkleMs: 0, level: 0, done: false });
    expect(beamPhase(false, 999, 1000)).toMatchObject({ sparkle: 0, level: 0 });
    expect(beamPhase(false, 1000, 1000)).toMatchObject({ sparkle: 1, sparkleMs: 0, level: 0, done: false });
    expect(beamPhase(false, 1000 + DISSOLVE_STEP_MS * 3, 1000)).toMatchObject({ sparkle: 1, level: 3, done: false });
    expect(beamPhase(false, 1000 + DISSOLVE_STEP_MS * 6, 1000)).toMatchObject({ level: 6, done: false });
    expect(beamPhase(false, 1000 + DISSOLVE_STEP_MS * 7, 1000)).toMatchObject({ level: 6, done: true });
  });

  it('beaming out: whole while the sparkle plays, then a level down every step', () => {
    expect(beamPhase(true, 10, 1000)).toMatchObject({ sparkle: 0, level: 6 });
    expect(beamPhase(true, 1000, 1000)).toMatchObject({ sparkle: 1, level: 6 });
    expect(beamPhase(true, 1000 + DISSOLVE_STEP_MS * 2, 1000)).toMatchObject({ level: 4 });
    expect(beamPhase(true, 1000 + DISSOLVE_STEP_MS * 6, 1000)).toMatchObject({ level: 0, done: false });
    expect(beamPhase(true, 1000 + DISSOLVE_STEP_MS * 7, 1000)).toMatchObject({ level: 0, done: true });
  });

  it('gives up on a sparkle that runs past five seconds, as the original does', () => {
    expect(beamMillis(60_000)).toBe(5000 + 7 * DISSOLVE_STEP_MS);
    expect(beamPhase(false, 5000, 60_000).sparkle).toBe(1);
  });

  it('a step is 0x3c ticks of the original\'s 291 a second: 206 ms', () => {
    expect(DISSOLVE_STEP_MS).toBe(206);
  });
});

describe('dissolveHides', () => {
  it('hides everything at level 0 and nothing at level 6, for every row', () => {
    for (let row = 0; row < 4; row++) {
      for (let i = 0; i < 16; i++) {
        expect(dissolveHides(i % 4, Math.floor(i / 4), row, 0)).toBe(true);
        expect(dissolveHides(i % 4, Math.floor(i / 4), row, 6)).toBe(false);
      }
    }
  });

  it('hides fewer pixels a level up, and the 4x4 block repeats across the picture', () => {
    const count = (row: number, level: number): number => {
      let n = 0;
      for (let i = 0; i < 16; i++) if (dissolveHides(i % 4, Math.floor(i / 4), row, level)) n++;
      return n;
    };
    for (let row = 0; row < 4; row++) {
      let was = 16;
      for (let level = 1; level <= 6; level++) {
        const n = count(row, level);
        expect(n).toBeLessThan(was);
        was = n;
      }
    }
    // (row 0, level 1: 0xfbef hides all but the bits 4 and 10)
    expect(count(0, 1)).toBe(14);
    expect(dissolveHides(5, 9, 0, 1)).toBe(dissolveHides(1, 1, 0, 1));
    expect(dissolveHides(0, 0, 0, -1)).toBe(false);
  });
});

const anim = (frames: number, delay: number, extra: Partial<CardAnim> = {}): CardAnim => ({ url: 'a', frames, cell: [232, 704], anchor: [0.5, 1], delays: Array(frames).fill(delay) as number[], loop: false, ...extra });

describe('sparkleFrame', () => {
  it('shows each frame for its delay and holds the last', () => {
    const a = anim(4, 100);
    expect(sparkleFrame(a, 0).index).toBe(0);
    expect(sparkleFrame(a, 99).index).toBe(0);
    expect(sparkleFrame(a, 100).index).toBe(1);
    expect(sparkleFrame(a, 399).index).toBe(3);
    expect(sparkleFrame(a, 10_000).index).toBe(3);
  });

  it('gives the cell in the original\'s pixels and the uv window, rows from the top', () => {
    const f = sparkleFrame(anim(8, 10, { columns: 4, cell: [40, 80], scale: 4 }), 55);
    expect(f.index).toBe(5);
    expect(f.cell).toEqual([10, 20]);
    expect(f.uv).toEqual([0.25, 0, 0.5, 0.5]);
    expect(sparkleFrame(anim(3, 10), 0).uv).toEqual([0, 0, 1 / 3, 1]);
  });
});

describe('BeamRun', () => {
  const art = (first: number): SparkleArt => ({ anims: { 0: anim(2, first / 2), 1: anim(2, 50) }, texture: () => undefined });
  const target = () => {
    const log: string[] = [];
    const t: BeamTarget = { dissolve: l => log.push(`d${l}`), sparkle: (_t, f) => log.push(f ? `s${f.index}` : 's-'), clear: () => log.push('clear') };
    return { t, log };
  };

  it('takes its first phase from the sparkle art, or the fallback without one', () => {
    expect(firstMillis(art(1200))).toBe(1200);
    expect(firstMillis(undefined)).toBe(SPARKLE_FALLBACK_MS);
    expect(new BeamRun(false, [], art(1200), 0).totalMs).toBe(1200 + 7 * DISSOLVE_STEP_MS);
  });

  it('dissolves its targets with the phase, and ends with an out beam hidden and an in beam whole', () => {
    const a = target();
    const run = new BeamRun(false, [a.t], undefined, 1000);
    expect(run.update(1000)).toBe(false);
    expect(a.log.slice(0, 1)).toEqual(['d0']);
    expect(run.update(1000 + run.totalMs)).toBe(true);
    expect(a.log.at(-2)).toBe('d-1');
    run.finish();
    expect(a.log.slice(-2)).toEqual(['d-1', 'clear']);

    const b = target();
    const out = new BeamRun(true, [b.t], undefined, 0);
    out.update(out.totalMs);
    out.finish();
    expect(b.log.at(-2)).toBe('d0');
  });
});
