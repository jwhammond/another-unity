// SPDX-License-Identifier: GPL-3.0-or-later
import type { Condition, Effect } from '@another-unity/engine';
import type { HookStubs } from './hooks';
import { parseId, screenKey, screenSlug, SHIP_WORLD, worldSlug, type IdTable } from './ids';
import { NO_SCREEN, pointName, type Markers } from './markers';
import type { Problems } from './problems';
import type { ConversationFileT, GameObjectT, RawIR } from './raw';
import type { VoiceIndex } from './voice';

export interface OwnerScreen {
  key: string;
  slug: string;
  world: number;
  number: number;
}

/** Whose lists are being lifted, and what their world-relative references resolve against. */
export interface Owner {
  /** The IR file: `o_070103`, `w007c000`, `w_07`. */
  file: string;
  /** The world its lists run in, when that is fixed (a world's own objects); null for crew, items and ship conversations. */
  world: number | null;
  /** The world a two-field talk string's conversation is in (the owner's own world, as say() is given it); null if any. */
  talkWorld: number | null;
  /** The screen its lists run on, when that is fixed. */
  screen: OwnerScreen | null;
  /** Its own row, for distances measured from it. */
  y?: number;
}

export interface WorldStats {
  groups: number;
  entries: Record<string, number>;
  effects: number;
  noops: number;
}

/** The world an IR pointer belongs to: o_WW…, wWWWc…, w_WW, s_WW…. */
export function pointerWorld(pointer: string): number | null {
  const m = /^(?:o_([0-9a-f]{2})|w([0-9a-f]{3})c|w_([0-9a-f]{2})|s_([0-9a-f]{2}))/.exec(pointer);
  if (!m) return null;
  return parseInt(m[1] ?? m[2] ?? m[3] ?? m[4], 16);
}

/** Counts for the coverage report, by world slug. */
export class Stats {
  private readonly byWorld = new Map<string, WorldStats>();

  for(pointer: string): WorldStats {
    const world = pointerWorld(pointer);
    const key = world === null ? 'other' : worldSlug(world);
    let s = this.byWorld.get(key);
    if (!s) {
      s = { groups: 0, entries: {}, effects: 0, noops: 0 };
      this.byWorld.set(key, s);
    }
    return s;
  }

  worlds(): string[] {
    return [...this.byWorld.keys()].sort();
  }
}

export interface LiftCtx {
  raw: RawIR;
  ids: IdTable;
  problems: Problems;
  markers: Markers;
  hooks: HookStubs;
  voices: VoiceIndex;
  stats: Stats;
  /** Crew slugs by crew number (object 0000nn). */
  crew: Map<number, string>;
  /** Each lifted screen's region (polygon) ids, by slug. */
  regions: Map<string, Set<number>>;
  /** Each screen's entrance count, by IR key. */
  entrances: Map<string, number>;
  /** overrides/contexts.yaml: a screen (IR key) for lists that can run anywhere. */
  contexts: Record<string, { screen: string }>;
  /** The objects lifted in full (Decision 6); every other lifted object is a stub. */
  full: ReadonlySet<string>;
  /** Lifting secondary content: its problems are warnings, and what caused them becomes a no-op (Decision 6). */
  lenient: boolean;
}

/** The content model's explicit "do nothing": the sim returns 0 for it, as the original's entry did. */
export const noop = (): Effect => ({ wait: { seconds: 0 } });

/** A condition that never passes (a "do until" counter that has run out), for a dropped condition. */
export const never = (): Condition => ({ counter: { mode: 'until', value: 0 } });

export function setLenient(ctx: LiftCtx, on: boolean): void {
  ctx.lenient = on;
  ctx.ids.lenient = on;
}

/** In secondary content, the errors since `before` become warnings; true means the caller drops what caused them. */
export function demote(ctx: LiftCtx, before: number): boolean {
  if (!ctx.lenient || ctx.problems.errors.length === before) return false;
  const moved = ctx.problems.errors.splice(before);
  ctx.problems.warnings.push(...moved.map(e => `${e} (in closure-only content, so it is dropped)`));
  return true;
}

export function ownerWorld(ctx: LiftCtx, owner: Owner, where: string): number {
  if (owner.world !== null) return owner.world;
  ctx.problems.error(where, `refers to the current world, but ${owner.file}'s lists can run in any world (give it a screen in overrides/contexts.yaml)`);
  return 0;
}

export function ownerScreen(ctx: LiftCtx, owner: Owner, where: string): OwnerScreen {
  if (owner.screen) return owner.screen;
  ctx.problems.error(where, `refers to the current screen, but ${owner.file}'s lists can run on any screen (give it a screen in overrides/contexts.yaml)`);
  return { key: 's_0000', slug: NO_SCREEN, world: 0, number: 0 };
}

/** Every lifted, located screen of the owner's world: where a list with no screen of its own can run (M3 Decision 2). */
export function currentScreens(ctx: LiftCtx, owner: Owner, where: string): OwnerScreen[] {
  const world = ownerWorld(ctx, owner, where);
  const out: OwnerScreen[] = [];
  for (const [key, s] of ctx.raw.screens) {
    if (s.world !== world || !s.location) continue;
    const screen = screenOf(ctx, key);
    if (screen) out.push(screen);
  }
  return out.sort((a, b) => a.number - b.number);
}

/**
 * A position on "the current screen". A list with a screen of its own puts it there. One with none (a world's
 * conversation) puts it, under the same name, on every screen it can run on: the sim looks a marker up on the screen
 * the team is on when the effect runs, so it finds it wherever the list runs.
 */
export function hereMarker(ctx: LiftCtx, owner: Owner, x: number, y: number, where: string): string {
  // (crew and items, which run in any world on any screen, still need a screen of their own)
  if (owner.screen || (owner.world === null && owner.file.startsWith('o_'))) return ctx.markers.point(ownerScreen(ctx, owner, where).slug, x, y, where);
  const screens = currentScreens(ctx, owner, where);
  if (screens.length === 0 && owner.world !== null) {
    ctx.problems.warn(where, `no screen of ${worldSlug(owner.world)} is lifted, so position (${x}, ${y}) is on none`);
  }
  for (const s of screens) ctx.markers.point(s.slug, x, y, where, true);
  return pointName(x, y);
}

/** A lifted screen, by IR key; null if it isn't lifted. */
export function screenOf(ctx: LiftCtx, key: string): OwnerScreen | null {
  const s = ctx.raw.screens.get(key);
  if (!s) return null;
  const slug = screenSlug(s.world, s.screen);
  return ctx.markers.has(slug) ? { key, slug, world: s.world, number: s.screen } : null;
}

/**
 * Where an object starts: none for world 0's objects (crew, items) or anything in the inventory, and none on a screen
 * that slNNN.scr doesn't place (such as s_0705's advisors, which, like crew, are only ever talked to: Decision 11).
 */
export function objectScreen(ctx: LiftCtx, o: GameObjectT): OwnerScreen | null {
  const { world } = parseId(o.id);
  if (world === 0 || (o.flags & 0x40) !== 0) return null;
  const screen = screenOf(ctx, screenKey(world, o.curr_screen));
  return screen && ctx.raw.screens.get(screen.key)?.location ? screen : null;
}

function fixedScreen(ctx: LiftCtx, file: string): OwnerScreen | null | undefined {
  const fixed = ctx.contexts[file];
  if (!fixed) return undefined;
  const screen = screenOf(ctx, fixed.screen);
  if (!screen) ctx.problems.error(`overrides/contexts.yaml: ${file}`, `no lifted screen ${fixed.screen}`);
  return screen;
}

export function objectOwner(ctx: LiftCtx, o: GameObjectT): Owner {
  const { world } = parseId(o.id);
  const file = `o_${o.id}`;
  const fixed = fixedScreen(ctx, file);
  const screen = fixed === undefined ? objectScreen(ctx, o) : fixed;
  return {
    file,
    world: fixed ? fixed.world : world === 0 ? null : world,
    talkWorld: world,
    screen,
    ...(o.y !== -1 ? { y: o.y } : {}),
  };
}

export function conversationOwner(ctx: LiftCtx, c: ConversationFileT): Owner {
  const fixed = fixedScreen(ctx, c.id) ?? null;
  // (results run on the talk target; a ship conversation's can be in any world)
  const anywhere = c.our_world === SHIP_WORLD;
  return {
    file: c.id,
    world: fixed ? fixed.world : anywhere ? null : c.our_world,
    talkWorld: fixed ? fixed.world : anywhere ? null : c.our_world,
    screen: fixed,
  };
}
