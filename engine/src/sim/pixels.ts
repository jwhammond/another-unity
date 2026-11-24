// SPDX-License-Identifier: GPL-3.0-or-later
import { Projection } from '../content/projection';
import type { PixelMetric, Vec2 } from '../content/types';
import { WalkFloor, walkEnd } from './walkFloor';
import type { World } from './world';

/**
 * On a screen with a pixel metric, the sim measures as the original does: in its whole pixels, where a row can be
 * several columns' width deep. Without one, it measures in metres.
 */
export interface Pixel { x: number; y: number }

const projections = new WeakMap<PixelMetric, Projection>();

/** The current screen's projection, if it has a pixel metric. */
export function screenPixels(world: World): Projection | undefined {
  return projectionOf(world, world.state.screen);
}

/** A screen's projection, if it has a pixel metric. */
export function projectionOf(world: World, screen: string): Projection | undefined {
  const metric = world.content.screens[screen]?.pixelMetric;
  if (!metric) return undefined;
  let p = projections.get(metric);
  if (!p) {
    p = new Projection(metric);
    projections.set(metric, p);
  }
  return p;
}

/** The whole pixel a position is at (the original keeps positions in whole pixels). */
export function pixelAt(p: Projection, pos: Vec2): Pixel {
  const px = p.toPixel(pos);
  return { x: Math.round(px.x), y: Math.round(px.y) };
}

/** A distance in metres back in whole pixels, at the row it was lifted at (Markers.distance's inverse). */
export function pixelsOf(p: Projection, units: number, y: number): number {
  return Math.round(units / p.unitsPerPixel(y));
}

/** A rules distance (metres at full scale) in pixels. */
export function fullScalePixels(p: Projection, units: number): number {
  return Math.round(units / p.params.metersPerPixel);
}

/** Whether a and b are further apart than dist pixels (as the original compares squares of ints). */
export function furtherThan(a: Pixel, b: Pixel, dist: number): boolean {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy > dist * dist;
}

/**
 * How near a walker arrives to an action square (objwalktype 3) to run it, in the original's pixels. Inferred from
 * the data (every square sits 0-20 px from the destination that its walker is sent to), not confirmed against the
 * original's own hit test; ScummVM's fix (unity.cpp runActionSquares) uses the same radius.
 */
export const ACTION_SQUARE_RADIUS = 20;

/**
 * The action squares a walker's arrival runs, in the original's order: of the squares within ACTION_SQUARE_RADIUS
 * pixels, only those at the shortest distance (a deactivated square counts as the nearest, and runs nothing).
 * ScummVM's runActionSquares: Frigis's floor tiles are armed traps 14.6 px from the safe tile a walker is sent to.
 */
export function actionSquaresNear(world: World, walker: string): string[] {
  const p = screenPixels(world);
  if (!p) return [];
  const at = pixelAt(p, world.obj(walker).pos);
  const out: { id: string; order: number; d2: number; active: boolean }[] = [];
  for (const [id, def] of Object.entries(world.content.objects)) {
    if (def.actionSquare === undefined || id === walker) continue;
    const o = world.state.objects[id];
    if (!o || o.screen !== world.state.screen) continue;
    const sq = pixelAt(p, o.pos);
    if (furtherThan(sq, at, ACTION_SQUARE_RADIUS)) continue;
    out.push({ id, order: def.actionSquare, d2: (sq.x - at.x) ** 2 + (sq.y - at.y) ** 2, active: o.active });
  }
  const nearest = Math.min(...out.map(s => s.d2));
  // (the screen's object list order, which is the original ids' order)
  return out.filter(s => s.d2 === nearest && s.active).sort((a, b) => a.order - b.order).map(s => s.id);
}

const floors = new WeakMap<PixelMetric, Map<string, WalkFloor>>();

/** The current screen's walkable floor (its open regions' polygons), if it has a pixel metric. */
export function screenFloor(world: World): WalkFloor | undefined {
  const metric = world.content.screens[world.state.screen]?.pixelMetric;
  if (!metric) return undefined;
  const open = world.state.regions[world.state.screen] ?? {};
  const walkable = metric.floor.filter(poly => open[poly.region] === true);
  // (one floor for each set of open regions: PathBlocks open and close them)
  const key = walkable.map(poly => poly.region).join(' ');
  let byOpen = floors.get(metric);
  if (!byOpen) {
    byOpen = new Map();
    floors.set(metric, byOpen);
  }
  let floor = byOpen.get(key);
  if (!floor) {
    floor = new WalkFloor(walkable.map(poly => poly.points));
    byOpen.set(key, floor);
  }
  return floor;
}

/** Where a walk on a screen with a pixel metric ends, and whether the action after it runs. */
export interface PixelWalk {
  end: Vec2;
  acts: boolean;
}

/**
 * Where a walk from `from` towards `to` ends on a screen with a pixel metric, through the original's path finder
 * (walkTo, walkToThenAct: unity.cpp:900-927); undefined without one, and null where there is no floor to walk on
 * (findPath fails, so the original doesn't walk). With a stop distance (in metres, converted back at `to`'s row as
 * the lifter converted it, unless `stopPx` gives the distance in pixels, which overrides the metres), the walk stops at the
 * first whole pixel within it of `to`. The action after the walk
 * runs only if the walk gets to the nearest walkable point to `to` or, with a stop distance, within it of `to` (an
 * unreachable one is only walked towards).
 */
export function pixelWalk(world: World, from: Vec2, to: Vec2, stopWithin = 0, stopPx?: number): PixelWalk | null | undefined {
  const p = screenPixels(world);
  const floor = screenFloor(world);
  if (!p || !floor) return undefined;
  const a = pixelAt(p, from);
  const b = pixelAt(p, to);
  const path = floor.findPath(a, b);
  if (!path) return null;
  const last = path[path.length - 1];
  const goal = floor.nearestWalkable(b);
  const dist = stopWithin > 0 ? (stopPx ?? pixelsOf(p, stopWithin, b.y)) : 0;
  // (a walk that ends short of an unreachable point still acts if it got within the stop distance of it: walkToThenAct)
  const acts = (last.x === goal.x && last.y === goal.y) || (dist > 0 && !furtherThan(last, b, dist));
  const stop = acts && dist > 0 ? { point: b, dist } : undefined;
  const end = walkEnd(a, path, stop);
  return { end: p.toWorld(end.x, end.y), acts };
}
