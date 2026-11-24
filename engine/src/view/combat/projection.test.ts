// SPDX-License-Identifier: GPL-3.0-or-later
import { PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';
import { v3 } from '../../sim/combat/math';
import { builtModel, SAMPLE_VERTICES, samplePoses, threeProject } from '../../testing/projection';
import { fitDepth, focalLength, scummProject, setProjection, SPLIT_RECT, FULL_RECT } from './projection';

describe('the projection (M8 spec §3.1)', () => {
  it('has ScummVM\'s focal length: 160 / tan 30 degrees for Split, twice that for Full', () => {
    // (angleToRadians(0x555) = 0.523468 rad, 29.99 degrees, whose tangent is 0.577169: 277.21 and 554.42)
    expect(focalLength(SPLIT_RECT.width)).toBeCloseTo(277.21, 1);
    expect(focalLength(FULL_RECT.width)).toBeCloseTo(554.42, 1);
    const camera = new PerspectiveCamera();
    setProjection(camera, 320, 220, 1, 100);
    // (2 atan(110 / 277.17) = 43.3 degrees; Full's 2 atan(138 / 554.34) = 28.0)
    expect(camera.fov).toBeCloseTo(43.27, 1);
    setProjection(camera, 640, 276, 1, 100);
    expect(camera.fov).toBeCloseTo(27.96, 1);
  });

  it('puts every vertex where ScummVM\'s projection does, within half a pixel, at every sample pose, in Split and in Full', () => {
    const model = builtModel(SAMPLE_VERTICES);
    let compared = 0, worst = 0;
    for (const { pos, m, cam } of samplePoses()) {
      for (const [w, h] of [[SPLIT_RECT.width, SPLIT_RECT.height], [FULL_RECT.width, FULL_RECT.height]] as const) {
        const three = threeProject(model, SAMPLE_VERTICES, pos, m, cam, w, h);
        SAMPLE_VERTICES.forEach((v, i) => {
          const s = scummProject(v, pos, m, cam, w, h);
          if (s.z < 1) return;
          expect(Math.abs(three[i]!.x - s.x), `x of vertex ${i}`).toBeLessThan(0.5);
          expect(Math.abs(three[i]!.y - s.y), `y of vertex ${i}`).toBeLessThan(0.5);
          worst = Math.max(worst, Math.abs(three[i]!.x - s.x), Math.abs(three[i]!.y - s.y));
          compared++;
        });
      }
    }
    expect(compared).toBeGreaterThan(300);
    // (the half pixel is the bar; the two agree far closer, so a drift of a tenth of a pixel is caught too)
    expect(worst).toBeLessThan(0.01);
  });

  it('would miss a mirror: a model mirrored in x lands apart from ScummVM\'s', () => {
    const { pos, m, cam } = samplePoses()[2]!;
    const flipped = builtModel(SAMPLE_VERTICES);
    flipped.root.scale.x = -1;
    const three = threeProject(flipped, SAMPLE_VERTICES, pos, m, cam, 320, 220);
    const worst = Math.max(...SAMPLE_VERTICES.map((v, i) => Math.abs(three[i]!.x - scummProject(v, pos, m, cam, 320, 220).x)));
    expect(worst).toBeGreaterThan(5);
  });

  it('turns a billboard to the camera as drawObject does (space3d.cpp:299-300): placed with the camera\'s axes, scaled as SpaceModel::scale', () => {
    // (bboard's quad: 640 x 480 about the model's place, a unit in front of it; an explosion's scale of 0.25)
    const quad = [v3(320, -240, -1), v3(-320, -240, -1), v3(-320, 240, -1), v3(320, 240, -1)];
    const model = builtModel(quad);
    let compared = 0, worst = 0, turned = 0;
    for (const { pos, m, cam } of samplePoses()) {
      const three = threeProject(model, quad, pos, cam.axes, cam, 320, 220, 0.25);
      const own = threeProject(model, quad, pos, m, cam, 320, 220, 0.25);
      quad.forEach((v, i) => {
        const s = scummProject(v3(v.x * 0.25, v.y * 0.25, v.z * 0.25), pos, m, cam, 320, 220, true);
        if (s.z < 1) return;
        worst = Math.max(worst, Math.abs(three[i]!.x - s.x), Math.abs(three[i]!.y - s.y));
        turned = Math.max(turned, Math.abs(own[i]!.x - s.x));
        compared++;
      });
    }
    expect(compared).toBeGreaterThan(40);
    expect(worst).toBeLessThan(0.01);
    // (placed with the model's own orientation instead, it lands elsewhere)
    expect(turned).toBeGreaterThan(5);
  });
});

describe('fitDepth (M8 spec Decision 5)', () => {
  it('fits near and far to the drawn spheres, near at least 1 and far at most 256000 past the largest size', () => {
    expect(fitDepth([{ z: 5000, size: 300 }, { z: 20000, size: 800 }])).toEqual({ near: 4700, far: 20800 });
    expect(fitDepth([{ z: 100, size: 300 }])).toEqual({ near: 1, far: 400 });
    expect(fitDepth([{ z: 300000, size: 900 }, { z: 10, size: 5 }])).toEqual({ near: 5, far: 256900 });
    expect(fitDepth([])).toEqual({ near: 1, far: 2 });
  });
});
