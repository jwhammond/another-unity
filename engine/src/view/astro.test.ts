// SPDX-License-Identifier: GPL-3.0-or-later
import { Mesh, OrthographicCamera } from 'three';
import { describe, expect, it } from 'vitest';
import { newMapCamera } from '../sim/astroCamera';
import { NOWHERE } from '../sim/ship';
import type { Universe } from '../content/types';
import { createAstroScene } from './astro';
import { MAP_WINDOW, paletteOf, type MapInput } from './astroLayout';

const empty = { numStars: 0, numPhenomena: 0, alignment: 0, firstStar: 0, firstPhenomenon: 0, station: -1, description: '', name: '', region: 0 };
function input(): MapInput {
  const sectors = Array.from({ length: 512 }, () => ({ ...empty }));
  sectors[292] = { ...empty, numStars: 1, firstStar: 0 };
  const universe: Universe = {
    sectors, stars: [{ id: 1, type: 0x20, seed: 0, x: 80, y: 80, z: 80, name: 'S', range: 0, flags: 0, spectralClass: 25, magnitude: 40, orbitScale: 10, systemName: '', scriptedName: '', scriptedDescription: '', special: -1 }],
    phenomena: [], stations: [], specials: [], flags: [], regionChatter: [], warpSpeeds: [], impulseSpeeds: [], scriptedWarps: [], planetOrbits: [4], reveals: [],
  };
  return {
    universe, flags: [0, 1], cam: { ...newMapCamera(), spinning: false }, selection: { ...NOWHERE, sector: 292 },
    ship: { pos: { x: 90, y: 90, z: 90 }, transit: null }, lightYears: 1, palette: paletteOf(), tables: {},
  };
}

describe('createAstroScene', () => {
  it('is one plane that a fixed orthographic camera fills, with no canvas to paint on away from a browser', () => {
    const map = createAstroScene();
    expect(map.camera).toBeInstanceOf(OrthographicCamera);
    expect(map.scene.children.filter(c => c instanceof Mesh)).toHaveLength(1);
    map.update(input(), 0);
    // (laid out all the same: a test can read what is on the map)
    expect(map.layout().entries).toHaveLength(1);
  });

  it('maps points between normalized device coordinates and the original\'s pixels, for the window\'s own aspect and a wider or taller one', () => {
    const map = createAstroScene();
    map.setAspect(MAP_WINDOW.width / MAP_WINDOW.height);
    expect(map.toMapPoint(0, 0)).toEqual({ x: MAP_WINDOW.x + MAP_WINDOW.width / 2, y: MAP_WINDOW.y + MAP_WINDOW.height / 2 });
    expect(map.toMapPoint(-1, 1)).toEqual({ x: MAP_WINDOW.x, y: MAP_WINDOW.y });
    expect(map.toMapPoint(1, -1)).toEqual({ x: MAP_WINDOW.x + MAP_WINDOW.width, y: MAP_WINDOW.y + MAP_WINDOW.height });
    // a wider viewport letterboxes it: the window's edge is inside, and past it there is no map
    map.setAspect(2 * MAP_WINDOW.width / MAP_WINDOW.height);
    expect(map.toMapPoint(1, 0)).toBeNull();
    expect(map.toMapPoint(0.5, 0)!.x).toBeCloseTo(MAP_WINDOW.x + MAP_WINDOW.width, 5);
    // a taller one likewise
    map.setAspect(0.5 * MAP_WINDOW.width / MAP_WINDOW.height);
    expect(map.toMapPoint(0, 1)).toBeNull();
    expect(map.toMapPoint(0, 0.5)!.y).toBeCloseTo(MAP_WINDOW.y, 5);
  });

  it('turns an entry into the point that picks it', () => {
    const map = createAstroScene();
    map.setAspect(MAP_WINDOW.width / MAP_WINDOW.height);
    map.update(input(), 0);
    const entry = map.layout().entries[0]!;
    // (the star at the galaxy's centre is at the projection's centre, 194, 184)
    const p = map.ndcOf(entry);
    expect(map.entryAtNdc(p.x, p.y)).toBe(0);
    expect(map.entryAtNdc(0.99, -0.99)).toBe(-1);
    map.setAspect(1.9);
    const q = map.ndcOf(entry);
    expect(map.entryAtNdc(q.x, q.y)).toBe(0);
  });

  it('pulls the camera back with the wheel, within limits, and keeps its background', () => {
    const map = createAstroScene();
    map.zoom(1000);
    expect(map.zoomFactor()).toBe(3);
    map.zoom(1e-9);
    expect(map.zoomFactor()).toBe(0.1);
    map.setBackground(0x000000);
    expect((map.scene.background as { getHex(): number }).getHex()).toBe(0);
  });

  it('ignores a pixel ratio that is not a number', () => {
    const map = createAstroScene();
    map.setAspect(Number.NaN);
    map.setAspect(-1);
    expect(map.toMapPoint(0, 0)).not.toBeNull();
  });
});
