// SPDX-License-Identifier: GPL-3.0-or-later
import type { PixelPolygon, ScreenDef, ScreenStartupDef } from '@another-unity/engine';
import type { LiftCtx } from './context';
import { adviceSetting, startupAction } from './effects';
import { regionName, screenSlug, worldSlug } from './ids';
import { MAX_BACK_DEPTH, MAX_RMS, type Projection } from './projection';
import type { ScreenFileT, WorldFileT } from './raw';

/** Adds a screen to the lift: its projection, regions, and the four slots of each entrance (readScreenLocation). */
export function registerScreen(ctx: LiftCtx, s: ScreenFileT, projection: Projection): string {
  const { id, world, screen, location, polygons } = s;
  const slug = ctx.ids.screen(world, screen, id);
  ctx.markers.addScreen(slug, projection);
  ctx.regions.set(slug, new Set(polygons.map(p => p.id)));
  const entrances = location?.entrypoints ?? [];
  ctx.entrances.set(id, entrances.length);
  // member i stands at slot i % 4 (placeAwayTeam, awayteam.cpp:367-370)
  entrances.forEach((slots, e) => slots.forEach((p, i) => {
    ctx.markers.named(slug, i === 0 ? `entrance_${e}` : `entrance_${e}.${i}`, p.x, p.y, `${id}#/location/entrypoints/${e}/${i}`);
  }));
  if (entrances.length === 0) {
    ctx.problems.warn(id, 'no entrances (a close-up, or not in slNNN.scr): entrance_0 is the bottom middle');
    ctx.markers.named(slug, 'entrance_0', 320, 399, id);
  }
  if (projection.params.kind === 'flat') ctx.problems.warn(id, `a flat projection (${projection.params.samples} scale samples)`);
  else if (projection.params.rms > MAX_RMS) ctx.problems.warn(id, `the projection fits the polygons' scales loosely (RMS ${projection.params.rms}); check it in the greybox, or set it in overrides/coords.yaml`);
  if (projection.params.capped) {
    ctx.problems.warn(id, `the fit's horizon was too close to the floor's back edge: moved up to a depth of ${MAX_BACK_DEPTH} (M3 Decision 7)`);
  }
  return slug;
}

/** w_WWstrt.bst's record for a screen, as startAwayTeam applies it (awayteam.cpp:317-336). */
export function liftStartup(ctx: LiftCtx, w: WorldFileT, screen: number, slug: string): ScreenStartupDef | undefined {
  const st = w.startups[screen];
  if (!st) return undefined;
  const { advice_id, advice_timer, closeup, combadge, input_blocked, screen: hasAction, target, who, other, action, x, y } = st;
  const where = `${w.id}#/startups/${screen}`;
  const out: ScreenStartupDef = {};
  if (advice_id !== 0xffff) out.advice = adviceSetting(ctx, () => w.world, advice_id, advice_timer, where);
  if (closeup === 1) out.closeup = true;
  if (combadge !== 0xff) out.combadge = combadge !== 0;
  if (input_blocked !== 0xff) out.inputBlocked = input_blocked !== 0;
  if (hasAction !== 0xffff) {
    const a = startupAction(ctx, { target, action, who, other, x, y }, slug, where);
    if (a) out.action = a;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Every polygon, in the original's pixels with its corners' scales (loadScreenPolys), unwelded: as walk.cpp walks them. */
function pixelFloor(polygons: ScreenFileT['polygons']): PixelPolygon[] {
  return polygons.map(p => ({ region: regionName(p.id), points: p.points.map((pt, i) => ({ x: pt.x, y: pt.y, scale: p.distances[i] })) }));
}

/** The screen's content; call it after everything that adds markers has run. */
export function screenDef(ctx: LiftCtx, s: ScreenFileT, startup: ScreenStartupDef | undefined): ScreenDef {
  const { world, screen, polygons } = s;
  const slug = screenSlug(world, screen);
  // walkable regions are type 1; PathBlocks switch them between 1 and 0 (setRegionType)
  const regions = Object.fromEntries(polygons.map(p => [regionName(p.id), p.type === 1]));
  const projection = ctx.markers.projection(slug);
  // (a close-up hides the team, so it needs no floor; any other screen without one strands them at its entrances)
  if (!polygons.some(p => p.type === 0 || p.type === 1) && !startup?.closeup) {
    ctx.problems.warn(s.id, "no floor, and not a close-up: the team stands at its entrances and can't walk (M3 Decision 8)");
  }
  return {
    id: slug,
    markers: ctx.markers.screenMarkers(slug),
    // (so the sim measures talk reach, near checks and step-ins in the original's pixels, and walks over the
    // original's polygons: every one, in its order, as findPath goes through them)
    ...(projection ? { pixelMetric: { ...projection.fit(), floor: pixelFloor(polygons) } } : {}),
    ...(Object.keys(regions).length > 0 ? { regions } : {}),
    world: worldSlug(world),
    ...(startup ? { startup } : {}),
  };
}
