// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { Object3D, OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { greyboxGlb, type GreyboxRoom } from '../testing/greybox';
import { DEFAULT_YFOV, fallbackRoom, fitFlat, parseRoom, readRoom, SCREEN_H } from './room';

const square = (x: number, z: number, size: number) =>
  [{ x, z }, { x: x + size, z }, { x: x + size, z: z + size }, { x, z: z + size }];

const room: GreyboxRoom = {
  regions: [{ name: 'r1', walkable: true, points: square(0, 0, 2) }, { name: 'r2', walkable: false, points: square(2, 0, 2) }],
  markers: { door: { x: 0.5, z: 0.5 }, 'panel.stand': { x: 1.5, z: 0.5 } },
  hotspots: [{ object: 'horst3.panel', at: { x: 1.5, z: 0.5 }, width: 0.5, height: 1, depth: 0.5, pickable: false, kind: 'walker' }],
  camera: { position: [1, 3, 8], yfov: DEFAULT_YFOV, horizonY: 100 },
};

const bytes = (u8: Uint8Array): ArrayBuffer => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
/** The row of the original's 480-row screen a world point lands on. */
function row(camera: PerspectiveCamera, p: Vector3): number {
  camera.updateMatrixWorld();
  return ((1 - p.clone().project(camera).y) / 2) * SCREEN_H;
}

describe('readRoom', () => {
  it('finds markers, regions, hotspots and the camera by their extras, dots and all', async () => {
    const view = await parseRoom(bytes(greyboxGlb(room)));
    expect([...view.markers]).toEqual([['door', { x: 0.5, z: 0.5 }], ['panel.stand', { x: 1.5, z: 0.5 }]]);
    expect(view.regions.get('r1')).toMatchObject({ name: 'r1', walkable: true });
    expect(view.regions.get('r1')!.triangles).toHaveLength(2);
    expect(view.regions.get('r1')!.triangles.flat()).toContainEqual({ x: 2, z: 2 });
    expect(view.regions.get('r2')!.walkable).toBe(false);
    expect(view.hotspots.get('horst3.panel')).toMatchObject({ object: 'horst3.panel', pickable: false, kind: 'walker' });
    expect(view.camera.position.toArray()).toEqual([1, 3, 8]);
    expect(view.modelled).toBe(true);
  });

  it("puts the horizon on its row of the original's screen", async () => {
    const view = await parseRoom(bytes(greyboxGlb(room)));
    const camera = view.camera as PerspectiveCamera;
    expect(row(camera, new Vector3(1, 0, -1e6))).toBeCloseTo(100, 1);
    // a floor point 8 m in front of a camera 3 m up is F·3/8 rows below the horizon
    const focal = SCREEN_H / 2 / Math.tan(DEFAULT_YFOV / 2);
    expect(row(camera, new Vector3(1, 0, 0))).toBeCloseTo(100 + (focal * 3) / 8, 1);
  });

  it("fits a flat screen's top-down camera to 4:3 without stretching", async () => {
    const view = await parseRoom(bytes(greyboxGlb({ ...room, camera: { ...room.camera, flat: { xmag: 5, ymag: 5 } } })));
    expect(view.camera).toBeInstanceOf(OrthographicCamera);
    const cam = view.camera as OrthographicCamera;
    expect((cam.right - cam.left) / (cam.top - cam.bottom)).toBeCloseTo(4 / 3, 6);
    expect(cam.top - cam.bottom).toBeCloseTo(10, 6);
  });

  it("fits a flat screen's camera and hotspots to the original's pixels, so a click on a drawn rectangle picks it", async () => {
    // (the lab's transporter console: 0.0125 m a column, and a row twice as deep, row 399 at z 0)
    const m = 0.0125;
    const rect: [number, number, number, number] = [384, 306, 456, 342];
    const view = await parseRoom(bytes(greyboxGlb({
      ...room,
      hotspots: [{ object: 'lab.lock_on', at: { x: (420 - 320) * m, z: (342 - 399) * m * 2 }, width: 72 * m, height: 0.45, depth: 0.05, pickable: true, kind: 'object', rect }],
      camera: { position: [0, 20, -4.975], yfov: DEFAULT_YFOV, horizonY: 0, flat: { xmag: 5, ymag: 5.5 } },
    })));
    fitFlat(view, m, 2 * m);
    const cam = view.camera as OrthographicCamera;
    cam.updateMatrixWorld(true);
    // (the screen's corners: column 0 and 640, row 0 and 480)
    const at = (col: number, r: number) => new Vector3((col - 320) * m, 0, (r - 399) * m * 2).project(cam);
    expect(at(0, 0).x).toBeCloseTo(-1, 6);
    expect(at(640, 480).x).toBeCloseTo(1, 6);
    expect(at(320, 0).y).toBeCloseTo(1, 6);
    expect(at(320, 480).y).toBeCloseTo(-1, 6);
    // (the box covers the whole rectangle, rising from the row its object stands on)
    const mesh = view.hotspots.get('lab.lock_on')!.mesh;
    mesh.updateMatrixWorld(true);
    mesh.geometry.computeBoundingBox();
    const box = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld);
    expect(box.min.z).toBeCloseTo((306 - 399) * m * 2, 6);
    expect(box.max.z).toBeCloseTo((342 - 399) * m * 2, 6);
  });

  it('refuses a room without a camera', () => {
    expect(() => readRoom(new Object3D())).toThrow('the room has no camera');
  });
});

describe('fallbackRoom', () => {
  it('makes up a flat, walkable floor around the markers, and a camera on it', () => {
    const view = fallbackRoom({ id: 'hall', markers: { a: { x: -2, z: 1 }, b: { x: 4, z: -3 } } });
    expect(view.modelled).toBe(false);
    expect(view.markers.get('b')).toEqual({ x: 4, z: -3 });
    const floor = view.regions.get('floor')!;
    expect(floor.walkable).toBe(true);
    expect(floor.triangles).toHaveLength(2);
    const xs = floor.triangles.flat().map(p => p.x);
    const zs = floor.triangles.flat().map(p => p.z);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)]).toEqual([-3.5, 5.5, -4.5, 2.5]);
    expect(view.camera).toBeInstanceOf(PerspectiveCamera);
    expect(view.hotspots.size).toBe(0);
  });
});
