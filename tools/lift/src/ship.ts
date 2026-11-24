// SPDX-License-Identifier: GPL-3.0-or-later
import type { AstroNames, ShipData } from '@another-unity/engine';
import type { LiftCtx } from './context';
import { HARDCODED } from './hardcoded';
import { ENTERPRISE_ID, hex2, SHIP_WORLD, SPACE_WORLD, triggerSlug } from './ids';
import type { GameObjectT } from './raw';

/**
 * The bridge, the transporter's recommended teams and the ship's stats (Plan 10 Task 9), from sttng.ovl's tables.
 * Object ids become slugs through `ctx.ids.object`, so the crew and items they name close over like any other reference.
 * Row `n` of `_awayTeamScreenData` is world n + 1's (the C++ reads `_awayTeamScreenData[world - 1]`, transporter.cpp:431,576); Decision 5's world 8 -> 5 alias is the transporter's (Plan 12), so it isn't applied here.
 */
export function liftShip(raw: LiftCtx['raw'], ctx: LiftCtx): ShipData {
  const e = raw.executable;
  const known = (id: string, where: string) => {
    if (raw.objects.has(id)) return true;
    ctx.problems.warn(where, `object ${id} isn't in the export: dropped`);
    return false;
  };
  const leaderOrder: string[] = [];
  e._leaderOrder.forEach((n, i) => {
    const slug = ctx.crew.get(n);
    if (slug === undefined) ctx.problems.warn(`executable._leaderOrder[${i}]`, `no crew member ${n} in the export: dropped`);
    else leaderOrder.push(slug);
  });
  const astro: AstroNames = {
    enterprise: ctx.ids.object(ENTERPRISE_ID, 'hardcoded.ts astro'),
    starbaseBattle: HARDCODED.astro.starbaseBattle,
    defaultBattle: HARDCODED.astro.defaultBattle,
    triggers: Object.fromEntries(Object.entries(HARDCODED.astro.triggers).map(([name, id]) => {
      // (a trigger the export lacks is a warning here, so a partial export still lifts; the engine won't find it)
      if (!raw.triggers.some(t => t.id === id)) {
        ctx.problems.warn('hardcoded.ts astro', `no trigger ${id} (${name}) in triggers.json`);
        return [name, triggerSlug(id)];
      }
      return [name, ctx.ids.trigger(id, 'hardcoded.ts astro')];
    })) as AstroNames['triggers'],
  };
  // shipEquipment: kItemMedicalTricorder to kItemMedkit in id order, without the communicator (awayteam.cpp:89-100)
  const equipment = Object.values(HARDCODED.items).filter(id => id !== HARDCODED.items.communicator)
    .filter(id => known(id, 'hardcoded.ts equipment')).map(id => ctx.ids.object(id, 'hardcoded.ts equipment'));
  return {
    bridge: {
      items: e._bridgeItems.map((i, n) => ({
        object: ctx.ids.object(i.id, `executable._bridgeItems[${n}]`), x: i.x, y: i.y, width: i.width, height: i.height,
        action: i.action,
        // the export writes the u32 of a signed depth (-100 is 4294967196); `_bridgeObjects.depth` is signed too, and bridge.cpp uses -depth as y_adjust
        depth: i.depth | 0, description: i.description,
      })),
      objects: e._bridgeObjects.map((o, n) => ({
        object: ctx.ids.object(o.id, `executable._bridgeObjects[${n}]`), x: o.x, y: o.y, depth: o.depth, file: o.filename,
      })),
      turbolift: e._bridgeScreenEntries.map(s => ({ code: s.code, text: s.text })),
    },
    transporter: {
      exits: e._transporterExits.map(s => ({ code: s.code, text: s.text })),
      teams: e._awayTeamScreenData.map((t, n) => ({
        world: n + 1,
        members: t.defaultMembers.filter(id => known(id, `executable._awayTeamScreenData[${n}]`)).map(id => ctx.ids.object(id, `executable._awayTeamScreenData[${n}]`)),
        items: t.inventoryItems.filter(id => known(id, `executable._awayTeamScreenData[${n}]`)).map(id => ctx.ids.object(id, `executable._awayTeamScreenData[${n}]`)),
      })),
      targets: e._transporterTargets.map(t => ({ x: t.x, y: t.y })),
      // where the room draws a padded crew member (transporter.cpp): view only, no sim code reads it
      pads: e._transporterPads.map(p => ({
        rect: [p.rect.left, p.rect.top, p.rect.right, p.rect.bottom] as [number, number, number, number],
        stand: [p.stand.x, p.stand.y] as [number, number], scale: p.scale,
      })),
      // the crew's walk in from the door and out again (transporter.cpp walk): view only; the middle of the walk in is filled from the pad, as `walk` does
      walkOn: e._transporterWalkOn.map(w => ({ x: w.x, y: w.y, direction: w.direction, scale: w.scale })),
      walkOff: e._transporterWalkOff.map(w => ({ x: w.x, y: w.y, direction: w.direction, scale: w.scale })),
    },
    crew: {
      leaderOrder, voices: e._crewVoices.map(v => v),
      voiceOf: Object.fromEntries([...ctx.crew].filter(([n]) => n < e._crewVoices.length).map(([n, slug]) => [slug, e._crewVoices[n]!])),
    },
    speeds: { warp: e._warpSpeeds.map(s => s), impulse: e._impulseSpeeds.map(s => s) },
    units: e._shipUnits.map(u => ({
      name: u.name, type: u.type, current: u.current, target: u.target, max: u.max, chargeTicks: u.chargeTicks,
      dischargeTicks: u.dischargeTicks, damage: u.damage, repair: u.repair, baseDamage: u.baseDamage, maxDamage: u.maxDamage,
      efficiency: u.efficiency, hitWeight: u.hitWeight, depth: u.depth,
    })),
    astro,
    equipment,
    contacts: liftContacts(raw, ctx),
  };
}

/**
 * The Enterprise's own views (unity.cpp:604-610): viewscreenImage shows the Enterprise's anim_index as a sprite id, and an alter that plays
 * an animation on the Enterprise sets it (object.cpp:1392-1423). Every number such an alter plays in the lifted `defs` (objects,
 * conversations, triggers and screens: an alter is found wherever it is), with its sprite's file from sprite.lst, lower case without the
 * extension. A new sprite (31000 + n) or a stop sets no view. A number sprite.lst has no name for is a warning, and left out.
 */
export function viewscreenSprites(defs: Iterable<unknown>, enterprise: string, filenames: readonly string[], problems: LiftCtx['problems']): Record<number, string> {
  const played = new Set<number>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (typeof v !== 'object' || v === null) return;
    const alter = (v as { alter?: { object?: unknown; anim?: { play?: unknown } } }).alter;
    if (alter?.object === enterprise && typeof alter.anim?.play === 'number') played.add(alter.anim.play);
    for (const x of Object.values(v)) walk(x);
  };
  for (const d of defs) walk(d);
  const out: Record<number, string> = {};
  for (const n of [...played].sort((a, b) => a - b)) {
    const file = filenames[n]?.toLowerCase();
    if (file && /^[a-z0-9_]+$/.test(file)) out[n] = file;
    else problems.warn('maps/sprite.json', `the Enterprise plays sprite ${n}, which sprite.lst doesn't name: no view for it`);
  }
  return out;
}

/** An object's name as Combat::setup compares it: the first ten letters (combat.cpp:200). */
export const tenLetters = (name: string) => name.slice(0, 10).toLowerCase();

/** One space-world screen as Combat::setup reads it (combat.cpp:191-231): see spaceBattles. */
export interface SpaceBattle {
  /** The screen's number: the scenario. */
  screen: number;
  /** The screen's slug, and the problems' location for it. */
  slug: string;
  where: string;
  enter: string | null; exit: string | null; warp: string | null;
  /** The listed objects the export has, in the screen's order (Enter, Exit and Warp too). */
  objects: GameObjectT[];
  /** The ships: each object whose name is a kind's, with that kind's index in `kinds`. */
  ships: { object: GameObjectT; slug: string; type: number }[];
}

/**
 * The space world's screens as battles (Plan 12 R2), for combat.yaml's (ship.yaml had them too until Plan 23): each screen is a scenario, its objects
 * are the ships and the scripts for entering and leaving, in the screen's order. A ship is an object whose name's first ten letters are
 * a kind's name in `kinds`; one that matches none is left out, as Combat::setup does. The kind is the last whose name matches, as the
 * C++ loop assigns without a break (combat.cpp:213-217). Inactive ships are kept: the engine skips them by the object's state when the
 * battle starts. `missing` hears of each object a screen lists that the export lacks.
 */
export function spaceBattles(raw: LiftCtx['raw'], ctx: LiftCtx, kinds: readonly string[], missing: (id: string, where: string) => void): SpaceBattle[] {
  const screens = [...raw.screens.values()].filter(s => s.world === SPACE_WORLD).sort((a, b) => a.screen - b.screen);
  return screens.map(s => {
    const where = `screens/${s.id}`;
    const battle: SpaceBattle = { screen: s.screen, slug: ctx.ids.screen(SPACE_WORLD, s.screen, where), where, enter: null, exit: null, warp: null, objects: [], ships: [] };
    for (const id of s.objects ?? []) {
      const o = raw.objects.get(id);
      if (!o) {
        missing(id, where);
        continue;
      }
      battle.objects.push(o);
      const name = tenLetters(o.name);
      const slug = ctx.ids.object(id, where);
      if (name === 'enter') battle.enter = slug;
      else if (name === 'exit') battle.exit = slug;
      else if (name === 'warp') battle.warp = slug;
      else {
        const type = kinds.lastIndexOf(name);
        if (type >= 0) battle.ships.push({ object: o, slug, type });
      }
    }
    return battle;
  });
}

/**
 * The bridge's contact lists (BridgeScreen::chooseObject, bridge.cpp:351-378): ship screen 1 is Comms', 4 the lounge's, in `listScreenObjects` order.
 * Whether an object is active, and the list's limit of ten, are decided when it is shown; Starfleet (objectID(1, 4, 0x5f)) goes first.
 */
function liftContacts(raw: LiftCtx['raw'], ctx: LiftCtx): ShipData['contacts'] {
  const listed = (screen: number) => (raw.screens.get(`s_${hex2(SHIP_WORLD)}${hex2(screen)}`)?.objects ?? []).filter(id => raw.objects.has(id));
  const starfleet = '5f0401';
  const lounge = listed(4);
  if (lounge.includes(starfleet)) lounge.splice(lounge.indexOf(starfleet), 1), lounge.unshift(starfleet);
  const where = 'screens/s_5f01 and s_5f04';
  return {
    comms: listed(1).map(id => {
      const spriteId = raw.objects.get(id)?.sprite_id;
      // (the sprite file the viewscreen shows for it, lower case without the extension: ViewscreenScreen::start, viewscreen.cpp:44)
      const file = spriteId !== undefined && spriteId !== 0xffff ? raw.sprites._spriteFilenames[spriteId]?.toLowerCase() : undefined;
      return { object: ctx.ids.object(id, where), sprite: spriteId !== 0xffff, ...(file ? { file } : {}) };
    }),
    lounge: lounge.map(id => ctx.ids.object(id, where)),
  };
}
