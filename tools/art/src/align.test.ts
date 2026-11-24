// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { alignCheck, ALIGN_DEFAULTS, edgeMap, measureShift, overlay } from './align';
import type { Rgba } from './image';
import type { CheckPoint } from './points';

/** A 640x480 scene drawn here: a gentle gradient, rectangles and a line. Its corners are the points to check. */
function scene(): Rgba {
  const w = 640;
  const h = 480;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([60 + x / 16, 70 + y / 16, 80, 255], (y * w + x) * 4);
  const rect = (x0: number, y0: number, x1: number, y1: number, c: number[]): void => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data.set([...c, 255], (y * w + x) * 4);
  };
  rect(100, 100, 220, 200, [220, 210, 190]);
  rect(300, 60, 380, 260, [30, 30, 40]);
  rect(420, 300, 560, 400, [250, 240, 60]);
  rect(60, 320, 180, 420, [90, 160, 110]);
  rect(140, 140, 180, 170, [20, 20, 20]);
  return { width: w, height: h, data };
}
const corners: CheckPoint[] = [
  [100, 100], [220, 100], [100, 200], [220, 200], [300, 60], [380, 260], [420, 300], [560, 400], [60, 320], [180, 420],
].map(([x, y], i) => ({ x: x!, y: y!, source: `corner ${i}` }));

/** The image moved by (dx, dy) whole pixels, the edge repeated. */
function shifted(img: Rgba, dx: number, dy: number): Rgba {
  const out = new Uint8Array(img.data.length);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const sx = Math.min(img.width - 1, Math.max(0, x - dx));
      const sy = Math.min(img.height - 1, Math.max(0, y - dy));
      out.set(img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (y * img.width + x) * 4);
    }
  }
  return { width: img.width, height: img.height, data: out };
}
function nearest(img: Rgba, k: number): Rgba {
  const w = img.width * k;
  const h = img.height * k;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.set(img.data.subarray(((Math.floor(y / k)) * img.width + Math.floor(x / k)) * 4, ((Math.floor(y / k)) * img.width + Math.floor(x / k)) * 4 + 4), (y * w + x) * 4);
  return { width: w, height: h, data: out };
}
function noise(w: number, h: number): Rgba {
  let s = 12345;
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    data.set([s >>> 24, s >>> 24, s >>> 24, 255], i * 4);
  }
  return { width: w, height: h, data };
}

describe('alignCheck', () => {
  const original = scene();

  it('an image against itself passes every measurable point with shift 0', () => {
    const r = alignCheck(original, original, corners);
    expect(r.ok).toBe(true);
    expect(r.measured).toBe(corners.length);
    for (const p of r.points) expect(Math.hypot(p.dx, p.dy)).toBeLessThan(0.05);
  });

  it('a copy shifted by 1 px passes, with dx ~ 1', () => {
    const r = alignCheck(original, shifted(original, 1, 0), corners);
    expect(r.ok).toBe(true);
    for (const p of r.points) {
      expect(Math.abs(p.dx - 1)).toBeLessThan(0.25);
      expect(Math.abs(p.dy)).toBeLessThan(0.25);
    }
  });

  it('a copy shifted by 3 px fails at the points it moves', () => {
    const r = alignCheck(original, shifted(original, 3, 0), corners);
    expect(r.ok).toBe(false);
    expect(r.points.filter(p => p.verdict === 'fail').length).toBe(corners.length);
    expect(r.why).toMatch(/fail/);
  });

  it('a 4x plate of the scene, shifted by 8 plate px (2 original px), passes at the boundary; by 12 fails', () => {
    const plate = nearest(original, 4);
    expect(alignCheck(original, shifted(plate, 8, 0), corners, { ...ALIGN_DEFAULTS, maxDrift: Infinity }).ok).toBe(true);
    const far = alignCheck(original, shifted(plate, 12, 0), corners);
    expect(far.ok).toBe(false);
    expect(far.worst?.dx).toBeGreaterThan(2.5);
  });

  it('a plate that is not a whole multiple of the original is refused', () => {
    expect(() => alignCheck(original, { width: 1000, height: 750, data: new Uint8Array(1000 * 750 * 4) }, corners)).toThrow(/whole multiple/);
  });

  it('a flat window is reported flat and doesn\'t count; too few measurable points fail the check', () => {
    const flatPts: CheckPoint[] = [{ x: 20, y: 20, source: 'a' }, { x: 600, y: 30, source: 'b' }, { x: 320, y: 450, source: 'c' }];
    const mixed = alignCheck(original, original, [...corners, ...flatPts]);
    expect(mixed.points.filter(p => p.verdict === 'flat').map(p => p.source)).toEqual(['a', 'b', 'c']);
    expect(mixed.measured).toBe(corners.length);
    expect(mixed.ok).toBe(true);
    const bare = { ...ALIGN_DEFAULTS, minEdgeCoverage: 0 };
    const few = alignCheck(original, original, [...corners.slice(0, 2), ...flatPts], bare);
    expect(few.ok).toBe(false);
    expect(few.why).toMatch(/measurable/);
    expect(alignCheck(original, original, [], bare).ok).toBe(false);
  });

  it('a shift at the search edge fails rather than passing as 4', () => {
    const r = alignCheck(original, shifted(original, 4, 0), corners);
    expect(r.ok).toBe(false);
    const o = { ...ALIGN_DEFAULTS, maxShift: 10 };
    expect(alignCheck(original, shifted(original, 4, 0), corners, o).ok).toBe(false);
  });

  it('noise in place of the scene fails on peak, not shift', () => {
    const r = alignCheck(original, noise(640, 480), corners);
    expect(r.ok).toBe(false);
    for (const p of r.points.filter(q => q.verdict === 'fail')) expect(p.peak).toBeLessThan(ALIGN_DEFAULTS.minPeak);
    expect(r.points.some(p => p.verdict === 'fail')).toBe(true);
  });

  it('measureShift reports the sign: the plate\'s structure sits at +dx when it moved right', () => {
    const a = edgeMap(original);
    const b = edgeMap(shifted(original, 2, -1));
    const r = measureShift(a, b, corners[0]!);
    expect(r.dx).toBeGreaterThan(1.7);
    expect(r.dy).toBeLessThan(-0.7);
  });

  it('a window over a straight edge is judged on the axis it can measure, and a corner at the image border still measures both', () => {
    const w = 640;
    const h = 480;
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([y < 400 ? 150 : 0, y < 400 ? 150 : 0, y < 400 ? 150 : 0, 255], (y * w + x) * 4);
    const bars: Rgba = { width: w, height: h, data };
    const onEdge: CheckPoint[] = [{ x: 0, y: 400, source: 'letterbox at the border' }, { x: 300, y: 400, source: 'letterbox' }];
    // (the per-axis and drift checks are off here: this is the point-level verdict)
    // sideways it can't be told; up or down it can
    expect(alignCheck(bars, shifted(bars, 3, 0), onEdge, { ...ALIGN_DEFAULTS, minMeasured: 0, minAxis: 0, minAxisShare: 0, maxUnjudgeable: 2, maxDrift: Infinity }).ok).toBe(true);
    expect(alignCheck(bars, shifted(bars, 0, 3), onEdge, { ...ALIGN_DEFAULTS, minMeasured: 0, minAxis: 0, minAxisShare: 0, maxUnjudgeable: 2, maxDrift: Infinity }).ok).toBe(false);
    // the scene's corner at the top-left of the image: a window cut short by the border, not padded with a repeat
    const sc = scene();
    const corner: CheckPoint[] = [{ x: 0, y: 0, source: 'border' }];
    const r = alignCheck(sc, shifted(sc, 1, 1), [{ x: 100, y: 100, source: 'c' }, ...corner], { ...ALIGN_DEFAULTS, minMeasured: 0, minAxis: 0, minAxisShare: 0, maxUnjudgeable: 2, maxDrift: Infinity });
    expect(r.ok).toBe(true);
  });

  it('draws an overlay at 2x with a box at each point', () => {
    const r = alignCheck(original, shifted(original, 3, 0), corners);
    const o = overlay(original, shifted(original, 3, 0), r);
    expect(o).toMatchObject({ width: 1280, height: 960 });
    const i = ((200 - 12) * 1280 + 200) * 4; // above corner 0 (100,100): top edge of the box, x=200
    expect([...o.data.subarray(i, i + 3)]).toEqual([255, 0, 255]);
  });

  describe('the blind axis', () => {
    /** Full-width horizontal bands (blind along x) and one block with a corner that sees both axes. */
    function stripes(): Rgba {
      const w = 640;
      const h = 480;
      const data = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) {
        const v = Math.floor(y / 40) % 2 ? 200 : 60;
        for (let x = 0; x < w; x++) data.set([v, v, v, 255], (y * w + x) * 4);
      }
      for (let y = 100; y < 180; y++) for (let x = 300; x < 400; x++) data.set([250, 30, 30, 255], (y * w + x) * 4);
      return { width: w, height: h, data };
    }
    const edges: CheckPoint[] = [
      ...[80, 160, 240, 320, 400].flatMap(y => [60, 200, 500].map(x => ({ x, y: y + 0, source: `band ${x},${y}` }))),
      { x: 300, y: 100, source: 'block corner' },
    ];

    it('a plate moved 1 px along x fails: too few points can see x', () => {
      const base = stripes();
      const r = alignCheck(base, shifted(base, 1, 0), edges);
      expect(r.points.filter(p => p.blind === 'x').length).toBeGreaterThan(10);
      expect(r.ok).toBe(false);
      expect(r.why).toMatch(/can see the x axis/);
    });

    it('the same scene unmoved passes the y axis but still lacks x points', () => {
      const base = stripes();
      const r = alignCheck(base, base, edges);
      expect(r.axes!.y.n).toBe(edges.length);
      expect(r.why).toMatch(/x axis/);
    });

    it('points that all measure a 1.5 px shift fail as a global drift, though each is under maxShift', () => {
      const a = shifted(original, 1, 0);
      const b = shifted(original, 2, 0);
      const mid: Rgba = { width: a.width, height: a.height, data: a.data.map((v, i) => Math.round((v + b.data[i]!) / 2)) };
      const r = alignCheck(original, mid, corners);
      expect(r.points.every(p => p.verdict === 'pass')).toBe(true);
      expect(r.ok).toBe(false);
      expect(r.why).toMatch(/drifts .* along x/);
    });
  });
});

describe('a straight diagonal edge', () => {
  it('is unmeasurable (flat), like a straight horizontal one: the shift along it cannot be seen', () => {
    const img: Rgba = { width: 160, height: 120, data: new Uint8Array(160 * 120 * 4) };
    for (let y = 0; y < 120; y++) for (let x = 0; x < 160; x++) img.data.set(x - y > 20 ? [220, 220, 220, 255] : [30, 30, 30, 255], (y * 160 + x) * 4);
    const e = edgeMap(img);
    expect(measureShift(e, edgeMap(shifted(img, 3, 3)), { x: 80, y: 60, source: 'diag' }).verdict).toBe('flat');
  });
});

describe('a repeating texture', () => {
  const mesh = (w: number, h: number): Rgba => {
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(x % 6 < 3 && y % 6 < 3 ? [200, 200, 200, 255] : [30, 30, 30, 255], (y * w + x) * 4);
    return { width: w, height: h, data };
  };
  it('moved by most of a cell is never a failure (it reads as a small shift the other way, or is ambiguous); non-repeating noise moved the same is a failure', () => {
    const m = mesh(160, 120);
    // a shift of 4 on a period of 6 looks like a shift of -2: the window cannot tell
    expect(measureShift(edgeMap(m), edgeMap(shifted(m, 4, 0)), { x: 80, y: 60, source: 'mesh' }).verdict).not.toBe('fail');
    const n = noise(160, 120);
    expect(measureShift(edgeMap(n), edgeMap(shifted(n, 4, 0)), { x: 80, y: 60, source: 'noise' }).verdict).toBe('fail');
  });
});

describe('a non-repeating scene moved 2-3 px', () => {
  /** Hard-edged rectangles of random grey, sampled bilinearly at (x - dx, y - dy): structure with no period. */
  const blocks = (dx: number, dy: number): Rgba => {
    const w = 200;
    const h = 200;
    let seed = 12345;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const base = new Float32Array(w * h).fill(128);
    for (let k = 0; k < 60; k++) {
      const x0 = Math.floor(rnd() * w);
      const y0 = Math.floor(rnd() * h);
      const bw = 5 + Math.floor(rnd() * 30);
      const bh = 5 + Math.floor(rnd() * 30);
      const v = rnd() * 255;
      for (let y = y0; y < Math.min(h, y0 + bh); y++) for (let x = x0; x < Math.min(w, x0 + bw); x++) base[y * w + x] = v;
    }
    const g = (x: number, y: number): number => base[Math.min(h - 1, y) * w + Math.min(w - 1, x)]!;
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sx = Math.min(w - 1, Math.max(0, x - dx));
        const sy = Math.min(h - 1, Math.max(0, y - dy));
        const x0 = Math.floor(sx);
        const y0 = Math.floor(sy);
        const fx = sx - x0;
        const fy = sy - y0;
        const v = g(x0, y0) * (1 - fx) * (1 - fy) + g(x0 + 1, y0) * fx * (1 - fy) + g(x0, y0 + 1) * (1 - fx) * fy + g(x0 + 1, y0 + 1) * fx * fy;
        data.set([v, v, v, 255], (y * w + x) * 4);
      }
    }
    return { width: w, height: h, data };
  };
  it('fails, and is not called unjudgeable: the in-range neighbour of the best shift is its shoulder, not a repeat', () => {
    const a = edgeMap(blocks(0, 0));
    const pts: CheckPoint[] = [];
    for (let y = 30; y < 171; y += 20) for (let x = 30; x < 171; x += 20) pts.push({ x, y, source: `${x},${y}` });
    for (const shift of [2.5, 2.8]) {
      const b = edgeMap(blocks(shift, 0));
      const rs = pts.map(p => measureShift(a, b, p));
      // (a few windows along a locally straight edge stay ambiguous; it was about half of them)
      expect(rs.filter(r => r.unjudgeable).length).toBeLessThanOrEqual(pts.length / 10);
      expect(rs.filter(r => r.verdict === 'fail').length).toBeGreaterThan(pts.length / 2);
      expect(rs.filter(r => r.verdict === 'pass')).toHaveLength(0);
    }
  });
});

describe('a point in the image corner', () => {
  it('is unmeasurable when its window is cut to under half by the border', () => {
    const n = noise(160, 120);
    const e = edgeMap(n);
    expect(measureShift(e, e, { x: 0, y: 0, source: 'corner' }).verdict).toBe('flat');
    expect(measureShift(e, e, { x: 80, y: 0, source: 'top' }).verdict).toBe('pass');
  });
});

describe('the unjudgeable guard', () => {
  it('fails a room where 40% or more of the points are unjudgeable, and passes the same scene with fewer', () => {
    const n = noise(160, 120);
    const good: CheckPoint[] = [20, 40, 60, 80, 100, 120].map((x, i) => ({ x, y: 30 + 10 * (i % 3) + 20, source: `g${i}` }));
    const corners: CheckPoint[] = [0, 159].flatMap(x => [0, 119].map(y => ({ x, y, source: `c${x}-${y}` })));
    expect(alignCheck(n, n, [...good, ...corners.slice(0, 1)]).ok).toBe(true);
    const r = alignCheck(n, n, [...good.slice(0, 2), ...corners], { ...ALIGN_DEFAULTS, minEdgeCoverage: 0 });
    expect(r.unjudgeable).toBe(4);
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/unjudgeable/);
  });
});

/** The scene drawn dark (a fifth of the light) with its dither: noise that buries the fine edges of the original, not of a clean plate. */
function dithered(img: Rgba, amount: number): Rgba {
  const n = noise(img.width, img.height);
  const data = new Uint8Array(img.data.length);
  for (let i = 0; i < img.width * img.height; i++) {
    for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.max(0, Math.min(255, Math.round(img.data[i * 4 + c]! * 0.2 + (n.data[i * 4]! - 128) * amount)));
    data[i * 4 + 3] = 255;
  }
  return { width: img.width, height: img.height, data };
}

describe('dark, grainy originals', () => {
  const clean = scene();
  const grainy = dithered(clean, 0.25);

  it('a clean plate over a dithered original passes: the coarse scale finds the edges the grain hides', () => {
    const fineOnly = alignCheck(grainy, dark(clean), corners, { ...ALIGN_DEFAULTS, coarseRadius: 0 });
    const r = alignCheck(grainy, dark(clean), corners);
    expect(fineOnly.points.some(p => p.peak < ALIGN_DEFAULTS.minPeak)).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.points.some(p => p.scale === 'coarse')).toBe(true);
  });

  it('the same plate moved 3 px is refused, and moved 1 px is not', () => {
    expect(alignCheck(grainy, shifted(dark(clean), 3, 0), corners).ok).toBe(false);
    expect(alignCheck(grainy, shifted(dark(clean), 0, -3), corners).ok).toBe(false);
    expect(alignCheck(grainy, shifted(dark(clean), 1, 0), corners).ok).toBe(true);
    expect(alignCheck(grainy, shifted(dark(clean), 0, -1), corners).ok).toBe(true);
  });

  it('a plate with no structure of its own is still refused: low confidence is not a pass', () => {
    const r = alignCheck(grainy, noise(640, 480), corners);
    expect(r.ok).toBe(false);
  });

  it('points in black fall back on the original\'s own edges: a plate moved 3 px is refused there too', () => {
    // a black room with one lit panel: every hotspot corner lies in the black
    const room = new Uint8Array(640 * 480 * 4).fill(0);
    for (let i = 0; i < 640 * 480; i++) room[i * 4 + 3] = 255;
    for (let y = 400; y < 470; y++) for (let x = 100; x < 540; x++) room.set([40 + (x % 7) * 2, 60, 90 - (y % 5) * 3, 255], (y * 640 + x) * 4);
    const img: Rgba = { width: 640, height: 480, data: room };
    const inBlack: CheckPoint[] = [[20, 20], [600, 30], [320, 200], [40, 300]].map(([x, y], i) => ({ x: x!, y: y!, source: `black ${i}` }));
    const r = alignCheck(img, img, inBlack);
    expect(r.supplemented).toBeGreaterThan(0);
    const bare = alignCheck(img, img, inBlack, { ...ALIGN_DEFAULTS, minEdgeCoverage: 0 });
    expect(bare.ok).toBe(false);
    expect(alignCheck(img, shifted(img, 3, 0), inBlack).ok).toBe(false);
    expect(alignCheck(img, shifted(img, 0, 3), inBlack).ok).toBe(false);
  });
});

/** The plate as a dark picture too (the original is five times darker than the plate's light). */
function dark(img: Rgba): Rgba {
  const data = new Uint8Array(img.data);
  for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) data[i + c] = Math.round(data[i + c]! * 0.2);
  return { width: img.width, height: img.height, data };
}
