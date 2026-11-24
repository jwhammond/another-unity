// SPDX-License-Identifier: GPL-3.0-or-later
import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { ScreenDef, Vec2 } from '../content/types';

export type Triangle = [Vec2, Vec2, Vec2];

export interface RoomRegion {
  name: string;
  /** The polygon's own type; the sim's state.regions can switch it (PathBlocks). */
  walkable: boolean;
  mesh: Mesh;
  /** Its floor triangles, on the ground plane. */
  triangles: Triangle[];
}

export interface RoomHotspot {
  object: string;
  /** objectAt (unity.cpp:225-258): whether a click can pick it at all. */
  pickable: boolean;
  kind: string;
  mesh: Mesh;
  /** The rectangle the original tests, in its pixels: [x0, y0, x1, y1] (lift's `rect`), when the model carries it. */
  rect?: [number, number, number, number];
  /** The row objectAt checks it by, front first (DrawOrderComparison: its y_adjust, or its y): lift's `order`, when the model carries it. */
  order?: number;
}

export interface RoomView {
  root: Object3D;
  camera: PerspectiveCamera | OrthographicCamera;
  markers: Map<string, Vec2>;
  regions: Map<string, RoomRegion>;
  hotspots: Map<string, RoomHotspot>;
  /** False for a floor made up from the screen's markers, because there was no model. */
  modelled: boolean;
}

/** The original's screen: the camera's horizon row is counted on it. */
export const SCREEN_W = 640;
export const SCREEN_H = 480;
/** The bottom row of the play area, where a flat screen's z is 0 (projection.ts NEAR_Y). */
const NEAR_ROW = 399;
/** Plan 4's camera: a 60° horizontal field of view over 640 pixels. */
export const DEFAULT_YFOV = 0.8181;
/** How far a made-up floor reaches past the outermost markers. */
const FALLBACK_MARGIN = 1.5;

const round = (v: number) => Math.round(v * 1e4) / 1e4 + 0;

/**
 * The original's view is off-axis: a level camera whose horizon is on row horizonY, not the middle row
 * (Plan 4's camera:main). Shifting the view window does that without tilting the camera.
 */
export function frameCamera(camera: PerspectiveCamera, horizonY: number): void {
  camera.aspect = SCREEN_W / SCREEN_H;
  camera.setViewOffset(SCREEN_W, SCREEN_H, 0, SCREEN_H / 2 - horizonY, SCREEN_W, SCREEN_H);
  camera.updateProjectionMatrix();
}

function trianglesOf(mesh: Mesh): Triangle[] {
  const geometry = mesh.geometry as BufferGeometry;
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const count = index ? index.count : position.count;
  const vertex = (k: number): Vec2 => {
    const v = new Vector3().fromBufferAttribute(position, index ? index.getX(k) : k).applyMatrix4(mesh.matrixWorld);
    return { x: round(v.x), z: round(v.z) };
  };
  const out: Triangle[] = [];
  for (let k = 0; k + 2 < count; k += 3) out.push([vertex(k), vertex(k + 1), vertex(k + 2)]);
  return out;
}

/**
 * Reads a room glTF's scene (Plan 4 Task 13's node table). GLTFLoader strips ':' and '.' from node names,
 * so the nodes are found by their extras, which it keeps in userData.
 */
export function readRoom(root: Object3D): RoomView {
  root.updateMatrixWorld(true);
  const markers = new Map<string, Vec2>();
  const regions = new Map<string, RoomRegion>();
  const hotspots = new Map<string, RoomHotspot>();
  // (declared this way so the narrowing inside traverse's callback doesn't fix it as null)
  let camera = null as PerspectiveCamera | OrthographicCamera | null;
  root.traverse(obj => {
    const x = obj.userData as Record<string, unknown>;
    if (typeof x.marker === 'string') {
      const p = obj.getWorldPosition(new Vector3());
      markers.set(x.marker, { x: round(p.x), z: round(p.z) });
    } else if (typeof x.region === 'string' && obj instanceof Mesh) {
      regions.set(x.region, { name: x.region, walkable: x.walkable === true, mesh: obj, triangles: trianglesOf(obj) });
    } else if (typeof x.object === 'string' && obj instanceof Mesh) {
      const rect = Array.isArray(x.rect) && x.rect.length === 4 && x.rect.every(v => typeof v === 'number') ? (x.rect as [number, number, number, number]) : undefined;
      hotspots.set(x.object, { object: x.object, pickable: x.pickable !== false, kind: typeof x.kind === 'string' ? x.kind : 'object', mesh: obj, ...(rect ? { rect } : {}), ...(typeof x.order === 'number' ? { order: x.order } : {}) });
    } else if (obj instanceof PerspectiveCamera || obj instanceof OrthographicCamera) {
      camera = obj;
    }
  });
  if (camera === null) throw new Error('the room has no camera');
  const cam: PerspectiveCamera | OrthographicCamera = camera;
  if (cam instanceof PerspectiveCamera) frameCamera(cam, Number(cam.userData.horizonY ?? SCREEN_H / 2));
  else fitOrthographic(cam);
  return { root, camera: cam, markers, regions, hotspots, modelled: true };
}

/** A flat screen's top-down camera, widened to the canvas's 4:3 so nothing is stretched. */
export function fitOrthographic(camera: OrthographicCamera): void {
  const aspect = SCREEN_W / SCREEN_H;
  const w = camera.right - camera.left;
  const h = camera.top - camera.bottom;
  if (w / h < aspect) {
    const cx = (camera.left + camera.right) / 2;
    camera.left = cx - (h * aspect) / 2;
    camera.right = cx + (h * aspect) / 2;
  } else {
    const cy = (camera.top + camera.bottom) / 2;
    camera.top = cy + w / aspect / 2;
    camera.bottom = cy - w / aspect / 2;
  }
  camera.updateProjectionMatrix();
}

/**
 * Lays a flat screen's top-down camera over the original's 640 by 480 pixels: a column is `perColumn` metres across and a
 * row `perRow` deep (the projection's, 2:1), so a drawn rectangle is where its hotspot is picked. A hotspot's box is a
 * thin panel for a perspective camera; from above it is a sliver, so here it spans its rectangle's rows, upward from the
 * row its object stands on (the original's rectangle ends there).
 */
export function fitFlat(room: RoomView, perColumn: number, perRow: number): void {
  const camera = room.camera;
  if (!(camera instanceof OrthographicCamera)) return;
  // (row 399 is z 0 and column 320 is x 0; the view's up is toward -z)
  const centreRow = SCREEN_H / 2;
  camera.left = (-SCREEN_W / 2) * perColumn;
  camera.right = (SCREEN_W / 2) * perColumn;
  camera.top = (SCREEN_H / 2) * perRow;
  camera.bottom = (-SCREEN_H / 2) * perRow;
  camera.zoom = 1;
  camera.position.x = 0;
  camera.position.z = (centreRow - NEAR_ROW) * perRow;
  camera.updateProjectionMatrix();
  for (const h of room.hotspots.values()) {
    if (!h.rect) continue;
    const mesh = h.mesh;
    // (the unit box, moved so it reaches from its centre toward the top of the screen: its size is then the rows' depth)
    mesh.geometry = mesh.geometry.clone().translate(0, 0, -0.5);
    mesh.scale.z = Math.max(h.rect[3] - h.rect[1], 1) * perRow;
  }
  room.root.updateMatrixWorld(true);
}

export async function parseRoom(data: ArrayBuffer): Promise<RoomView> {
  const gltf = await new GLTFLoader().parseAsync(data, '');
  return readRoom(gltf.scene);
}

export async function loadRoom(url: string): Promise<RoomView> {
  const gltf = await new GLTFLoader().loadAsync(url);
  return readRoom(gltf.scene);
}

/** For a screen without a room model: a flat floor around its markers, seen from the front. */
export function fallbackRoom(screen: ScreenDef): RoomView {
  const points = Object.values(screen.markers);
  const xs = points.map(p => p.x);
  const zs = points.map(p => p.z);
  const [x0, x1] = [Math.min(0, ...xs) - FALLBACK_MARGIN, Math.max(0, ...xs) + FALLBACK_MARGIN];
  const [z0, z1] = [Math.min(0, ...zs) - FALLBACK_MARGIN, Math.max(0, ...zs) + FALLBACK_MARGIN];
  const root = new Object3D();
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z1], 3));
  // (both triangles face up)
  geometry.setIndex([0, 2, 1, 0, 3, 2]);
  const floor = new Mesh(geometry, new MeshStandardMaterial({ color: 0x8a949e, side: DoubleSide }));
  floor.userData = { region: 'floor', walkable: true };
  root.add(floor);
  const camera = new PerspectiveCamera((DEFAULT_YFOV * 180) / Math.PI, SCREEN_W / SCREEN_H, 0.1, 1000);
  camera.position.set((x0 + x1) / 2, 3, z1 + 8);
  frameCamera(camera, 100);
  root.add(camera);
  root.updateMatrixWorld(true);
  return {
    root,
    camera,
    markers: new Map(Object.entries(screen.markers).map(([k, v]) => [k, { ...v }])),
    regions: new Map([['floor', { name: 'floor', walkable: true, mesh: floor, triangles: trianglesOf(floor) }]]),
    hotspots: new Map(),
    modelled: false,
  };
}
