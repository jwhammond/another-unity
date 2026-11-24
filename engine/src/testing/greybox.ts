// SPDX-License-Identifier: GPL-3.0-or-later
import type { Vec2 } from '../content/types';

/** The parts of Plan 4's RoomFile a greybox .glb is made from (convex regions only). */
export interface GreyboxRoom {
  regions: { name: string; walkable: boolean; points: Vec2[] }[];
  markers: Record<string, Vec2>;
  hotspots: { object: string; at: Vec2; width: number; height: number; depth: number; pickable?: boolean; kind?: string; rect?: [number, number, number, number]; order?: number }[];
  /** `flat`: a flat screen's top-down orthographic camera, as Plan 4 writes one. */
  camera: { position: [number, number, number]; yfov: number; horizonY: number; flat?: { xmag: number; ymag: number } };
}

const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const S = 0.5;
const BOX_POSITIONS = [[-S, -S, -S], [S, -S, -S], [S, S, -S], [-S, S, -S], [-S, -S, S], [S, -S, S], [S, S, S], [-S, S, S]].flat();
const BOX_INDICES = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];

/**
 * A room .glb laid out as Plan 4's tools/greybox writes one (region:<name>, marker:<name>, hotspot:<object>,
 * camera:main, each with its extras), for tests and the demo. Regions are fanned from their first point.
 */
export function greyboxGlb(room: GreyboxRoom): Uint8Array {
  const bin: number[] = [];
  const bufferViews: Record<string, unknown>[] = [];
  const accessors: Record<string, unknown>[] = [];
  const meshes: Record<string, unknown>[] = [];
  const nodes: Record<string, unknown>[] = [];

  const view = (bytes: Uint8Array, target: number): number => {
    while (bin.length % 4 !== 0) bin.push(0);
    bufferViews.push({ buffer: 0, byteOffset: bin.length, byteLength: bytes.length, target });
    for (const b of bytes) bin.push(b);
    return bufferViews.length - 1;
  };
  const positions = (values: number[]): number => {
    const axis = (k: number) => values.filter((_, i) => i % 3 === k);
    accessors.push({
      bufferView: view(new Uint8Array(new Float32Array(values).buffer), ARRAY_BUFFER),
      componentType: FLOAT, count: values.length / 3, type: 'VEC3',
      min: [0, 1, 2].map(k => Math.fround(Math.min(...axis(k)))),
      max: [0, 1, 2].map(k => Math.fround(Math.max(...axis(k)))),
    });
    return accessors.length - 1;
  };
  const indices = (values: number[]): number => {
    accessors.push({
      bufferView: view(new Uint8Array(new Uint16Array(values).buffer), ELEMENT_ARRAY_BUFFER),
      componentType: UNSIGNED_SHORT, count: values.length, type: 'SCALAR',
    });
    return accessors.length - 1;
  };
  const mesh = (name: string, material: number, pos: number[], idx: number[]): number => {
    meshes.push({ name, primitives: [{ attributes: { POSITION: positions(pos) }, indices: indices(idx), material }] });
    return meshes.length - 1;
  };

  for (const r of room.regions) {
    const idx: number[] = [];
    for (let i = 1; i + 1 < r.points.length; i++) {
      const [a, b, c] = [r.points[0], r.points[i], r.points[i + 1]];
      // facing up: counter-clockwise seen from above
      const up = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
      idx.push(...(up > 0 ? [0, i, i + 1] : [0, i + 1, i]));
    }
    nodes.push({
      name: `region:${r.name}`,
      mesh: mesh(`region:${r.name}`, r.walkable ? 0 : 1, r.points.flatMap(p => [p.x, 0, p.z]), idx),
      extras: { region: r.name, walkable: r.walkable, type: r.walkable ? 1 : 0 },
    });
  }
  for (const [name, at] of Object.entries(room.markers)) {
    nodes.push({ name: `marker:${name}`, translation: [at.x, 0, at.z], extras: { marker: name } });
  }
  if (room.hotspots.length > 0) {
    const box = mesh('hotspot', 2, BOX_POSITIONS, BOX_INDICES);
    for (const h of room.hotspots) {
      nodes.push({
        name: `hotspot:${h.object}`, mesh: box,
        translation: [h.at.x, h.height / 2, h.at.z], scale: [h.width, h.height, h.depth],
        extras: { object: h.object, pickable: h.pickable ?? true, kind: h.kind ?? 'object', ...(h.rect ? { rect: h.rect } : {}), ...(h.order !== undefined ? { order: h.order } : {}) },
      });
    }
  }
  const flat = room.camera.flat;
  nodes.push({
    name: 'camera:main', camera: 0, translation: room.camera.position,
    // (a flat screen's camera looks straight down)
    ...(flat ? { rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2] } : {}),
    extras: { projection: flat ? 'flat' : 'perspective', horizonY: room.camera.horizonY },
  });

  while (bin.length % 4 !== 0) bin.push(0);
  const gltf = {
    asset: { version: '2.0', generator: 'another-unity greyboxGlb' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes, meshes, accessors, bufferViews,
    buffers: [{ byteLength: bin.length }],
    materials: [
      { name: 'walkable', pbrMetallicRoughness: { baseColorFactor: [0.55, 0.6, 0.65, 1] }, doubleSided: true },
      { name: 'closed', pbrMetallicRoughness: { baseColorFactor: [0.4, 0.25, 0.25, 1] }, doubleSided: true },
      { name: 'hotspot', pbrMetallicRoughness: { baseColorFactor: [1, 0.8, 0.2, 0.35] }, alphaMode: 'BLEND', doubleSided: true },
    ],
    cameras: [flat
      ? { type: 'orthographic', orthographic: { xmag: flat.xmag, ymag: flat.ymag, znear: 0.1, zfar: 1000 } }
      : { type: 'perspective', perspective: { yfov: room.camera.yfov, aspectRatio: 4 / 3, znear: 0.1, zfar: 1000 } }],
  };

  const json = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonPad = (4 - (json.length % 4)) % 4;
  const total = 12 + 8 + json.length + jsonPad + 8 + bin.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // glTF
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, json.length + jsonPad, true);
  dv.setUint32(16, 0x4e4f534a, true); // JSON
  out.set(json, 20);
  out.fill(0x20, 20 + json.length, 20 + json.length + jsonPad);
  const binAt = 20 + json.length + jsonPad;
  dv.setUint32(binAt, bin.length, true);
  dv.setUint32(binAt + 4, 0x004e4942, true); // BIN
  out.set(bin, binAt + 8);
  return out;
}
