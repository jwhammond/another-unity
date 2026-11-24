// SPDX-License-Identifier: GPL-3.0-or-later
import { Object3D, PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { BEAM_MS, BEAM_STEPS, BEAM_STEP_MS, BeamView, beamLines, beamStep, muzzleDirection, muzzleStart, type BeamColours } from './phaserFx';

describe('muzzleDirection (awayteam.cpp phaserShot)', () => {
  const me = { x: 300, y: 300 };
  it("picks the original's direction from where the target is: left, over or right of the shooter, and below, level with or above its feet", () => {
    // (a crew member has no width or height: the middle column is a target exactly over them, and the middle row one exactly level)
    expect(muzzleDirection(me, { x: 200, y: 350 })).toBe(7);
    expect(muzzleDirection(me, { x: 400, y: 350 })).toBe(5);
    expect(muzzleDirection(me, { x: 200, y: 300 })).toBe(9);
    expect(muzzleDirection(me, { x: 400, y: 300 })).toBe(5);
    expect(muzzleDirection(me, { x: 200, y: 200 })).toBe(10);
    expect(muzzleDirection(me, { x: 400, y: 200 })).toBe(2);
    // (an object with a width has a middle column)
    expect(muzzleDirection(me, { x: 300, y: 350 }, 20)).toBe(6);
    expect(muzzleDirection(me, { x: 310, y: 200 }, 20, 40)).toBe(0);
    expect(muzzleDirection(me, { x: 310, y: 280 }, 20, 40)).toBe(6);
  });
});

describe('muzzleStart', () => {
  it("is the muzzle's offset from the feet, right and up, scaled with the sprite", () => {
    expect(muzzleStart({ x: 300, y: 300 }, { x: 36, y: 105, frame: 8 }, 256)).toEqual({ x: 336, y: 195 });
    expect(muzzleStart({ x: 300, y: 300 }, { x: 36, y: 105, frame: 8 }, 128)).toEqual({ x: 318, y: 248 });
    expect(muzzleStart({ x: 300, y: 300 }, { x: -21, y: 82, frame: 8 }, 100)).toEqual({ x: 292, y: 268 });
  });
});

describe('beamLines', () => {
  const lines = (step: number, a = { x: 100, y: 100 }, b = { x: 140, y: 100 }) => beamLines(step, a, b);
  const count = (ls: ReturnType<typeof beamLines>, colour: string) => ls.filter(l => l.colour === colour).length;

  it('draws the core and an edge either side of it on every other step, and the core alone between', () => {
    for (const step of [0, 2, 4, 6, 14]) {
      const ls = lines(step);
      expect(count(ls, 'beam')).toBe(1);
      expect(count(ls, 'beamEdge')).toBe(2);
    }
    for (const step of [1, 3, 5, 15]) {
      const ls = lines(step);
      expect(count(ls, 'beam')).toBe(1);
      expect(count(ls, 'beamEdge')).toBe(0);
      expect(count(ls, 'pulseEdge')).toBe(0);
    }
  });

  it('puts the edges a pixel to the side: below and above a beam that runs across, left and right of one that runs up and down', () => {
    const across = lines(0);
    expect(across.filter(l => l.colour === 'beamEdge').map(l => l.a.y).sort((a, b) => a - b)).toEqual([99, 101]);
    const down = beamLines(0, { x: 100, y: 100 }, { x: 100, y: 160 });
    expect(down.filter(l => l.colour === 'beamEdge').map(l => l.a.x).sort((a, b) => a - b)).toEqual([99, 101]);
  });

  it("runs a pulse in every fourth segment, from the target back toward the shooter, the segments by how far apart they are", () => {
    // (40 pixels: 8 segments, a pulse on segment `phase` and `phase + 4`)
    const ls = lines(1);
    const pulses = ls.filter(l => l.colour === 'pulse');
    expect(pulses.map(l => [l.a.x, l.b.x])).toEqual([[135, 130], [115, 110]]);
    expect(lines(0).filter(l => l.colour === 'pulse').map(l => l.a.x)).toEqual([140, 120]);
    // (a long beam is cut into more: 0x1e0 and under 32, over it 64)
    const pulseCount = (x: number, y: number) => beamLines(0, { x: 0, y: 0 }, { x, y }).filter(l => l.colour === 'pulse').length;
    // (up to 0x78 pixels away, counted as |dx| + |dy|: 8 segments; up to 0xf0: 16; up to 0x1e0: 32; further: 64)
    expect([pulseCount(100, 0), pulseCount(200, 0), pulseCount(300, 100), pulseCount(600, 100)]).toEqual([2, 4, 8, 16]);
  });

  it('is over after 16 steps of 6 ticks of 291 a second, about a third of a second', () => {
    expect(BEAM_STEPS).toBe(16);
    expect(BEAM_STEP_MS).toBe(21);
    expect(beamStep(0)).toBe(0);
    expect(beamStep(BEAM_STEP_MS * 5 + 1)).toBe(5);
    expect(beamStep(BEAM_MS - 1)).toBe(15);
    expect(beamStep(BEAM_MS)).toBeNull();
  });
});

describe('BeamView', () => {
  const colours: BeamColours = { beam: [255, 0, 0], beamEdge: [0, 255, 0], pulse: [0, 0, 255], pulseEdge: [255, 255, 0] };

  it('draws each line as a quad one pixel across on the picture, in the beam\'s colours, and takes them away', () => {
    // (the picture is 480 rows over the camera's whole field; the quads stand a unit in front of it)
    const camera = new PerspectiveCamera(50, 640 / 480, 0.1, 100);
    camera.position.set(0, 3, 10);
    camera.lookAt(0, 3, 0);
    camera.updateMatrixWorld(true);
    const parent = new Object3D();
    const view = new BeamView(camera, parent, colours);
    view.show(beamLines(0, { x: 100, y: 100 }, { x: 140, y: 100 }));
    const core = parent.getObjectByName('phaser:beam') as import('three').Mesh;
    expect(core.visible).toBe(true);
    expect((core.material as import('three').MeshBasicMaterial).color.getHex()).toBe(0xff0000);
    const pos = core.geometry.getAttribute('position');
    // (each corner projects back to a pixel of the picture: a line from the middle of pixel 100 to the middle of pixel 140 of row 100, one pixel across)
    const px = [0, 1, 2, 3].map(i => {
      const v = new Vector3().fromBufferAttribute(pos, i).project(camera);
      return { x: ((v.x + 1) / 2) * 640, y: ((1 - v.y) / 2) * 480 };
    });
    expect(Math.min(...px.map(p => p.x))).toBeCloseTo(100, 3);
    expect(Math.max(...px.map(p => p.x))).toBeCloseTo(141, 3);
    expect(Math.min(...px.map(p => p.y))).toBeCloseTo(100, 3);
    expect(Math.max(...px.map(p => p.y))).toBeCloseTo(101, 3);
    // (a step with no edges hides them)
    view.show(beamLines(1, { x: 100, y: 100 }, { x: 140, y: 100 }));
    expect((parent.getObjectByName('phaser:beamEdge') as import('three').Mesh).visible).toBe(false);
    expect(core.visible).toBe(true);
    view.dispose();
    expect(parent.children).toHaveLength(0);
  });
});
