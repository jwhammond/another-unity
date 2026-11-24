// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { fitCamera, project, unprojectToPlane, type Camera, type Vec3 } from './shipcam';

const cam = (over: Partial<Camera> = {}): Camera => ({ position: [0.4, 1.6, 7], yaw: 0.05, pitch: 0.1, roll: 0.02, fovY: 0.9, width: 640, height: 480, ...over });
const POINTS: Vec3[] = [
  [-3, 0, 0], [3, 0, -1], [0, 0, -4], [-4, 2.5, -5], [4, 2.2, -5], [0, 1.0, -2], [-2, 1.0, 2], [2.5, 1.0, 1], [0, 3, -5.5], [1, 0.4, -3],
];

describe('shipcam', () => {
  it('projects the point straight ahead onto the centre', () => {
    const c = cam({ position: [0, 1, 5], yaw: 0, pitch: 0, roll: 0 });
    const [u, v] = project(c, [0, 1, 0]);
    expect(u).toBeCloseTo(320, 6);
    expect(v).toBeCloseTo(240, 6);
    const [u2, v2] = project(c, [1, 2, 0]); // right and up of centre
    expect(u2).toBeGreaterThan(320);
    expect(v2).toBeLessThan(240);
  });
  it('project and unprojectToPlane round-trip on the floor plane within 1e-6', () => {
    const c = cam();
    for (const p of POINTS.filter(q => q[1] === 0)) {
      const q = unprojectToPlane(c, project(c, p), { normal: [0, 1, 0], d: 0 });
      for (let i = 0; i < 3; i++) expect(Math.abs(q[i]! - p[i]!)).toBeLessThan(1e-6);
    }
  });
  it('unprojectToPlane throws when the ray misses the plane (above the horizon)', () => {
    const c = cam({ pitch: 0.4 });
    expect(() => unprojectToPlane(c, [320, 0], { normal: [0, 1, 0], d: 0 })).toThrow(/plane/);
  });
  it('fitCamera recovers a known camera and reports per-point residuals', () => {
    const truth = cam();
    const trace = POINTS.map(p => [...project(truth, p), ...p] as [number, number, number, number, number]);
    const start = cam({ position: [0, 1.4, 8], yaw: 0, pitch: 0.02, roll: 0, fovY: 0.8 });
    const r = fitCamera(trace, start);
    expect(r.rms).toBeLessThan(0.05);
    expect(r.residuals).toHaveLength(trace.length);
    expect(r.camera.fovY).toBeCloseTo(truth.fovY, 3);
    expect(r.camera.yaw).toBeCloseTo(truth.yaw, 3);
    expect(r.camera.position[2]).toBeCloseTo(truth.position[2], 2);
  });
  it('fitCamera with noisy points reports the rms of what it could not explain', () => {
    const truth = cam();
    const trace = POINTS.map((p, i) => {
      const [u, v] = project(truth, p);
      return [u + (i % 2 ? 1.5 : -1.5), v, ...p] as [number, number, number, number, number];
    });
    const r = fitCamera(trace, cam({ fovY: 0.8, position: [0, 1.5, 7.5] }));
    expect(r.rms).toBeGreaterThan(0.5);
    expect(r.rms).toBeLessThan(2.5);
  });
  it('a lens shift lifts the principal point and the round trip still holds', () => {
    const c = cam({ position: [0, 1.5, 6], yaw: 0, pitch: 0, roll: 0, shiftY: 100 });
    const [, v] = project(c, [0, 1.5, 0]); // eye height: on the horizon
    expect(v).toBeCloseTo(140, 6);
    const q = unprojectToPlane(c, project(c, [1.2, 0, -2]), { normal: [0, 1, 0], d: 0 });
    expect(q[0]).toBeCloseTo(1.2, 6);
    expect(q[2]).toBeCloseTo(-2, 6);
  });
  it('fitCamera solves the lens shift when it is freed, and leaves held parameters alone', () => {
    const truth = cam({ yaw: 0.03, pitch: 0, roll: 0, shiftY: 90 });
    const trace = POINTS.map(p => [...project(truth, p), ...p] as [number, number, number, number, number]);
    const start = cam({ position: [0, 1.5, 7.5], yaw: 0, pitch: 0, roll: 0, fovY: 0.8, shiftY: 40 });
    const r = fitCamera(trace, start, ['x', 'y', 'z', 'yaw', 'fovY', 'shiftY']);
    expect(r.rms).toBeLessThan(0.05);
    expect(r.camera.shiftY).toBeCloseTo(90, 1);
    expect(r.camera.pitch).toBe(0);
    expect(r.camera.roll).toBe(0);
  });
  it('fitCamera refuses fewer than 4 points', () => {
    expect(() => fitCamera([[1, 1, 0, 0, 0]], cam())).toThrow(/at least 4/);
  });
});
