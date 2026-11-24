// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { Markers, NO_SCREEN } from './markers';
import { Problems } from './problems';
import { fitProjection } from './projection';

const floor = { type: 1, points: [{ x: 100, y: 250 }, { x: 540, y: 250 }, { x: 600, y: 399 }, { x: 40, y: 399 }], distances: [128, 128, 256, 256] };

function markers() {
  const problems = new Problems();
  const m = new Markers(problems);
  m.addScreen('horst3.s01', fitProjection([floor]));
  return { m, problems };
}

describe('Markers', () => {
  it('names positions, shares a point marker between equal pixels, and lists them sorted', () => {
    const { m, problems } = markers();
    expect(m.named('horst3.s01', 'entrance_0', 420, 399, 'here')).toBe('entrance_0');
    expect(m.point('horst3.s01', 420, 250, 'a')).toBe('p420_250');
    expect(m.point('horst3.s01', 420, 250, 'b')).toBe('p420_250');
    expect(m.screenMarkers('horst3.s01')).toEqual({ entrance_0: { x: 1.25, z: 0 }, p420_250: { x: 2.5, z: -6.925 } });
    expect(problems.errors).toEqual([]);
  });

  it('refuses one name for two places, and a screen that was not lifted', () => {
    const { m, problems } = markers();
    m.named('horst3.s01', 'horst3.rubble', 208, 336, 'a');
    m.named('horst3.s01', 'horst3.rubble', 209, 336, 'b');
    m.point('horst3.s09', 1, 2, 'c');
    m.point(NO_SCREEN, 1, 2, 'd');
    expect(problems.errors).toEqual([
      'b: marker "horst3.rubble" on horst3.s01 is already at (208, 336), not (209, 336)',
      'c: no lifted screen "horst3.s09" for marker "p1_2"',
    ]);
  });

  it('warns about a position above the floor\'s back edge', () => {
    const { m, problems } = markers();
    m.point('horst3.s01', 320, 60, 'o_070103#/use_entries/1/0');
    expect(problems.warnings).toEqual([
      "o_070103#/use_entries/1/0: (320, 60) is above the floor's back edge on horst3.s01 (row 250); it is placed on that edge",
    ]);
  });

  it('converts distances at their row, or at full scale without a screen, and keeps the raw pixels', () => {
    const { m } = markers();
    expect(m.distance('horst3.s01', 40, 250, 'near')).toBe(1);
    expect(m.distance(null, 40, 250, 'item')).toBe(0.5);
    const coords = m.coordsYaml();
    expect(coords.metersPerPixel).toBe(0.0125);
    expect(coords.distances).toEqual({ item: { px: 40, y: 250, units: 0.5 }, near: { px: 40, y: 250, units: 1 } });
    expect(coords.screens['horst3.s01'].projection.kind).toBe('perspective');
    expect(coords.screens['horst3.s01'].depthFactor).toEqual({ back: 3.718, front: 1.859 });
  });
});
