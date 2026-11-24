// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeIO, type Document, type Node } from '@gltf-transform/core';
import type { Vec2 } from '@another-unity/engine';
import type { RoomFile, RoomRegion } from '@another-unity/lift/room';
import { afterEach, describe, expect, it } from 'vitest';
import { writeRoom } from './build';
import { runGreybox } from './cli';

const square = (x0: number): Vec2[] => [{ x: x0, z: 0 }, { x: x0 + 1, z: 0 }, { x: x0 + 1, z: -1 }, { x: x0, z: -1 }];
/** A square's two triangles, counter-clockwise seen from above. */
const SQUARE_TRIANGLES: [number, number, number][] = [[0, 1, 2], [0, 2, 3]];
const region = (name: string, points: Vec2[], triangles: [number, number, number][] = SQUARE_TRIANGLES, walkable = true): RoomRegion =>
  ({ name, walkable, type: walkable ? 1 : 0, points, triangles });

const room: RoomFile = {
  generated: 'tools/lift', screen: 'horst3.s01', world: 'horst3',
  background: { png: 'images/backgrounds/s_0701.png', original: 'sb007001.scr' },
  projection: { kind: 'perspective', slope: 0.859, horizonY: 101, meanScale: 192, topY: 101, metersPerPixel: 0.0125, samples: 4, rms: 0 },
  camera: { kind: 'perspective', position: [0, 3.725, 6.925], yfov: 0.8181, horizonY: 101 },
  regions: [region('r1', square(0)), region('r2', square(1)), region('r3', square(5), SQUARE_TRIANGLES, false)],
  markers: { entrance_0: { x: 0.5, z: -0.5 }, 'horst3.rubble': { x: 1.5, z: -0.5 } },
  hotspots: [{ object: 'horst3.rubble', at: { x: 1.5, z: -0.5 }, width: 0.8, height: 0.6, depth: 0.8, pickable: true, kind: 'object', rect: [60, 40, 100, 70], order: 70 }],
};

/** A typed array's numbers (Array.from on gltf-transform's TypedArray union gives unknown[]). */
const nums = (a: ArrayLike<number>): number[] => Array.from(a);
const read = async (bytes: Uint8Array): Promise<Document> => new NodeIO().readBinary(bytes);
const node = (doc: Document, name: string): Node => {
  const n = doc.getRoot().listNodes().find(x => x.getName() === name);
  if (!n) throw new Error(`no node ${name}`);
  return n;
};
const names = (doc: Document) => doc.getRoot().listNodes().map(n => n.getName());
const floorIndices = (doc: Document, name: string) =>
  nums(node(doc, `region:${name}`).getMesh()!.listPrimitives()[0].getIndices()!.getArray()!);
/** The walls as quads: each one's two bottom corners, [x, z] rounded to millimetres. */
const wallQuads = (doc: Document): [number, number][][] => {
  const n = doc.getRoot().listNodes().find(x => x.getName() === 'walls');
  if (!n) return [];
  const pos = nums(n.getMesh()!.listPrimitives()[0].getAttribute('POSITION')!.getArray()!);
  const quads: [number, number][][] = [];
  for (let i = 0; i < pos.length; i += 12) {
    quads.push([[pos[i], pos[i + 2]], [pos[i + 3], pos[i + 5]]].map(([x, z]) => [Math.round(x * 1000) / 1000, Math.round(z * 1000) / 1000]) as [number, number][]);
  }
  return quads;
};
const wallsWith = async (regions: RoomRegion[]) => wallQuads(await read(await writeRoom({ ...room, regions, hotspots: [], markers: {} })));

describe('buildRoom', () => {
  it('writes the regions, walls, markers, hotspots, camera and background, by name', async () => {
    const doc = await read(await writeRoom(room, new Uint8Array([0x89, 0x50, 0x4e, 0x47])));
    expect(names(doc)).toEqual([
      'region:r1', 'region:r2', 'region:r3', 'walls', 'marker:entrance_0', 'marker:horst3.rubble',
      'hotspot:horst3.rubble', 'camera:main', 'reference:background',
    ]);
    expect(node(doc, 'region:r3').getExtras()).toEqual({ region: 'r3', walkable: false, type: 0 });
    expect(doc.getRoot().listTextures()).toHaveLength(1);
  });

  it('lays floors facing up, and walls only on edges no other walkable region shares', async () => {
    const doc = await read(await writeRoom(room));
    const prim = node(doc, 'region:r1').getMesh()!.listPrimitives()[0];
    const pos = prim.getAttribute('POSITION')!;
    const [a, b, c] = nums(prim.getIndices()!.getArray()!).slice(0, 3).map(i => pos.getElement(i, []));
    const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    expect(ny).toBeGreaterThan(0);
    expect(prim.getIndices()!.getCount()).toBe(6);
    const walls = node(doc, 'walls').getMesh()!.listPrimitives()[0];
    expect(walls.getAttribute('POSITION')!.getCount()).toBe(6 * 4);
    expect(walls.getIndices()!.getCount()).toBe(6 * 6);
    expect(Math.max(...nums(walls.getAttribute('POSITION')!.getArray()!).filter((_, i) => i % 3 === 1))).toBe(2.5);
    expect(doc.getRoot().listNodes().some(n => n.getName() === 'reference:background')).toBe(false);
  });

  it("builds each floor from the region's own triangles, turned to face up", async () => {
    const ell: Vec2[] = [{ x: 0, z: 0 }, { x: 2, z: 0 }, { x: 2, z: -1 }, { x: 1, z: -1 }, { x: 1, z: -2 }, { x: 0, z: -2 }];
    const ellTriangles: [number, number, number][] = [[0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 5]];
    // (corner 1 is on a straight edge, so the lifter's triangles leave it out)
    const straight: Vec2[] = [{ x: 4, z: 0 }, { x: 5, z: 0 }, { x: 6, z: 0 }, { x: 6, z: -1 }, { x: 4, z: -1 }];
    const straightTriangles: [number, number, number][] = [[0, 2, 3], [0, 3, 4]];
    const doc = await read(await writeRoom({ ...room, regions: [
      region('ell', ell, ellTriangles), region('straight', straight, straightTriangles),
      // (pixel space runs y down, so a region's triangles can come out clockwise seen from above)
      region('flipped', square(8), [[0, 2, 1], [0, 3, 2]]),
    ] }));
    expect(floorIndices(doc, 'ell')).toEqual(ellTriangles.flat());
    expect(floorIndices(doc, 'straight')).toEqual(straightTriangles.flat());
    expect(floorIndices(doc, 'flipped')).toEqual(SQUARE_TRIANGLES.flat());
    expect(node(doc, 'region:straight').getMesh()!.listPrimitives()[0].getAttribute('POSITION')!.getCount()).toBe(5);
  });

  it('leaves no wall where a neighbour overlaps the edge, however the edge is split on each side', async () => {
    // B's left edge is split in two, A's right edge is one
    const b: Vec2[] = [{ x: 1, z: 0 }, { x: 2, z: 0 }, { x: 2, z: -1 }, { x: 1, z: -1 }, { x: 1, z: -0.5 }];
    const split = await wallsWith([region('a', square(0)), region('b', b, [[0, 1, 2], [0, 2, 3]])]);
    expect(split).toHaveLength(6);
    expect(split.some(q => q.every(([x]) => x === 1))).toBe(false);

    // welded in pixels, so the edges nearly line up: a centimetre apart and a little off parallel
    const near: Vec2[] = [{ x: 1.008, z: 0 }, { x: 2, z: 0 }, { x: 2, z: -1 }, { x: 1.004, z: -1 }];
    expect(await wallsWith([region('a', square(0)), region('near', near)])).toHaveLength(6);

    // B only covers the top half of A's edge: the bottom half keeps a wall
    const half: Vec2[] = [{ x: 1, z: 0 }, { x: 2, z: 0 }, { x: 2, z: -0.5 }, { x: 1, z: -0.5 }];
    const partial = await wallsWith([region('a', square(0)), region('half', half)]);
    expect(partial).toHaveLength(7);
    expect(partial.filter(q => q.every(([x]) => x === 1)).map(q => [...q].sort((p, r) => p[1] - r[1]))).toEqual([[[1, -1], [1, -0.5]]]);
  });

  it('gives walls their own single-sided material, each facing into its region, so the near ones cull from the room camera', async () => {
    // (a pixel-space region can wind either way: one each, and an ell with a reflex corner)
    const ccw = square(0);
    const cw = [...square(3)].reverse();
    const ell: Vec2[] = [{ x: 6, z: 0 }, { x: 8, z: 0 }, { x: 8, z: -1 }, { x: 7, z: -1 }, { x: 7, z: -2 }, { x: 6, z: -2 }];
    const regions = [region('ccw', ccw), region('cw', cw, [[0, 2, 1], [0, 3, 2]]), region('ell', ell, [[0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 5]])];
    const doc = await read(await writeRoom({ ...room, regions, hotspots: [], markers: {} }));
    const prim = node(doc, 'walls').getMesh()!.listPrimitives()[0];
    expect(prim.getMaterial()!.getName()).toBe('wall');
    expect(prim.getMaterial()!.getDoubleSided()).toBe(false);
    expect(node(doc, 'region:ccw').getMesh()!.listPrimitives()[0].getMaterial()!.getName()).not.toBe('wall');

    const inside = (p: Vec2, poly: Vec2[]) => poly.reduce((acc, a, i) => {
      const b = poly[(i + 1) % poly.length];
      return (a.z > p.z) !== (b.z > p.z) && p.x < a.x + ((p.z - a.z) * (b.x - a.x)) / (b.z - a.z) ? !acc : acc;
    }, false);
    const pos = prim.getAttribute('POSITION')!;
    const idx = nums(prim.getIndices()!.getArray()!);
    expect(idx.length / 6).toBe(4 + 4 + 6);
    for (let q = 0; q < idx.length; q += 6) {
      const [a, b, c] = idx.slice(q, q + 3).map(i => pos.getElement(i, []));
      // the first triangle's front normal (glTF fronts are counter-clockwise), and a step along it from the wall's foot
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = { x: u[1] * v[2] - u[2] * v[1], z: u[0] * v[1] - u[1] * v[0] };
      const len = Math.hypot(n.x, n.z);
      const foot = { x: (a[0] + b[0]) / 2 + (0.01 * n.x) / len, z: (a[2] + b[2]) / 2 + (0.01 * n.z) / len };
      expect(regions.some(r => inside(foot, r.points)), `wall ${q / 6} faces out`).toBe(true);
    }
  });

  it('keeps the walls where two regions only touch at a corner, or meet a closed region', async () => {
    const corner = square(1).map(p => ({ x: p.x, z: p.z - 1 }));
    expect(await wallsWith([region('a', square(0)), region('corner', corner)])).toHaveLength(8);
    expect(await wallsWith([region('a', square(0)), region('closed', square(1), SQUARE_TRIANGLES, false)])).toHaveLength(4);
  });

  it('places markers, and hotspots standing on the floor at their size', async () => {
    const doc = await read(await writeRoom(room));
    expect(node(doc, 'marker:horst3.rubble').getTranslation()).toEqual([1.5, 0, -0.5]);
    const h = node(doc, 'hotspot:horst3.rubble');
    expect(h.getTranslation()).toEqual([1.5, 0.3, -0.5]);
    expect(h.getScale()).toEqual([0.8, 0.6, 0.8]);
    // (the original's rectangle rides along, for the engine's hotspot debug view)
    expect(h.getExtras()).toEqual({ object: 'horst3.rubble', pickable: true, kind: 'object', rect: [60, 40, 100, 70], order: 70 });
  });

  it('puts in the fitted camera, or a top-down one for a flat screen', async () => {
    const doc = await read(await writeRoom(room));
    const cam = node(doc, 'camera:main');
    expect(cam.getTranslation()).toEqual([0, 3.725, 6.925]);
    expect(cam.getCamera()!.getType()).toBe('perspective');
    expect(cam.getCamera()!.getYFov()).toBeCloseTo(0.8181, 4);
    expect(cam.getExtras()).toEqual({ projection: 'perspective', horizonY: 101 });
    const flat = await read(await writeRoom({ ...room, camera: { kind: 'flat', position: [0, 20, -4.975], yfov: 0.8181, horizonY: 0 } }));
    const top = node(flat, 'camera:main');
    expect(top.getCamera()!.getType()).toBe('orthographic');
    expect(top.getRotation().map(v => Math.round(v * 1e4) / 1e4)).toEqual([-0.7071, 0, 0, 0.7071]);
  });

  it('builds a flat screen with no regions: no floor or walls, but its markers, hotspots and camera', async () => {
    const doc = await read(await writeRoom({ ...room, regions: [], camera: { kind: 'flat', position: [0, 20, -4.975], yfov: 0.8181, horizonY: 0 } }));
    expect(names(doc)).toEqual(['marker:entrance_0', 'marker:horst3.rubble', 'hotspot:horst3.rubble', 'camera:main']);
    expect(node(doc, 'camera:main').getCamera()!.getType()).toBe('orthographic');
  });
});

describe('the greybox command', () => {
  const temps: string[] = [];
  const tempDir = async (prefix: string) => {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    temps.push(dir);
    return dir;
  };
  afterEach(async () => {
    await Promise.all(temps.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  });

  it('builds a .glb for every room file, with its background when the images are given', async () => {
    const rooms = await tempDir('rooms-');
    const images = await tempDir('images-');
    const out = await tempDir('models-');
    await mkdir(join(rooms, 'horst3'), { recursive: true });
    await writeFile(join(rooms, 'horst3/s01.json'), JSON.stringify(room));
    await mkdir(join(images, 'images/backgrounds'), { recursive: true });
    await writeFile(join(images, 'images/backgrounds/s_0701.png'), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    const lines: string[] = [];
    expect(await runGreybox(['--rooms', rooms, '--images', images, '--out', out], line => lines.push(line))).toBe(0);
    expect(lines).toEqual(['wrote 1 rooms (1 with a background)']);
    const doc = await read(new Uint8Array(await readFile(join(out, 'horst3/s01.glb'))));
    expect(doc.getRoot().listTextures()).toHaveLength(1);
  });

  it('removes the .glb files whose room file is gone, and nothing else', async () => {
    const rooms = await tempDir('rooms-');
    const out = await tempDir('models-');
    await mkdir(join(rooms, 'horst3'), { recursive: true });
    await writeFile(join(rooms, 'horst3/s01.json'), JSON.stringify(room));
    await mkdir(join(out, 'horst3'), { recursive: true });
    await mkdir(join(out, 'frigis'), { recursive: true });
    await writeFile(join(out, 'horst3/s09.glb'), 'stale');
    await writeFile(join(out, 'frigis/s01.glb'), 'stale');
    await writeFile(join(out, 'horst3/notes.txt'), 'kept');
    const lines: string[] = [];
    expect(await runGreybox(['--rooms', rooms, '--out', out], line => lines.push(line))).toBe(0);
    expect(lines).toEqual(['removed frigis/s01.glb', 'removed horst3/s09.glb', 'wrote 1 rooms (0 with a background)']);
    expect((await readdir(join(out, 'horst3'))).sort()).toEqual(['notes.txt', 's01.glb']);
    expect(await readdir(join(out, 'frigis'))).toEqual([]);
  });

  it('fails on a missing rooms directory, and removes nothing', async () => {
    const out = await tempDir('models-');
    await writeFile(join(out, 's01.glb'), 'kept');
    await expect(runGreybox(['--rooms', join(out, 'no-such-rooms'), '--out', out], () => {})).rejects.toThrow(/ENOENT/);
    expect(await readdir(out)).toEqual(['s01.glb']);
  });
});
