// SPDX-License-Identifier: GPL-3.0-or-later
import type { ProximityDef } from '../content/types';
import { perform } from './actions';
import { atPlanetFor, engage, msToTicks, retarget, updateAstro } from './astro';
import { delayShipTimers as delay, STATION_CODE } from './ship';
import { MS_CLOCK, tickSystems, tickUnits } from './shipSystems';
import { clockRunsAt, startClock, dispatchHail, HAIL_DISPATCHED, gotoShipScreen } from './stations';
import { checkTriggers } from './timers';
import { syncBattleClock, tacticalFrame } from './tacticalScreen';
import { transporterTick } from './transporter';
import type { World } from './world';

/** kShipTriggerInterval (unity.cpp:782): the ship's triggers are checked every 25th frame at 15 fps, 25 * 1000 / 15 ms. R1. */
export const SHIP_TRIGGER_TICKS = msToTicks(Math.trunc(25 * 1000 / 15));

/** Trigger::proximityTick (trigger.cpp:62-91), exactly: whether the ship's range of a place fires the trigger. */
export function proximityFires(world: World, p: ProximityDef): boolean {
  const fromObj = world.state.objects[p.from]?.universe;
  const toObj = world.state.objects[p.to]?.universe;
  if (!fromObj || !toObj) return false;

  const dx = fromObj.x - toObj.x;
  const dy = fromObj.y - toObj.y;
  const dz = fromObj.z - toObj.z;
  const distance = p.dist * p.dist;
  const inside = dx * dx + dy * dy + dz * dz <= distance;
  const fireInside = !p.reversed;

  // being at the place a scripted warp goes means being at its planet
  const match = atPlanetFor(world, toObj);

  // (this is the original's logic, exactly)
  if (!inside || !fireInside) {
    if ((!inside || (!match && distance === 0)) && !fireInside) return !match || distance !== 0;
    return false;
  }
  if (distance === 0 && world.state.ship.transit !== null) return false;
  if (distance !== 0) return true;
  return match;
}

export const delayShipTimers = delay;

/** kUniverseMoveTime (unity.cpp:424): 0x19938 of the original's ticks, in milliseconds, then in ticks. */
export const UNIVERSE_MOVE_TICKS = msToTicks(Math.trunc(0x19938 * 1000 / 291));

/** UnityEngine::updateUniverseMoves (unity.cpp:458-476): from + trunc((to - from) * elapsed / T), clipped to 0..159; done moves go. */
export function updateUniverseMoves(world: World): void {
  const ship = world.state.ship;
  if (ship.universeMoves.length === 0) return;
  const now = world.clock.now;
  const clip = (v: number) => Math.min(Math.max(v, 0), 159);
  ship.universeMoves = ship.universeMoves.filter(move => {
    const elapsed = now - move.start;
    const done = elapsed >= UNIVERSE_MOVE_TICKS;
    const at = (a: number, b: number) => clip(done ? b : a + Math.trunc((b - a) * elapsed / UNIVERSE_MOVE_TICKS));
    const o = world.state.objects[move.object];
    if (o) o.universe = { x: at(move.from.x, move.to.x), y: at(move.from.y, move.to.y), z: at(move.from.z, move.to.z) };
    return !done;
  });
}

/** BridgeScreen::update (bridge.cpp:240-246): what happens after a battle. The leader uses the object, as objectID(0, 0, 0). */
function runBridgeUse(world: World): void {
  const ship = world.state.ship;
  const id = ship.bridgeUse;
  ship.bridgeUse = null;
  if (id === null || !world.state.objects[id]) return;
  void world.enqueue(async () => {
    await perform(world, { verb: 'use', target: id, who: world.content.start.leader, other: null, walked: false });
  });
}

const go = (world: World, code: number): void => {
  void world.enqueue(async () => { await gotoShipScreen(world, code); });
};

/**
 * dispatchPendingHail then gotoShipScreen (bridge.cpp:259-263, astrogation.cpp:1214-1219), with the triggers checked
 * after the screen change in the same task: the original's same-frame processTriggers (M8). True if a hail was queued.
 */
function dispatchAndGo(world: World): boolean {
  const hail = world.state.pendingHail;
  if (hail === null || !HAIL_DISPATCHED.includes(hail.type)) return false;
  void world.enqueue(async () => {
    const code = await dispatchHail(world);
    if (code !== null) await gotoShipScreen(world, code);
    checkTriggers(world, 'ship');
  });
  return true;
}

/**
 * One frame on the ship (the ship's half of unity.cpp's main loop, 1759-1770): the bridge's or astrogation's own update
 * (bridge.cpp:239-265, astrogation.cpp:1180-1220), things moving in space, and the ship's triggers. The other stations wait.
 * The astrogation screen's every-16th-frame gate is not modelled (R8).
 */
export function shipTick(world: World): void {
  const ship = world.state.ship;
  // (a save made at the computer loads with the clock still stopped: the bridge's own screen starts it)
  if (world.computer === null && clockRunsAt(ship.station)) startClock(world);
  // (ShipSystems::tick runs from the bridge's, astrogation's, the computer's and engineering's updates: bridge.cpp:248, astrogation.cpp:1186,
  // computer.cpp:300, engineering.cpp:177)
  const ticksSystems = world.computer !== null || ship.station === 'bridge' || ship.station === 'astrogation' || ship.station === 'engineering';
  // (in a battle the Enterprise's systems are on the battle's clock, ScummVM's one clock: engineering ticks them there, Plan 23 R8)
  if (ticksSystems && world.content.ship) {
    if (world.battle) tickUnits(world.content.ship.data.units, ship.systems, syncBattleClock(world, world.battle), MS_CLOCK);
    else tickSystems(world.content.ship, ship.systems, world.clock.now);
  }
  // (the computer's own update only ticks the ship's systems, computer.cpp:326: no journey, no hail, no triggers, no moves)
  if (world.computer !== null) return;
  // (TransporterScreen::update, transporter.cpp:419-426: on the easiest level the beam happens by itself)
  if (ship.station === 'transporter' && transporterTick(world)) return;
  if (ship.station === 'bridge') {
    if (ship.bridgeUse !== null) return runBridgeUse(world);
    updateAstro(world);
    // (updateRegion: region chatter is after M4, R10)
    if (dispatchAndGo(world)) return;
    if (ship.warpPending) return go(world, STATION_CODE.astrogation | 0x100);
  } else if (ship.station === 'tactical') {
    // (TacticalScreen::update: tacticalScreen.ts)
    if (world.battle) tacticalFrame(world);
  } else if (ship.station === 'astrogation') {
    updateAstro(world);
    if (world.autoEngage !== null) {
      const course = world.autoEngage;
      world.autoEngage = null;
      if (engage(world, course) === null) return go(world, STATION_CODE.bridge | 0x100);
    }
    if (dispatchAndGo(world)) return;
    if (ship.warpPending) retarget(world);
  }
  if (ship.station === 'bridge' || ship.station === 'astrogation') updateUniverseMoves(world);
  checkTriggers(world, 'ship');
}
