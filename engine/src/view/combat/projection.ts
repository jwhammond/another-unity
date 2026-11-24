// SPDX-License-Identifier: GPL-3.0-or-later
import { MathUtils, type PerspectiveCamera } from 'three';
import { add, angleToRadians, apply, fr, mul, sub, transpose, type M3, type V3 } from '../../sim/combat/math';
import type { CameraPose } from '../../sim/combat/types';

/** kFieldOfView (tactical.cpp:47): 0xaab of 16384 to a turn, 60 degrees across. */
export const FIELD_OF_VIEW = 0xaab;
/** The 3D window in the original's 640x480 screen (tactical.cpp:38-46): Split's beside the radar, and Full's band. */
export const SPLIT_RECT = { x: 319, y: 23, width: 320, height: 220 } as const;
export const FULL_RECT = { x: 0, y: 19, width: 640, height: 276 } as const;
/** kFlatDistance (combat.cpp:54): nothing is drawn this far away; the depth range ends here, and a ship's size past it. */
export const FLAT_DISTANCE = 256000;

/** SpaceRenderer::setViewport's focal length (space3d.cpp:261): (width >> 1) / tanf(angleToRadians(fov / 2)). */
export function focalLength(width: number): number {
  return fr((width >> 1) / fr(Math.tan(angleToRadians(FIELD_OF_VIEW >> 1))));
}

/**
 * Sets three's camera to the original's projection for a window `width` x `height` (in the original's pixels for
 * Split and Full; any unit for the modern Wide): 60 degrees across, the vertical angle following the window, and the
 * principal point where ScummVM's is, half a pixel right of and below the middle (project rounds with + 0.5,
 * space3d.cpp:278-279), so a point lands on the pixel ScummVM puts it on. `near` and `far` come from fitDepth.
 */
export function setProjection(camera: PerspectiveCamera, width: number, height: number, near: number, far: number): void {
  const focal = (width / 2) / Math.tan(angleToRadians(FIELD_OF_VIEW >> 1));
  camera.fov = MathUtils.radToDeg(2 * Math.atan(height / 2 / focal));
  camera.aspect = width / height;
  camera.near = near;
  camera.far = far;
  camera.setViewOffset(width, height, -0.5, -0.5, width, height);
  camera.updateProjectionMatrix();
}

/**
 * The depth range for what is drawn (M8 spec Decision 5): each drawn thing a sphere at view depth `z` (its centre's,
 * along the camera's forward) of radius `size`. Near is the nearest sphere's front, at least 1 (the original clips at
 * z = 1, space3d.cpp:370); far the furthest's back, at most FLAT_DISTANCE plus the largest size. With nothing drawn,
 * 1 to 2. The projection's x and y scale never depends on them.
 */
export function fitDepth(spheres: readonly { z: number; size: number }[]): { near: number; far: number } {
  if (spheres.length === 0) return { near: 1, far: 2 };
  let near = Infinity, far = 0, size = 0;
  for (const s of spheres) {
    near = Math.min(near, s.z - s.size);
    far = Math.max(far, s.z + s.size);
    size = Math.max(size, s.size);
  }
  near = Math.max(1, near);
  far = Math.min(FLAT_DISTANCE + size, far);
  return { near, far: Math.max(far, near + 1) };
}

/**
 * ScummVM's projection of a model's vertex (Combat::drawModel and SpaceRenderer::drawObject and project:
 * combat.cpp:1006-1013, space3d.cpp:254-263, 277-281, 283-304), in float32 as ScummVM computes it, before project's
 * truncation to a pixel: the vertex `v` of a model at internal `pos` turned by `m`, seen by `cam`, in a window
 * `width` x `height`. `z` is the view depth. A billboard part's vertex is not turned: it is a step from the model's
 * place in the camera's own axes (drawObject, space3d.cpp:299-300). For the projection test (M8 spec §3.1).
 */
export function scummProject(v: V3, pos: V3, m: M3, cam: CameraPose, width: number, height: number, billboard = false): { x: number; y: number; z: number } {
  const viewMatrix = transpose(cam.axes);
  const at = apply(viewMatrix, sub(pos, cam.pos));
  const p = add(billboard ? v : apply(mul(m, viewMatrix), v), at);
  const f = focalLength(width);
  return { x: fr(fr(fr(fr(p.x * f) / p.z) + 0.5) + (width >> 1)), y: fr(fr(fr(fr(p.y * f) / p.z) + 0.5) + (height >> 1)), z: p.z };
}
