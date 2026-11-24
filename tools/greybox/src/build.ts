// SPDX-License-Identifier: GPL-3.0-or-later
import { Document, NodeIO, type Buffer, type Material, type Mesh } from '@gltf-transform/core';
import type { Vec2 } from '@another-unity/engine';
import type { RoomFile, RoomRegion } from '@another-unity/lift/room';

export const WALL_HEIGHT = 2.5;
/**
 * How far apart (in metres) two walkable regions' edges may lie and still count as one shared edge.
 * The lifter welds near-miss gaps in pixels (floor.ts), so neighbours' edges only nearly line up.
 */
const SHARED_EDGE = 0.02;
/** A quaternion that turns the default camera (looking down -z) to look straight down. */
const LOOK_DOWN: [number, number, number, number] = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];

function makeMesh(doc: Document, buffer: Buffer, name: string, material: Material, positions: number[], indices: number[], uvs?: number[]): Mesh {
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(positions)).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(indices)).setBuffer(buffer))
    .setMaterial(material);
  if (uvs) prim.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(uvs)).setBuffer(buffer));
  return doc.createMesh(name).addPrimitive(prim);
}

const edgesOf = (r: RoomRegion): [Vec2, Vec2][] => r.points.map((a, i) => [a, r.points[(i + 1) % r.points.length]]);

/** Twice the region's signed area in (x, z): positive when its points run with the region to the left of each edge. */
const signedArea = (r: RoomRegion): number => edgesOf(r).reduce((sum, [a, b]) => sum + a.x * b.z - b.x * a.z, 0);

/**
 * The part of edge a-b (as a range of 0..1 along it) that edge c-d runs along, within SHARED_EDGE,
 * or undefined where they only touch at a point or don't meet.
 */
function overlap(a: Vec2, b: Vec2, c: Vec2, d: Vec2): [number, number] | undefined {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  if (len2 === 0) return undefined;
  const along = (p: Vec2) => ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2;
  const off = (p: Vec2) => Math.abs((p.x - a.x) * dz - (p.z - a.z) * dx) / Math.sqrt(len2);
  const [tc, td] = [along(c), along(d)];
  if (tc === td) return undefined;
  const t0 = Math.max(0, Math.min(tc, td));
  const t1 = Math.min(1, Math.max(tc, td));
  // (shorter than the tolerance is a point contact, or noise from the weld)
  if ((t1 - t0) * Math.sqrt(len2) <= SHARED_EDGE) return undefined;
  // c-d's points over that range: both must lie on a-b's line
  const at = (t: number): Vec2 => {
    const s = (t - tc) / (td - tc);
    return { x: c.x + (d.x - c.x) * s, z: c.z + (d.z - c.z) * s };
  };
  return off(at(t0)) <= SHARED_EDGE && off(at(t1)) <= SHARED_EDGE ? [t0, t1] : undefined;
}

/**
 * The stretches of walkable regions' edges that no other walkable region runs along: where the floor ends.
 * (Neighbours meet at near-miss, differently split edges, so this matches overlaps, not identical edges.)
 * Each runs with its region to its left in (x, z), so a quad on it, a-b then up, faces into the region.
 */
function wallEdges(regions: RoomRegion[]): [Vec2, Vec2][] {
  const walls: [Vec2, Vec2][] = [];
  regions.forEach((r, ri) => {
    const inward = signedArea(r) >= 0;
    const others = regions.flatMap((o, oi) => (oi === ri ? [] : edgesOf(o)));
    for (const [a, b] of edgesOf(r)) {
      const covered = others.map(([c, d]) => overlap(a, b, c, d))
        .filter((o): o is [number, number] => o !== undefined).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      const point = (t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
      let from = 0;
      for (const [t0, t1] of [...covered, [1, 1] as [number, number]]) {
        if ((t0 - from) * length > SHARED_EDGE) walls.push(inward ? [point(from), point(t0)] : [point(t0), point(from)]);
        from = Math.max(from, t1);
      }
    }
  });
  return walls;
}

export function buildRoom(room: RoomFile, background?: Uint8Array): Document {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene(room.screen);
  doc.getRoot().setDefaultScene(scene);
  const material = (name: string, color: [number, number, number, number]) =>
    doc.createMaterial(name).setBaseColorFactor(color).setDoubleSided(true).setAlphaMode(color[3] < 1 ? 'BLEND' : 'OPAQUE');
  const walkable = material('walkable', [0.55, 0.6, 0.65, 1]);
  const closed = material('closed', [0.4, 0.25, 0.25, 1]);
  // (single-sided, facing into the room: the walls between the camera and the floor cull, and don't hide it)
  const wall = material('wall', [0.75, 0.75, 0.7, 1]).setDoubleSided(false);
  const hotspot = material('hotspot', [1, 0.8, 0.2, 0.35]);

  for (const r of room.regions) {
    // the lifter's triangles (ear-clipped in pixels, room.ts), each turned counter-clockwise seen from above to face up
    const indices = r.triangles.flatMap(([a, b, c]) => {
      const [pa, pb, pc] = [r.points[a], r.points[b], r.points[c]];
      const up = (pb.z - pa.z) * (pc.x - pa.x) - (pb.x - pa.x) * (pc.z - pa.z);
      return up > 0 ? [a, b, c] : [a, c, b];
    });
    const mesh = makeMesh(doc, buffer, `region:${r.name}`, r.walkable ? walkable : closed, r.points.flatMap(p => [p.x, 0, p.z]), indices);
    scene.addChild(doc.createNode(`region:${r.name}`).setMesh(mesh).setExtras({ region: r.name, walkable: r.walkable, type: r.type }));
  }

  const edges = wallEdges(room.regions.filter(r => r.walkable));
  if (edges.length > 0) {
    const positions: number[] = [];
    const indices: number[] = [];
    // (a-b along the floor then up: counter-clockwise, glTF's front, seen from the region's side)
    edges.forEach(([a, b], i) => {
      positions.push(a.x, 0, a.z, b.x, 0, b.z, b.x, WALL_HEIGHT, b.z, a.x, WALL_HEIGHT, a.z);
      indices.push(4 * i, 4 * i + 1, 4 * i + 2, 4 * i, 4 * i + 2, 4 * i + 3);
    });
    scene.addChild(doc.createNode('walls').setMesh(makeMesh(doc, buffer, 'walls', wall, positions, indices)));
  }

  for (const [name, at] of Object.entries(room.markers)) {
    scene.addChild(doc.createNode(`marker:${name}`).setTranslation([at.x, 0, at.z]).setExtras({ marker: name }));
  }

  if (room.hotspots.length > 0) {
    const s = 0.5;
    const corners = [[-s, -s, -s], [s, -s, -s], [s, s, -s], [-s, s, -s], [-s, -s, s], [s, -s, s], [s, s, s], [-s, s, s]].flat();
    const faces = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
    const box = makeMesh(doc, buffer, 'hotspot', hotspot, corners, faces);
    for (const h of room.hotspots) {
      scene.addChild(doc.createNode(`hotspot:${h.object}`).setMesh(box)
        .setTranslation([h.at.x, h.height / 2, h.at.z]).setScale([h.width, h.height, h.depth])
        .setExtras({ object: h.object, pickable: h.pickable, kind: h.kind, ...(h.rect ? { rect: h.rect } : {}), order: h.order }));
    }
  }

  const xs = room.regions.flatMap(r => r.points.map(p => p.x));
  const zs = room.regions.flatMap(r => r.points.map(p => p.z));
  const width = xs.length > 0 ? Math.max(...xs) - Math.min(...xs) : 10;
  const depth = zs.length > 0 ? Math.max(...zs) - Math.min(...zs) : 10;
  const camera = doc.createCamera('main').setZNear(0.1).setZFar(1000);
  const camNode = doc.createNode('camera:main').setCamera(camera).setTranslation(room.camera.position)
    .setExtras({ projection: room.camera.kind, horizonY: room.camera.horizonY });
  if (room.camera.kind === 'perspective') {
    // (the original's view is off-axis by the horizon's row: Plan 5 shifts the projection by horizonY)
    camera.setType('perspective').setYFov(room.camera.yfov).setAspectRatio(4 / 3);
  } else {
    camera.setType('orthographic').setXMag(Math.max(width, 1) / 2 + 1).setYMag(Math.max(depth, 1) / 2 + 1);
    camNode.setRotation(LOOK_DOWN);
  }
  scene.addChild(camNode);

  if (background && room.background) {
    const texture = doc.createTexture('background').setImage(background).setMimeType('image/png');
    const reference = material('reference:background', [1, 1, 1, 1]).setBaseColorTexture(texture);
    const w = Math.max(width, 1) * 1.2;
    const h = w * 0.75;
    const z = (zs.length > 0 ? Math.min(...zs) : 0) - 1;
    const quad = makeMesh(doc, buffer, 'reference:background', reference,
      [-w / 2, 0, z, w / 2, 0, z, w / 2, h, z, -w / 2, h, z], [0, 1, 2, 0, 2, 3], [0, 1, 1, 1, 1, 0, 0, 0]);
    scene.addChild(doc.createNode('reference:background').setMesh(quad));
  }
  return doc;
}

export async function writeRoom(room: RoomFile, background?: Uint8Array): Promise<Uint8Array> {
  return new NodeIO().writeBinary(buildRoom(room, background));
}
