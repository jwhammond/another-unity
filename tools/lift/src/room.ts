// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Vec2 } from '@another-unity/engine';
import type { LiftCtx } from './context';
import { triangulate, weldFloor } from './floor';
import { regionName, screenSlug, worldSlug } from './ids';
import type { HotspotInput } from './objects';
import { round3, type CameraParams, type Projection, type ProjectionParams } from './projection';
import type { ScreenFileT } from './raw';

export interface Hotspot {
  object: string;
  /** The object's ground point. */
  at: Vec2;
  width: number;
  height: number;
  depth: number;
  /** objectAt (unity.cpp:225-258): whether a click can pick it. */
  pickable: boolean;
  /** objwalktype 0-3. */
  kind: 'object' | 'walker' | 'transition' | 'action';
  /** The rectangle objectAt tests, in the original's pixels: [x0, y0, x1, y1] (unity.cpp:225-258; a sprite's from its first frame). */
  rect: [number, number, number, number];
  /** DrawOrderComparison's depth (unity.cpp:204-211): the row objectAt checks it by, front first. A walker goes by its y, anything else by y_adjust if it has one. */
  order: number;
}

export interface RoomRegion {
  name: string;
  walkable: boolean;
  /** The polygon's original type: 0 closed or 1 walkable (rooms leave out types 3 and 4). */
  type: number;
  /** Projected after near-miss gaps between regions are welded in pixels (floor.ts). */
  points: Vec2[];
  /** Ear-clipped in pixels, as indices into `points` (corners on a straight edge are left out). */
  triangles: [number, number, number][];
}

/** rooms/<world>/<sNN>.json: what tools/greybox builds a room from. */
export interface RoomFile {
  generated: 'tools/lift';
  screen: string;
  world: string;
  /** Plan 3's PNG of the background (relative to the images export), and the original's file. */
  background: { png: string; original: string } | null;
  projection: ProjectionParams;
  camera: CameraParams;
  regions: RoomRegion[];
  markers: Record<string, Vec2>;
  hotspots: Hotspot[];
}

/** A sprite file's first frame size, in pixels. */
export type SpriteBounds = (file: string) => { width: number; height: number; position?: { x: number; y: number } } | undefined;

/** Without any size, a hotspot is half a metre across. */
const DEFAULT_SIZE = 0.5;
/**
 * How deep a hotspot's box is, in metres: a thin panel standing on its object's ground point. The original's hotspot
 * is a flat rectangle on the screen, drawn and checked by the row its object stands on (objectAt and
 * DrawOrderComparison, unity.cpp:209-258); a box as deep as it is wide would reach toward the camera over whoever
 * stands just in front of the object.
 */
export const HOTSPOT_DEPTH = 0.05;
const KINDS = ['object', 'walker', 'transition', 'action'] as const;

export function roomFile(ctx: LiftCtx, s: ScreenFileT, hotspots: HotspotInput[], spriteNames: string[], sprites?: SpriteBounds): RoomFile {
  const { id, world, screen, location, polygons } = s;
  const slug = screenSlug(world, screen);
  const projection = ctx.markers.projection(slug);
  if (!projection) throw new Error(`roomFile: ${slug} isn't registered`);
  // (only floor: polygons of type 3 and 4, such as the full-screen one, aren't walked on: Decision 7)
  const floor = polygons.flatMap((p, i) => (p.type === 0 || p.type === 1 ? [{ poly: p, index: i }] : []));
  // (welded in pixels, where findPath's tolerance lives, so the mesh connects what the original walks across)
  const welded = weldFloor(floor.map(({ poly }) => ({ id: poly.id, points: poly.points.map(pt => ({ x: pt.x, y: pt.y })) })));
  const regions = floor.map(({ poly, index }, i): RoomRegion => {
    const { points } = welded[i];
    const { triangles, left } = triangulate(points);
    if (left > 0) {
      // (the original warns and keeps the triangles it has: data.cpp:190-194)
      ctx.problems.warn(`${id}#/polygons/${index}`, `can't triangulate region ${regionName(poly.id)} (it crosses itself): ear clipping stops with ${left} corners left`);
    }
    return {
      name: regionName(poly.id), walkable: poly.type === 1, type: poly.type,
      points: points.map(pt => projection.toWorld(pt.x, pt.y)), triangles,
    };
  });
  return {
    generated: 'tools/lift',
    screen: slug,
    world: worldSlug(world),
    background: location ? { png: `images/backgrounds/${id}.png`, original: location.background.replace(/\0/g, '') } : null,
    projection: projection.params,
    camera: projection.camera(),
    regions,
    markers: ctx.markers.screenMarkers(slug),
    hotspots: hotspots.filter(h => h.screen === slug).map(h => hotspot(h, projection, spriteNames, sprites)),
  };
}

function hotspot(h: HotspotInput, projection: Projection, spriteNames: string[], sprites?: SpriteBounds): Hotspot {
  const name = h.spriteId < spriteNames.length ? spriteNames[h.spriteId] : undefined;
  const bounds = name !== undefined && sprites ? sprites(`${name}.spr`) : undefined;
  const pw = Math.max(0, bounds?.width ?? (h.width !== -1 ? h.width : 0));
  const ph = Math.max(0, bounds?.height ?? (h.height !== -1 ? h.height : 0));
  // a position set by the sprite (POSN) replaces the object's on each axis where it isn't 0, for drawing and for picking
  // (graphics.cpp drawSprite 462-466 and spriteContains 412-413, the test objectAt calls for a sprite)
  const px = bounds?.position && bounds.position.x !== 0 ? bounds.position.x : h.x;
  const py = bounds?.position && bounds.position.y !== 0 ? bounds.position.y : h.y;
  const left = px - Math.trunc(pw / 2);
  // a scaled walker is drawn at the floor's scale, so its pixels are full-scale metres; scenery's are the floor's, at the row it stands on
  const m = h.objwalktype === 1 ? projection.params.metersPerPixel : projection.unitsPerPixel(py);
  const size = (px: number | undefined) => (px !== undefined && px > 0 ? round3(px * m) : DEFAULT_SIZE);
  const width = size(bounds?.width ?? (h.width !== -1 ? h.width : undefined));
  const height = size(bounds?.height ?? (h.height !== -1 ? h.height : undefined));
  return {
    object: h.object,
    // (the pick box stands where the rect is: the browser picks what the original draws and picks there)
    at: projection.toWorld(px, py),
    width,
    height,
    depth: HOTSPOT_DEPTH,
    // a sprite needs a verb flag to be clicked; without a sprite, a width (objectAt)
    pickable: name !== undefined ? (h.flags & 0x1f) !== 0 : h.width !== -1,
    kind: KINDS[h.objwalktype] ?? 'object',
    // objectAt: left = x - width/2 (integer), top = y - height, bottom = y (x and y the sprite's own position where it has one)
    rect: [left, py - ph, left + pw, py],
    // (the depth is the object's own y, not a sprite's POSN)
    order: h.yAdjust === -1 || h.objwalktype === 1 ? h.y : h.yAdjust,
  };
}

interface ImagesManifest {
  sprites: { file: string; json: string }[];
}

interface SpriteJson {
  entries: { type: string; width?: number; height?: number; x?: number; y?: number }[];
}

/** Each sprite's first frame with a size, from Plan 3's `export_images` output (images/manifest.json). */
export async function loadSpriteBounds(imagesDir: string): Promise<SpriteBounds> {
  const manifest = JSON.parse(await readFile(join(imagesDir, 'images/manifest.json'), 'utf8')) as ImagesManifest;
  const sizes = new Map<string, { width: number; height: number; position?: { x: number; y: number } }>();
  for (const s of manifest.sprites) {
    const sprite = JSON.parse(await readFile(join(imagesDir, s.json), 'utf8')) as SpriteJson;
    const frame = sprite.entries.find(e => (e.type === 'sprite' || e.type === 'speechSprite') && (e.width ?? 0) > 0 && (e.height ?? 0) > 0);
    // (the first position entry, as the art tool's masks read it)
    const posn = sprite.entries.find(e => e.type === 'position');
    if (frame?.width && frame.height) {
      sizes.set(basename(s.file).toLowerCase(), {
        width: frame.width, height: frame.height,
        ...(posn && ((posn.x ?? 0) !== 0 || (posn.y ?? 0) !== 0) ? { position: { x: posn.x ?? 0, y: posn.y ?? 0 } } : {}),
      });
    }
  }
  return file => sizes.get(file.toLowerCase());
}
