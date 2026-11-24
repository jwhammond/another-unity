// SPDX-License-Identifier: GPL-3.0-or-later
import { fitCamera, project, unprojectToPlane, type Camera, type Plane, type Vec3 } from './shipcam';
import type { ShipRecipe } from './recipe';

/** The part of games/unity/ship.yaml a layout needs (read at run time; never committed). */
export interface ShipYaml {
  bridge: {
    items: { object: string; x: number; y: number; width: number; height: number; action: number | string; depth?: number; description?: string }[];
    objects: { object: string; x: number; y: number; depth: number; file: string }[];
  };
}

/** R3's fixed table of ID-pass colours (sRGB, 0xRRGGBB), by item index. Distinct from the background grey and from black. */
const ID_COLOURS = [0xe6194b, 0x3cb44b, 0xffe119, 0x4363d8, 0xf58231, 0x911eb4, 0x46f0f0, 0xf032e6, 0xbcf60c, 0xfabebe, 0x008080, 0xe6beff, 0x9a6324, 0xfffac8];
export const ID_BACKGROUND = 0x282828;
export function idColour(index: number): number {
  const c = ID_COLOURS[index % ID_COLOURS.length]!;
  return c;
}

export type ItemRole = 'fixture' | 'crew' | 'ui';
export interface LayoutItem {
  index: number;
  action: string;
  object: string;
  /** The lifted rectangle, [x, y, width, height] in 640x480 pixels. */
  rect: [number, number, number, number];
  role: ItemRole;
  colour: number;
  /** The proxy's corners: bottom-left, bottom-right, top-right, top-left. Each is the rectangle's corner unprojected onto the support plane. */
  quad?: [Vec3, Vec3, Vec3, Vec3];
  box?: { min: Vec3; max: Vec3 };
}
export interface LayoutCrew {
  object: string;
  /** The crew item (talk button) that names this object, or -1 for one with no button. */
  index: number;
  /** Where the sprite's feet are in the set: the original's (x, y) unprojected onto the floor. The engine stands the card there. */
  foot: Vec3;
  /** The original's own depth, carried on the card's anchor. */
  depth: number;
  file: string;
  /** The original's own sprite origin, in 640x480 pixels. */
  objectXY: [number, number];
}
export interface ShipLayout {
  camera: Camera;
  fit: { rms: number; residuals: number[] };
  items: LayoutItem[];
  crew: LayoutCrew[];
  design: Record<string, unknown>;
}

const deg = (d: number): number => (d * Math.PI) / 180;
function planeOf(axis: 'x' | 'y' | 'z', at: number): Plane {
  return { normal: axis === 'x' ? [1, 0, 0] : axis === 'y' ? [0, 1, 0] : [0, 0, 1], d: at };
}

/**
 * R2: fits the camera to the recipe's trace, then unprojects each lifted item rectangle onto its support plane. The result is a
 * proxy quad that projects onto the rectangle (to rounding) by construction. `ship` is read from games/unity/ship.yaml at run time.
 * `spritePos` is each bridge sprite file's own first position (its POSN block), which the original draws at instead of the object's
 * x, y wherever it is non-zero (graphics.cpp drawSprite: "a position set by the sprite replaces the object's").
 */
export function bridgeLayout(recipe: ShipRecipe, ship: ShipYaml, spritePos: Record<string, [number, number]> = {}): ShipLayout {
  const s = recipe.start;
  const start: Camera = { position: s.position, yaw: deg(s.yaw), pitch: deg(s.pitch), roll: deg(s.roll), fovY: deg(s.fovY), shiftY: s.shiftY, width: 640, height: 480 };
  const fit = fitCamera(recipe.trace, start, recipe.free);
  if (fit.rms > recipe.maxRms) throw new Error(`${recipe.id}: the camera fit's rms is ${fit.rms.toFixed(2)} px, over the ${recipe.maxRms} px limit (worst point ${fit.residuals.indexOf(Math.max(...fit.residuals))})`);
  const camera = fit.camera;
  const items: LayoutItem[] = [];
  const crew: LayoutCrew[] = [];
  ship.bridge.items.forEach((it, index) => {
    const support = recipe.support[String(index)];
    if (!support) throw new Error(`${recipe.id}: item ${index} (${it.description ?? it.action}) has no support entry in the recipe`);
    const rect: [number, number, number, number] = [it.x, it.y, it.width, it.height];
    const role: ItemRole = 'ui' in support ? 'ui' : it.object.startsWith('ship.') ? 'crew' : 'fixture';
    const base = { index, action: String(it.action), object: it.object, rect, role, colour: idColour(index) };
    if ('ui' in support) {
      items.push(base);
      return;
    }
    const plane = planeOf(support.axis, support.at);
    const [x, y, w, h] = rect;
    const at = (u: number, v: number): Vec3 => {
      try {
        return unprojectToPlane(camera, [u, v], plane);
      } catch (e) {
        throw new Error(`${recipe.id}: item ${index} (${it.description ?? it.action}): ${(e as Error).message} (support ${support.axis}=${support.at})`);
      }
    };
    const quad: [Vec3, Vec3, Vec3, Vec3] = [at(x, y + h), at(x + w, y + h), at(x + w, y), at(x, y)];
    const min: Vec3 = [0, 1, 2].map(k => Math.min(...quad.map(p => p[k]!))) as Vec3;
    const max: Vec3 = [0, 1, 2].map(k => Math.max(...quad.map(p => p[k]!))) as Vec3;
    items.push({ ...base, quad, box: { min, max } });
    if (role === 'crew') {
      const name = it.object.replace(/^ship\./, '');
      if (!ship.bridge.objects.some(o => o.object === name)) throw new Error(`${recipe.id}: item ${index} names crew "${name}", which bridge.objects doesn't list`);
    }
  });
  // Task 6: each of the bridge's sprites stands where the original draws its feet (bridge.cpp start: obj->x, obj->y)
  for (const o of ship.bridge.objects) {
    const item = items.findIndex(i => i.role === 'crew' && i.object === `ship.${o.object}`);
    const own = spritePos[o.file];
    const at: [number, number] = [own && own[0] !== 0 ? own[0] : o.x, own && own[1] !== 0 ? own[1] : o.y];
    let foot: Vec3;
    try {
      foot = unprojectToPlane(camera, at, planeOf('y', 0));
    } catch (e) {
      throw new Error(`${recipe.id}: ${o.object}'s feet (${at[0]}, ${at[1]}) don't reach the floor: ${(e as Error).message}`);
    }
    crew.push({ object: o.object, index: item, foot, depth: o.depth, file: o.file, objectXY: at });
  }
  return { camera, fit: { rms: fit.rms, residuals: fit.residuals }, items, crew, design: recipe.design };
}

/** Where a layout's own camera puts a design point (for checks and reports). */
export const projectWith = project;
