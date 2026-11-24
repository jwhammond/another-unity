// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { fitProjection, MAX_RMS } from './projection';
import { liftStartup, registerScreen, screenDef } from './screens';
import { rawFromMini, testCtx } from './testing/ctx';
import { Markers } from './markers';

/** A context with no screens registered yet, as liftGame starts. */
function freshCtx() {
  const ctx = testCtx(rawFromMini());
  ctx.markers = new Markers(ctx.problems);
  ctx.regions.clear();
  ctx.entrances.clear();
  return ctx;
}

describe('screens', () => {
  it('registers a screen\'s four slots per entrance and its regions', () => {
    const ctx = freshCtx();
    const s = ctx.raw.screens.get('s_0701')!;
    expect(registerScreen(ctx, s, fitProjection(s.polygons))).toBe('horst3.s01');
    const def = screenDef(ctx, s, undefined);
    expect(Object.keys(def.markers)).toEqual([
      'entrance_0', 'entrance_0.1', 'entrance_0.2', 'entrance_0.3', 'entrance_1', 'entrance_1.1', 'entrance_1.2', 'entrance_1.3',
    ]);
    expect(def).toMatchObject({ id: 'horst3.s01', regions: { r23: true, r24: false }, world: 'horst3' });
    // the fitted projection, without the fit's own numbers, so the sim can measure in the original's pixels
    const { samples, rms, ...metric } = fitProjection(s.polygons).params;
    expect(def.pixelMetric).toMatchObject(metric);
    expect(def.pixelMetric).not.toHaveProperty('samples');
    // and every polygon, in order, unwelded, with its corners' scales, so the sim walks as walk.cpp does
    expect(def.pixelMetric?.floor.map(p => p.region)).toEqual(s.polygons.map(p => `r${p.id}`));
    s.polygons.forEach((p, i) => {
      expect(def.pixelMetric?.floor[i].points).toEqual(p.points.map((pt, j) => ({ x: pt.x, y: pt.y, scale: p.distances[j] })));
    });
    expect(ctx.entrances.get('s_0701')).toBe(2);
    expect(ctx.problems.warnings).toEqual([]);
  });

  it('warns about a screen with no floor that isn\'t a close-up (M3 Decision 8)', () => {
    const NO_FLOOR = "s_0701: no floor, and not a close-up: the team stands at its entrances and can't walk (M3 Decision 8)";
    const ctx = freshCtx();
    const s = { ...ctx.raw.screens.get('s_0701')!, polygons: [] };
    registerScreen(ctx, s, fitProjection(s.polygons));
    screenDef(ctx, s, undefined);
    expect(ctx.problems.warnings.filter(w => w.includes('no floor'))).toEqual([NO_FLOOR]);
    const quiet = freshCtx();
    registerScreen(quiet, s, fitProjection(s.polygons));
    screenDef(quiet, s, { closeup: true });
    expect(quiet.problems.warnings.filter(w => w.includes('no floor'))).toEqual([]);
  });

  it('gives a screen without a location one entrance at the bottom middle, and a flat projection', () => {
    const ctx = freshCtx();
    const s = ctx.raw.screens.get('s_0703')!;
    registerScreen(ctx, s, fitProjection(s.polygons));
    expect(screenDef(ctx, s, { closeup: true })).toEqual({
      id: 'horst3.s03', markers: { entrance_0: { x: 0, z: 0 } }, world: 'horst3', startup: { closeup: true },
      pixelMetric: { kind: 'flat', slope: 0, horizonY: 0, meanScale: 256, topY: 0, metersPerPixel: 0.0125, floor: [] },
    });
    expect(ctx.problems.warnings).toEqual([
      's_0703: no entrances (a close-up, or not in slNNN.scr): entrance_0 is the bottom middle',
      's_0703: a flat projection (0 scale samples)',
    ]);
  });

  it('warns when the projection fits the polygons\' scales loosely', () => {
    const ctx = freshCtx();
    const s = ctx.raw.screens.get('s_0701')!;
    const pt = (x: number, y: number) => ({ x, y });
    // (scales that grow down the screen, but too unevenly for a straight line within MAX_RMS of them)
    const loose = { ...s, polygons: [{ id: 23, type: 1, points: [pt(0, 250), pt(640, 250), pt(640, 330), pt(0, 330), pt(0, 399)], distances: [40, 120, 200, 80, 250] }] };
    const projection = fitProjection(loose.polygons);
    expect(projection.params.rms).toBeGreaterThan(MAX_RMS);
    registerScreen(ctx, loose, projection);
    expect(ctx.problems.warnings).toEqual([
      `s_0701: the projection fits the polygons' scales loosely (RMS ${projection.params.rms}); check it in the greybox, or set it in overrides/coords.yaml`,
    ]);
  });

  it('lifts startups as startAwayTeam applies them', () => {
    const ctx = testCtx();
    const w = ctx.raw.worlds.get('w_07')!;
    expect(liftStartup(ctx, w, 1, 'horst3.s01')).toEqual({
      advice: { id: 'horst3.a1' }, combadge: true, inputBlocked: false, action: { verb: 'use', target: 'horst3.setup_world', who: 'horst3.setup_world' },
    });
    expect(liftStartup(ctx, w, 2, 'horst3.s02')).toBeUndefined();
    expect(liftStartup(ctx, w, 3, 'horst3.s03')).toEqual({ closeup: true });
    expect(ctx.problems.warnings).toEqual([]);
  });
});
