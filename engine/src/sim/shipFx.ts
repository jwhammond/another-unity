// SPDX-License-Identifier: GPL-3.0-or-later
import type { ShipFx } from '../content/types';
import { recordReading, setHidden } from './computer';
import type { Vec3i } from './ship';
import { resetSystems, setDamage, UNIT_ALL } from './shipSystems';
import type { World } from './world';

/** NUM_WARP_MOVIES (origdata.h:113). */
export const NUM_WARP_MOVIES = 6;

/** Astrogation::_flags[id] = flags (a script's reveal, object.cpp:1775-1778); the event says what changed. */
export function setAstroFlag(world: World, id: number, to: number): void {
  const flags = world.state.ship.flags;
  while (flags.length <= id) flags.push(0);
  const from = flags[id];
  if (from === to) return;
  flags[id] = to;
  world.bus.emit({ type: 'astroFlag', id, from, to });
}

/**
 * GeneralBlock 1, 2, 7, 8, 9 and 10 (object.cpp:1767-1800) and AlterBlock's universe move (1310-1319). A game with no
 * ship warns and changes nothing.
 */
export function applyShipFx(world: World, fx: ShipFx): void {
  world.bus.emit({ type: 'shipEffect', effect: structuredClone(fx) });
  const c = world.content.ship;
  if (!c) { world.bus.emit({ type: 'warning', message: 'a ship effect in a game with no ship' }); return; }
  const ship = world.state.ship;
  if ('newWarpMovie' in fx) {
    // (the next warp shows a movie not seen before: object.cpp:1767-1770)
    ship.newWarpMovie = true;
  } else if ('reveal' in fx) {
    // (object.cpp:1771-1775)
    const id = c.universe.reveals[fx.reveal];
    if (id !== undefined) setAstroFlag(world, id, (ship.flags[id] ?? 0) | 0x10);
  } else if ('repair' in fx) {
    // setDamage(kUnitAll, 1) and reset() (object.cpp:1777-1780)
    setDamage(c, ship.systems, UNIT_ALL, 1);
    resetSystems(c, ship.systems);
  } else if ('computer' in fx) {
    // (object.cpp:1782-1800)
    const entry = c.computer.entryIds[fx.entry];
    if (entry === undefined) { world.bus.emit({ type: 'warning', message: `unknown computer entry ${fx.entry}` }); return; }
    if (fx.computer === 'record') { for (const r of c.computer.readings) if (r.entry === entry) recordReading(world, r.key); }
    else setHidden(world, entry, fx.computer === 'hide');
  } else {
    // AlterBlock (object.cpp:1310-1319): the Enterprise warps there through astrogation, others move in space
    const u = fx.universe;
    if (u.object === c.data.astro.enterprise) requestScriptedWarp(world, u.x * 1000000 + u.y * 1000 + u.z, u.speed);
    else moveInUniverse(world, u.object, { x: u.x, y: u.y, z: u.z });
  }
}

/** Astrogation::scriptedWarp (astrogation.cpp:633-647): false, with a warning, if no warp has the code. */
export function requestScriptedWarp(world: World, code: number, speed: number | undefined): boolean {
  const warps = world.content.ship?.universe.scriptedWarps ?? [];
  if (!warps.some(w => w.code === code)) {
    world.bus.emit({ type: 'warning', message: `no scripted warp to ${code}` });
    return false;
  }
  const ship = world.state.ship;
  ship.scriptedWarp = code;
  ship.warpPending = true;
  // (0 keeps the speed as it is)
  if (speed !== undefined && speed !== 0xffff && speed) ship.warpSpeed = speed;
  world.bus.emit({ type: 'scriptedWarp', code, speed: ship.warpSpeed });
  return true;
}

/** UnityEngine::moveInUniverse (unity.cpp:440-456): replaces the object's last move; it starts from where it is now. */
export function moveInUniverse(world: World, object: string, to: Vec3i): void {
  const ship = world.state.ship;
  ship.universeMoves = ship.universeMoves.filter(m => m.object !== object);
  const at = world.state.objects[object]?.universe ?? { x: 0, y: 0, z: 0 };
  ship.universeMoves.push({ object, start: world.clock.now, from: { ...at }, to: { ...to } });
  world.bus.emit({ type: 'universeMove', object, to: { ...to } });
}

/**
 * Astrogation::playWarpMovie (astrogation.cpp:797-813): a new movie when scripts ask for one, otherwise one seen
 * before, chosen on the game RNG (R11). Returns the movie's index; it plays from 1.
 */
export function chooseWarpMovie(world: World): number {
  const ship = world.state.ship;
  if (ship.newWarpMovie && ship.warpMoviesSeen === NUM_WARP_MOVIES - 1) ship.newWarpMovie = false;
  if (ship.newWarpMovie || !ship.warpMoviesSeen) {
    ship.newWarpMovie = false;
    return ++ship.warpMoviesSeen;
  }
  return world.rng.next(ship.warpMoviesSeen - 1, 'warpMovie') + 1;
}
