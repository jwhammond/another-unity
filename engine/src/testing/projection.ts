// SPDX-License-Identifier: GPL-3.0-or-later
import { BufferAttribute, BufferGeometry, Group, Mesh, Object3D, PerspectiveCamera, Vector3 } from 'three';
import { axisView, chaseView, lookAt } from '../sim/combat/camera';
import { fromAngles, v3, type M3, type V3 } from '../sim/combat/math';
import type { CameraPose, CombatShip } from '../sim/combat/types';
import { cameraMatrix, modelMatrix } from '../view/combat/axes';
import { setProjection } from '../view/combat/projection';

/**
 * The projection test's helpers (M8 spec §3.1): a model built as the space build writes it, where three puts its
 * vertices, and the sample poses. The unit test uses made-up vertices; tools/space's live test every model's.
 */

/** A model as the space build writes it: a root turned half a turn about z (tools/space ROOT_ROTATION) holding a mesh of the file's vertices. */
export function builtModel(vertices: readonly V3[], rootRotation: readonly [number, number, number, number] = [0, 0, 1, 0]): { root: Group; mesh: Mesh } {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(vertices.flatMap(v => [v.x, v.y, v.z])), 3));
  const mesh = new Mesh(geometry);
  const root = new Group();
  root.quaternion.set(...rootRotation);
  root.add(mesh);
  return { root, mesh };
}

/**
 * Where three puts a model's vertices in a window of the original's `width` x `height` pixels, with the camera at `cam`,
 * the model scaled by `scale` (SpaceModel::scale). A billboard model is placed as the scene places it: turned by the
 * camera's axes (`m` = cam.axes), so its vertices are steps in the camera's own axes.
 */
export function threeProject(model: { root: Group; mesh: Mesh }, vertices: readonly V3[], pos: V3, m: M3, cam: CameraPose, width: number, height: number, scale = 1): { x: number; y: number }[] {
  const holder = new Object3D();
  holder.matrixAutoUpdate = false;
  modelMatrix(pos, m, holder.matrix, scale);
  holder.add(model.root);
  holder.updateMatrixWorld(true);
  const camera = new PerspectiveCamera();
  camera.matrixAutoUpdate = false;
  cameraMatrix(cam.pos, cam.axes, camera.matrix);
  camera.matrixWorld.copy(camera.matrix);
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  setProjection(camera, width, height, 1, 1e6);
  return vertices.map(v => {
    const p = new Vector3(v.x, v.y, v.z).applyMatrix4(model.mesh.matrixWorld).project(camera);
    return { x: ((p.x + 1) / 2) * width, y: ((1 - p.y) / 2) * height };
  });
}

/** A ship of radius 300 at `pos` with these angles, for the camera's helpers. */
const shipAt = (pos: V3, angles: [number, number, number]) => ({ pos, angles, radius: 300, trail: [] } as unknown as CombatShip);
/** A battle position (x, y forward, z up) as internal (x, -z, y). */
const internal = (p: V3): V3 => v3(p.x, -p.z, p.y);

/** Made-up vertices: a lopsided box and a spike, so a mirror or a swapped axis shows. */
export const SAMPLE_VERTICES: V3[] = [
  v3(-120, -40, -300), v3(120, -40, -300), v3(120, 50, -300), v3(-120, 50, -300),
  v3(-80, -30, 250), v3(80, -30, 250), v3(80, 30, 250), v3(-80, 30, 250), v3(0, -150, 400), v3(210, 5, 0),
];

/** The sample poses: a ship turned every way, seen from the camera's views (chase, top, side), a camera off to one side looking at it, and one close up. */
export function samplePoses(): { pos: V3; m: M3; cam: CameraPose }[] {
  const out: { pos: V3; m: M3; cam: CameraPose }[] = [];
  const angles: [number, number, number][] = [[0, 0, 0], [0x1000, 0, 0], [0x2a3, 0x317, 0x1e0], [0x3500, 0x3c00, 0x2222], [0x1234, 0x0fff, 0x3001]];
  for (const a of angles) {
    const ship = shipAt(v3(1500, -2200, 400), a);
    const pos = internal(ship.pos);
    const m = fromAngles(a[0], a[1], a[2]);
    const chase: CameraPose = { pos: v3(), axes: [] };
    chaseView(chase, ship, 0x180, 900);
    const top: CameraPose = { pos: v3(), axes: [] };
    axisView(top, ship, 0, 1200, false);
    const side: CameraPose = { pos: v3(), axes: [] };
    axisView(side, ship, 0x3000, 700, true);
    const off: CameraPose = { pos: v3(-4000, -900, -2500), axes: [] };
    lookAt(off, v3(pos.x + 4000, pos.y + 900, pos.z + 2500));
    out.push({ pos, m, cam: chase }, { pos, m, cam: top }, { pos, m, cam: side }, { pos, m, cam: off });
  }
  return out;
}
