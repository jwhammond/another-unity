// SPDX-License-Identifier: GPL-3.0-or-later
import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Plane,
  Vector3,
  type Camera,
} from 'three';
import type { RoomMask } from './art';
import { SCREEN_H, SCREEN_W } from './room';

const GROUND = new Plane(new Vector3(0, 1, 0), 0);

/** The unit ray through a pixel of the original's 640x480 screen: the room camera draws the plate over exactly that. */
function pixelRay(camera: PerspectiveCamera, x: number, y: number): { origin: Vector3; dir: Vector3 } {
  camera.updateMatrixWorld(true);
  const origin = camera.getWorldPosition(new Vector3());
  const dir = new Vector3((x / SCREEN_W) * 2 - 1, 1 - (y / SCREEN_H) * 2, 0.5).unproject(camera).sub(origin).normalize();
  return { origin, dir };
}

/** The floor point drawn at pixel (x, y), or null at or above the horizon. */
export function floorPointAt(camera: PerspectiveCamera, x: number, y: number): Vector3 | null {
  const { origin, dir } = pixelRay(camera, x, y);
  const t = -(origin.dot(GROUND.normal) + GROUND.constant) / dir.dot(GROUND.normal);
  return Number.isFinite(t) && t > 0 ? origin.clone().addScaledVector(dir, t) : null;
}

/** The floor point at the picture's bottom row below column x: where a card with no floor under it stands (it is drawn by its corners, and this only gives them a distance). */
function wallPointAt(camera: PerspectiveCamera, x: number): Vector3 | null {
  return floorPointAt(camera, x, SCREEN_H - 1);
}

/** The ground point under pixel (x, y) of a top-down orthographic camera (a flat screen's), whose frustum is the 640x480 picture. */
function orthoPointAt(camera: OrthographicCamera, x: number, y: number): Vector3 {
  camera.updateMatrixWorld(true);
  const near = new Vector3((x / SCREEN_W) * 2 - 1, 1 - (y / SCREEN_H) * 2, -1).unproject(camera);
  const forward = camera.getWorldDirection(new Vector3());
  // (along the view direction to the ground)
  return near.addScaledVector(forward, -near.y / forward.y);
}

/** The point drawn at pixel (x, y) of the picture on a plane `distance` in front of the camera; on a flat screen's top-down camera, the floor point under it. */
export function pixelPoint(camera: Camera, x: number, y: number, distance = 1): Vector3 | null {
  if (camera instanceof OrthographicCamera) return orthoPointAt(camera, x, y);
  if (camera instanceof PerspectiveCamera) return cornersAt(camera, [x, y, x, y], distance)[0]!;
  return null;
}

/** A rectangle of the original's pixels [x0, y0, x1, y1] as four world corners (top-left, top-right, bottom-right, bottom-left) on the plane `distance` along the camera's view direction. */
export function cornersAt(camera: PerspectiveCamera, rect: readonly [number, number, number, number], distance: number): Vector3[] {
  const forward = camera.getWorldDirection(new Vector3());
  const [x0, y0, x1, y1] = rect;
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => {
    const { origin, dir } = pixelRay(camera, x!, y!);
    return origin.addScaledVector(dir, distance / dir.dot(forward));
  });
}

/**
 * A mask drawn as a camera-facing quad that covers its original rectangle exactly and stands at the floor point under
 * the mask's depth row (R9). The quad's origin is that floor point, so it sorts among the cards as an object standing
 * there: the original draws objects in order of the row each stands on (DrawOrderComparison, unity.cpp:209-220), and
 * a mask is one of them. Cards and masks are all transparent camera-facing quads, drawn in renderOrder: a mask's is its
 * depth row and a card's its foot row (ActorView.setFootRow), so the order doesn't hang on the camera having no roll.
 * The mask never writes depth and never tests it, is not picked, and is left out when it has no floor (a card, which is a
 * repainted sprite and not a cut of the plate, stands under its own foot instead).
 */
export function maskQuad(camera: Camera, mask: RoomMask): Mesh | null {
  const parts = quadParts(camera, mask.rect, mask.depth, mask.card === true);
  if (!parts) return null;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(parts.local, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2));
  geometry.setIndex([0, 3, 2, 0, 2, 1]);
  const material = new MeshBasicMaterial({ map: mask.texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, side: DoubleSide });
  const quad = new Mesh(geometry, material);
  quad.position.copy(parts.stand);
  quad.renderOrder = mask.depth;
  quad.name = `mask:${mask.object}`;
  quad.userData.mask = mask.object;
  // (the whole rectangle's corners, for `fitQuad`: an atlas cell is drawn on a part of it)
  quad.userData.corners = parts.local;
  // (where it was made, for `moveQuad`)
  quad.userData.made = { rect: [...mask.rect], depth: mask.depth, card: mask.card === true };
  quad.raycast = () => {};
  quad.updateMatrixWorld(true);
  return quad;
}

/** Where a quad over `rect` stands and its corners about that point, or null where it has no floor (see maskQuad). */
function quadParts(camera: Camera, rect: readonly [number, number, number, number], depth: number, card: boolean): { stand: Vector3; local: number[] } | null {
  const [x, y, w, h] = rect;
  let stand: Vector3 | null;
  let corners: Vector3[];
  if (camera instanceof OrthographicCamera) {
    // (a flat close-up: the top-down camera lies over the 640x480 picture, so a rectangle of it is the same rectangle on the floor; the row a layer is sorted by only sets its place among the cards, and one drawn behind everything (-1) stands on the picture's top row)
    stand = orthoPointAt(camera, x + w / 2, Math.max(depth, 0));
    corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(([cx, cy]) => orthoPointAt(camera, cx!, cy!));
  } else if (camera instanceof PerspectiveCamera) {
    // (a layer sorted above the horizon has no floor point: a cut of the plate then looks like the plate, so it is left out; a card is not the plate, and stands on the floor under its foot, keeping its sorting row; a card whose foot is above the horizon too is a decal on the far wall, which the original draws at its rectangle all the same: it stands on the plane of the nearest floor, where only its sorting row and its corners matter)
    stand = floorPointAt(camera, x + w / 2, depth) ?? (card ? floorPointAt(camera, x + w / 2, y + h) ?? wallPointAt(camera, x + w / 2) : null);
    if (!stand) return null;
    const distance = stand.clone().sub(camera.getWorldPosition(new Vector3())).dot(camera.getWorldDirection(new Vector3()));
    corners = cornersAt(camera, [x, y, x + w, y + h], distance);
  } else return null;
  return { stand, local: corners.flatMap(c => [c.x - stand.x, c.y - stand.y, c.z - stand.z]) };
}

/**
 * Moves a quad `dx`, `dy` of the original's pixels from where maskQuad made it: a prop whose object the rules have moved is drawn where the original
 * draws its sprite now (a cable beamed in, an object put elsewhere), not where the sprite started. Returns false, leaving the quad as it is, where the
 * new place has no floor for it. (0, 0) puts it back.
 */
export function moveQuad(camera: Camera, quad: Mesh, dx: number, dy: number): boolean {
  const made = quad.userData.made as { rect: [number, number, number, number]; depth: number; card: boolean } | undefined;
  if (!made) return false;
  const rect: [number, number, number, number] = [made.rect[0] + dx, made.rect[1] + dy, made.rect[2], made.rect[3]];
  const parts = quadParts(camera, rect, made.depth + dy, made.card);
  if (!parts) return false;
  quad.position.copy(parts.stand);
  quad.renderOrder = made.depth + dy;
  quad.userData.corners = parts.local;
  const pos = quad.geometry.getAttribute('position');
  for (let i = 0; i < 4; i++) pos.setXYZ(i, parts.local[i * 3]!, parts.local[i * 3 + 1]!, parts.local[i * 3 + 2]!);
  pos.needsUpdate = true;
  quad.geometry.computeBoundingSphere();
  quad.updateMatrixWorld(true);
  return true;
}

/**
 * Draws the quad over only a part of the rectangle it was made for: `sub` is [left, top, right, bottom] as fractions of it. The corners lie on a plane facing the
 * camera, where a pixel of the picture maps affinely, so the part's corners are the same fractions along the rectangle's. (Its bounding sphere stays the whole's, which holds the part.)
 */
export function fitQuad(quad: Mesh, sub: readonly [number, number, number, number]): void {
  const c = quad.userData.corners as number[] | undefined;
  if (!c) return;
  const at = (fx: number, fy: number, k: number): number => c[k]! + (c[3 + k]! - c[k]!) * fx + (c[9 + k]! - c[k]!) * fy;
  const [l, t, r, b] = sub;
  const pos = quad.geometry.getAttribute('position');
  [[l, t], [r, t], [r, b], [l, b]].forEach(([fx, fy], i) => pos.setXYZ(i, at(fx!, fy!, 0), at(fx!, fy!, 1), at(fx!, fy!, 2)));
  pos.needsUpdate = true;
}

/** What can hide a card: a mask's rect ([x, y, w, h]), the row it is sorted by, and its alpha over the rect where known. */
export interface Occluder {
  rect: readonly [number, number, number, number];
  depth: number;
  alpha: Uint8Array | null;
}

const COVERED = 128;
const GRID = { across: 4, down: 8 };

/**
 * Whether a card's rect ([x0, y0, x1, y1], in the original's pixels) is hidden entirely by masks: every sample of a
 * grid over its middle lies on an opaque pixel of a mask that is drawn after the card, that is one whose depth is
 * below the card's foot row (DrawOrderComparison draws in ascending depth). A mask with no alpha to read hides nothing.
 */
export function fullyOccluded(card: readonly [number, number, number, number], footRow: number, masks: readonly Occluder[]): boolean {
  const [x0, y0, x1, y1] = card;
  if (!(x1 > x0 && y1 > y0)) return false;
  const front = masks.filter(m => m.alpha !== null && m.depth > footRow);
  if (front.length === 0) return false;
  for (let j = 0; j < GRID.down; j++) {
    for (let i = 0; i < GRID.across; i++) {
      // (the middle of the rect: its corners are where a standing figure isn't)
      const x = x0 + (x1 - x0) * (0.25 + (0.5 * (i + 0.5)) / GRID.across);
      const y = y0 + (y1 - y0) * (0.05 + (0.9 * (j + 0.5)) / GRID.down);
      const hidden = front.some(m => {
        const px = Math.floor(x - m.rect[0]);
        const py = Math.floor(y - m.rect[1]);
        const w = Math.round(m.rect[2]);
        const h = Math.round(m.rect[3]);
        return px >= 0 && py >= 0 && px < w && py < h && m.alpha![py * w + px]! >= COVERED;
      });
      if (!hidden) return false;
    }
  }
  return true;
}

/** The hotspots' original rectangles as outlines drawn over everything, each on a plane just beyond the camera's near one; pickable ones in yellow, the rest cyan. Rectangles with no extent are left out. */
export function rectOutlines(camera: Camera, hotspots: { rect?: readonly [number, number, number, number]; pickable: boolean }[]): LineSegments | null {
  if (!(camera instanceof PerspectiveCamera)) return null;
  const positions: number[] = [];
  const colors: number[] = [];
  for (const h of hotspots) {
    if (!h.rect || h.rect[2] <= h.rect[0] || h.rect[3] <= h.rect[1]) continue;
    const c = cornersAt(camera, h.rect, 1);
    const rgb = h.pickable ? [1, 0.9, 0.2] : [0.2, 0.9, 1];
    for (let i = 0; i < 4; i++) {
      const a = c[i]!;
      const b = c[(i + 1) % 4]!;
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
      colors.push(...rgb, ...rgb);
    }
  }
  if (positions.length === 0) return null;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  const lines = new LineSegments(geometry, new LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, toneMapped: false }));
  lines.name = 'hotspot-rects';
  lines.renderOrder = 999;
  lines.raycast = () => {};
  lines.frustumCulled = false;
  return lines;
}
