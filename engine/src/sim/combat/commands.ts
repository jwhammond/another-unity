// SPDX-License-Identifier: GPL-3.0-or-later
import { alive, setView, VIEW } from './battle';
import { FLIGHT, stop } from './flight';
import { bindContext } from './libm';
import { combatTicks } from './time';
import { cueId, playCue, SHIP_STATE, type BattleContext, type BattleState } from './types';

/** A held direction: -1, 0 (let go) or 1. */
export type Held = -1 | 0 | 1;

/**
 * The battle's inputs (spec §4.5): typed commands, never raw keys. The tactical screen (and M8's keys, buttons and
 * gamepad) turns what the player does into these; a walkthrough and the debug view issue them directly.
 */
export type CombatCommand =
  /** The flight keys held (kActionPitchDown..kActionDecelerate, metaengine.cpp:114-121), which steer ramps each step. */
  | { type: 'steer'; yaw: Held; pitch: Held; roll: Held; throttle: Held }
  | { type: 'allStop' }
  | { type: 'fire'; weapon: 'phasers' | 'torpedoes' | 'both' }
  | { type: 'target'; which: 'next' | 'prev' }
  | { type: 'target'; ship: number | null }
  /** The Phasers page: a bank's slider (0-100), or All and None (dragSlider, tactical.cpp:618-631; pressButton, 565-569). */
  | { type: 'bank'; bank: number; setting: number }
  | { type: 'banks'; all: boolean }
  /** The Torpedoes page: a tube's salvo slider (0-10, tactical.cpp:627-630) and the spread's cell (0-9). */
  | { type: 'salvo'; tube: 0 | 1; setting: number }
  | { type: 'spread'; cell: number }
  | { type: 'shields'; on: boolean }
  | { type: 'weaponsLock'; on: boolean }
  | { type: 'delegate'; on: boolean }
  | { type: 'selfDestruct' }
  | { type: 'powerLevel'; level: number }
  /** The Tactics page: a row of the maneuver menu, its arrows and Engage (tactical.cpp:666-686). */
  | { type: 'maneuver'; row: number }
  | { type: 'scrollManeuvers'; direction: -1 | 1 }
  | { type: 'engage' }
  | { type: 'hail' }
  | { type: 'bridge' }
  | { type: 'engineering' }
  /** These change only what the presentation reads. */
  | { type: 'view'; view: number; ship: 'enterprise' | 'target' }
  | { type: 'cycleView' }
  | { type: 'zoom'; direction: 'in' | 'out' }
  | { type: 'orbit'; direction: Held }
  | { type: 'wide'; on: boolean }
  /** The console's radar opened or closed (M8's phone drawer; ScummVM's is always open): whether the steps ask the sensors (Plan 23 R10). */
  | { type: 'radar'; open: boolean }
  /** The console's tab (mouseClick, tactical.cpp:655-658): the sim reads only whether it is CONN (_connPage, set each frame, tactical.cpp:471). */
  | { type: 'page'; page: ConsolePage };

/**
 * The console's six pages, in the original's order: kPagePhasers, kPageTorpedoes and kPageConn (tactical.cpp:57-60;
 * kPage names only these), kPageDamage (:228), kPageTactics (:184) and kPageSensors (:229).
 */
export const CONSOLE_PAGES = ['phasers', 'torpedoes', 'damage', 'conn', 'tactics', 'sensors'] as const;
export type ConsolePage = (typeof CONSOLE_PAGES)[number];

const bit = (n: number) => 1 << n;
/** Held directions as Combat::_held's bits (TacticalScreen::actionStart, tactical.cpp:731-737, sets `_held |= 1 << flight` from flightAction, 704-728; Combat::setHeld, combat.cpp:676-678): less is the first of each pair (FlightAction, combat.h:249-260). */
function heldBits(c: { yaw: Held; pitch: Held; roll: Held; throttle: Held }): number {
  let held = 0;
  if (c.pitch < 0) held |= bit(FLIGHT.pitchDown);
  if (c.pitch > 0) held |= bit(FLIGHT.pitchUp);
  if (c.roll < 0) held |= bit(FLIGHT.rollLeft);
  if (c.roll > 0) held |= bit(FLIGHT.rollRight);
  if (c.yaw < 0) held |= bit(FLIGHT.yawLeft);
  if (c.yaw > 0) held |= bit(FLIGHT.yawRight);
  if (c.throttle > 0) held |= bit(FLIGHT.accelerate);
  if (c.throttle < 0) held |= bit(FLIGHT.decelerate);
  return held;
}
const ORBIT_BITS = bit(FLIGHT.orbitLeft) | bit(FLIGHT.orbitRight);

/** Combat::setTarget (combat.cpp:750-754). */
export function setTarget(b: BattleState, ship: number | null): void {
  b.target = ship;
  if (b.ships[0]) b.ships[0].target = ship;
}

/** Combat::nextTarget (combat.cpp:732-748): the next (or previous) live, visible ship that isn't the Enterprise, in 9 tries; else none. */
export function nextTarget(b: BattleState, direction: 1 | -1): void {
  const n = b.ships.length;
  if (n < 2) return;
  // (the target's index, or 0 with none)
  let index = b.target ?? 0;
  let found: number | null = null;
  for (let tries = 0; tries < 9 && found === null; tries++) {
    index = (index + direction + n) % n;
    const ship = b.ships[index]!;
    if (index !== 0 && alive(ship) && !(ship.flags & SHIP_STATE.dying) && !ship.decloakTime) found = index;
  }
  setTarget(b, found);
}

/** kCycleDelay (combat.cpp:71): 0x48 ticks of the original's 291 a second, 247 ms. */
export const CYCLE_DELAY = combatTicks(0x48);

/** Combat::cycleView (combat.cpp:689-704): the next live ship, and after the last ship the next view. */
export function cycleView(b: BattleState): void {
  // (uint32 _now - _lastCycle, combat.cpp:690)
  if (((b.now - b.view.lastCycle) >>> 0) < CYCLE_DELAY) return;
  b.view.lastCycle = b.now;
  for (let tries = 0; tries < b.ships.length * VIEW.count; tries++) {
    b.view.cycleShip++;
    if (b.view.cycleShip >= b.ships.length) {
      b.view.cycleShip = 0;
      b.view.cycleView = (b.view.cycleView + 1) % VIEW.count;
    }
    if (alive(b.ships[b.view.cycleShip])) {
      setView(b, b.view.cycleShip, b.view.cycleView);
      return;
    }
  }
}

/** kZoomStep (combat.cpp:69). */
const ZOOM_STEP = 0.75;
/** Combat::zoomIn and zoomOut (combat.cpp:716-730): levels -1 to 3. */
export function zoom(b: BattleState, direction: 'in' | 'out'): boolean {
  if (direction === 'in') {
    if (b.view.zoomLevel >= 3) return false;
    b.view.zoomLevel++;
    b.view.zoom = Math.fround(b.view.zoom - ZOOM_STEP);
  } else {
    if (b.view.zoomLevel <= -1) return false;
    b.view.zoomLevel--;
    b.view.zoom = Math.fround(b.view.zoom + ZOOM_STEP);
  }
  return true;
}

/**
 * A command, as the tactical screen's actionStart, pressButton and mouseClick do it (tactical.cpp:523-574, 646-700, 731-816):
 * at once, between steps. The key-repeat and button delays (tactical.cpp:209-210) are the input's (M8).
 */
export function applyCommand(ctx: BattleContext, b: BattleState, cmd: CombatCommand): void {
  bindContext(ctx);
  const seams = ctx.seams;
  const enterprise = b.ships[0];
  switch (cmd.type) {
    case 'steer':
      b.input.held = (b.input.held & ORBIT_BITS) | heldBits(cmd);
      return;
    case 'orbit':
      b.input.held = (b.input.held & ~ORBIT_BITS) | (cmd.direction < 0 ? bit(FLIGHT.orbitLeft) : 0) | (cmd.direction > 0 ? bit(FLIGHT.orbitRight) : 0);
      return;
    case 'allStop':
      // (actionStart's kActionStop, tactical.cpp:748-751: Combat::stop, then the "all stop" cue)
      stop(b);
      playCue(b, cueId(ctx, 'allStop'));
      return;
    case 'fire':
      if (!enterprise) return;
      if (cmd.weapon !== 'torpedoes') seams.firePhasers(ctx, b, enterprise);
      if (cmd.weapon !== 'phasers') seams.fireTorpedoes(ctx, b, enterprise, 0);
      return;
    case 'target':
      if ('which' in cmd) nextTarget(b, cmd.which === 'next' ? 1 : -1);
      // (a ship past the last is no target: nothing changes, as the harness ignores it, harness.inc `target`)
      else if (cmd.ship === null || cmd.ship < b.ships.length) setTarget(b, cmd.ship);
      return;
    case 'bank': {
      // (dragSlider, tactical.cpp:618-631)
      const bank = enterprise?.banks[cmd.bank];
      if (bank) bank.setting = Math.max(0, Math.min(100, Math.trunc(cmd.setting)));
      return;
    }
    case 'banks':
      for (const bank of enterprise?.banks ?? []) bank.setting = cmd.all ? 100 : 0;
      return;
    case 'salvo':
      b.console.salvo[cmd.tube].setting = Math.max(0, Math.min(10, Math.trunc(cmd.setting)));
      return;
    // (pressButton, tactical.cpp:523-574)
    case 'spread':
      if (cmd.cell >= 0 && cmd.cell < 10) seams.setSpread(ctx, b, cmd.cell);
      return;
    case 'shields': seams.raiseShields(ctx, b, cmd.on); return;
    case 'weaponsLock': seams.setWeaponsLock(ctx, b, cmd.on); return;
    case 'delegate': seams.setDelegate(ctx, b, cmd.on, true); return;
    case 'selfDestruct': seams.armSelfDestruct(ctx, b); return;
    case 'powerLevel': if (cmd.level >= 0 && cmd.level < 5) seams.setPowerLevel(ctx, b, cmd.level, false); return;
    case 'maneuver': seams.clickManeuver(ctx, b, cmd.row); return;
    case 'scrollManeuvers': seams.scrollManeuvers(ctx, b, cmd.direction); return;
    case 'engage': seams.engageManeuver(ctx, b); return;
    case 'hail': seams.hail(ctx, b); return;
    case 'bridge': seams.bridge(ctx, b); return;
    case 'engineering': seams.engineering(ctx, b); return;
    case 'view':
      // (actionStart's kActionCameraView1-8, tactical.cpp:789-813: setView of the Enterprise, or of the target for view 3)
      setView(b, cmd.ship === 'enterprise' ? 0 : b.target, cmd.view);
      return;
    case 'cycleView': cycleView(b); return;
    case 'zoom': zoom(b, cmd.direction); return;
    // (the wide view has no radar, tactical.cpp:1315-1316)
    case 'wide': b.view.wide = cmd.on; b.console.radarShown = b.console.radarOpen && !cmd.on; return;
    case 'radar': b.console.radarOpen = cmd.open; b.console.radarShown = cmd.open && !b.view.wide; return;
    case 'page': b.console.connPage = cmd.page === 'conn'; return;
  }
}
