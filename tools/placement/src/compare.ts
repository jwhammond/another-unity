// SPDX-License-Identifier: GPL-3.0-or-later
import { Play } from '@another-unity/play';
import type { GameMaps } from '../../tracediff/src/maps';
import type { ScummObject } from './scummvm';

/** Positions this close (metres) are the same place: the projection rounds, and a sprite's own position is whole pixels. */
export const NEAR = 0.05;

export type FindingKind =
  /** ScummVM has the object active (or not) and ours says otherwise. */
  | 'active'
  /** The same object stands somewhere else. */
  | 'position'
  | 'state'
  /** ScummVM draws a sprite for it (active, a player, something shown) and the art has no stand-in: no mask or prop layer. */
  | 'no-art'
  /** The sprite plays an animation other than the one its prop card shows. */
  | 'anim'
  /** The sprite is off at entry, a script turns it on, and the art has no stand-in for it: it will not show when it does (the cut cable). */
  | 'later-no-art'
  /** ScummVM has the object on another screen. */
  | 'screen';

export interface Finding {
  room: string;
  object: string;
  kind: FindingKind;
  scummvm: string;
  ours: string;
}

export interface OursObject {
  screen: string | null;
  active: boolean;
  state: number;
  pos: { x: number; z: number };
}

/** The TypeScript world's objects as they stand when the away team has just arrived on a room (entrance 0). */
export async function oursAt(maps: GameMaps, room: string, seconds = 0): Promise<Record<string, OursObject>> {
  const content = { ...maps.content, start: { ...maps.content.start, screen: room, entrance: 'entrance_0' } };
  const play = Play.from(content, 42);
  try {
    await play.advance(seconds);
  } catch {
    // (a conversation's menu waits for a pick this run does not have, as it waits for the player in ScummVM: the room as it stands)
  }
  const out: Record<string, OursObject> = {};
  for (const [id, o] of Object.entries(play.state.objects)) out[id] = { screen: o.screen, active: o.active, state: o.state, pos: { x: o.pos.x, z: o.pos.z } };
  return out;
}

/** What the published art stands in for on a room: its mask and prop layers' objects (presentation.yaml art.rooms[room].masks). */
export type ArtCover = Map<string, Set<string>>;

export function compareRoom(
  room: string,
  scummvm: (ScummObject & { slug?: string })[],
  ours: Record<string, OursObject>,
  maps: GameMaps,
  art: Set<string> | null,
  spriteName: (id: number) => string,
  /** The card recipes that stand an object in as a prop: the recipe's id and the animation its card shows. */
  recipes: ReadonlyMap<string, { id: string; anim: number }> = new Map(),
  /** The objects some script turns on (`alter: { object, active: true }`). */
  turnedOn: ReadonlySet<string> = new Set(),
): Finding[] {
  const out: Finding[] = [];
  const add = (object: string, kind: FindingKind, s: string, o: string): void => void out.push({ room, object, kind, scummvm: s, ours: o });
  for (const s of scummvm) {
    const slug = s.slug;
    if (!slug) continue;
    const o = ours[slug];
    if (!o) continue;
    if (o.active !== s.active) add(slug, 'active', String(s.active), String(o.active));
    if (s.state !== o.state && !(s.state === 255 && o.state === 255)) add(slug, 'state', String(s.state), String(o.state));
    // (a position of 0,0 is an object with none: a mask, a trigger, a transition)
    if (s.active && (s.x > 0 || s.y > 0) && s.x >= 0 && s.y >= 0 && o.screen === room) {
      const want = maps.pos(room, s.x, s.y).split(',').map(Number);
      const d = Math.hypot((want[0] ?? 0) - o.pos.x, (want[1] ?? 0) - o.pos.z);
      if (Number.isFinite(d) && d > NEAR) add(slug, 'position', `${s.x},${s.y} px = ${want.join(',')} m`, `${o.pos.x.toFixed(3)},${o.pos.z.toFixed(3)} m (${d.toFixed(2)} m apart)`);
    }
    if (!s.active && s.sprite !== 0xffff && turnedOn.has(slug) && art !== null && !art.has(slug)) {
      const recipe = recipes.get(slug);
      add(slug, 'later-no-art', `${spriteName(s.sprite)}, off at entry, turned on by a script`, recipe ? `${recipe.id} is not published` : 'no mask or prop layer, no recipe');
    }
    const drawn = s.active && s.sprite !== 0xffff && s.player && !s.nothingShown;
    const recipe = recipes.get(slug);
    if (drawn && art !== null && !art.has(slug)) add(slug, 'no-art', `${spriteName(s.sprite)} anim ${s.playing}`, recipe ? `${recipe.id} is not published` : 'no mask or prop layer, no recipe');
    // (a card is a still of one animation: another one playing is another picture)
    if (drawn && s.playing > 0 && recipe && s.playing !== recipe.anim) add(slug, 'anim', `${spriteName(s.sprite)} anim ${s.playing}`, `${recipe.id} shows animation ${recipe.anim}`);
  }
  return out;
}

/** Every object some rule turns on, found by walking the lifted objects' trees for `alter` effects with `active: true`. */
export function turnedOnBy(trees: unknown[]): Set<string> {
  const out = new Set<string>();
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) n.forEach(walk);
    else if (n !== null && typeof n === 'object') {
      const o = n as Record<string, unknown>;
      const a = o.alter as { object?: unknown; active?: unknown } | undefined;
      if (a && typeof a === 'object' && typeof a.object === 'string' && a.active === true) out.add(a.object);
      Object.values(o).forEach(walk);
    }
  };
  trees.forEach(walk);
  return out;
}
