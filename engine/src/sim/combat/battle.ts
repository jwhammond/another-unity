// SPDX-License-Identifier: GPL-3.0-or-later
import { SHIP_FLAGS } from '../../content/types';
import { MS_CLOCK, tickUnits, unitPercent, UNIT_PHASER, UNIT_SENSOR, UNIT_SHIELD, UNIT_TORPEDO, UNIT_TRACTOR } from '../shipSystems';
import { FLIGHT, fly, steer, updateMaxSpeed } from './flight';
import { bindContext } from './libm';
import { length, sub } from './math';
import { combatTicks, MAX_GAP, STEP_TIME } from './time';
import { checkSensors } from './weapons';
import { KIND, MAX_RANGE, NO_EXIT, cueId, playCue, SHIP_STATE, unitDefs, type BattleContext, type BattleState, type CombatShip } from './types';

/** kConditionTime (combat.cpp:79): how often a ship's condition is worked out. */
export const CONDITION_TIME = combatTicks(0x5af);
/** kViewTime (combat.cpp:70): a view holds 20 s. */
export const VIEW_TIME = 20000;
/** kDefaultZoom (combat.cpp:68). */
export const DEFAULT_ZOOM = 3;
/** Combat's views, as the original numbers them (combat.h:284-303); 0xd and 0xf are unnamed, and like kViewFrozen keep the camera where it is. */
export const VIEW = {
  chase: 0, side: 1, otherSide: 2, top: 3, bottom: 4, chaseClose: 5, waypoint: 6, overview: 7, flyIn: 8, spinRoll: 9, spinYaw: 0xa,
  frozen: 0xb, target: 0xc, orbit: 0xe, tracking: 0x10, drop: 0x11, forward: 0x12, count: 0x13,
} as const;

/** Combat::alive (combat.cpp:386-388). */
export function alive(ship: CombatShip | null | undefined): ship is CombatShip {
  return !!ship && !ship.destroyed;
}
/** A ship's target, `ship->target` (CombatShip::target, combat.h:156): null when it has none. */
export function shipTarget(b: BattleState, ship: CombatShip): CombatShip | null {
  return ship.target === null ? null : b.ships[ship.target] ?? null;
}
/** The Enterprise's target, Combat::_target (combat.h:417): null when there is none. */
export function battleTarget(b: BattleState): CombatShip | null {
  return b.target === null ? null : b.ships[b.target] ?? null;
}
/** Combat::liveShips (combat.cpp:390-397): ships not yet removed. */
export function liveShips(b: BattleState): number {
  return b.ships.filter(s => !s.removed).length;
}
/** Combat::distance (combat.cpp:399-401). */
export function distance(a: CombatShip, c: CombatShip): number {
  return length(sub(a.pos, c.pos));
}
/** Combat::targetOutOfRange (combat.cpp:403-407). */
export function targetOutOfRange(b: BattleState): boolean {
  const target = battleTarget(b);
  if (b.ships.length === 0 || !alive(target)) return false;
  return distance(b.ships[0]!, target) > MAX_RANGE;
}

/** Combat::setView (combat.cpp:680-687). */
export function setView(b: BattleState, ship: number | null, view: number): void {
  if (ship === null || !alive(b.ships[ship]) || view >= VIEW.count) return;
  b.view.viewShip = ship;
  b.view.view = view;
  b.view.viewExpiry = b.now + VIEW_TIME;
  b.view.viewFrame = 0;
}

/**
 * Combat::updateCamera's view state (combat.cpp:848-948), which the sim keeps; the camera's placement is the
 * updateCamera seam's (M8). Called just before that seam, as updateCamera does it before placing the camera.
 * kViewFlyIn's cut to tracking (combat.cpp:893-896) reads the camera's position, so it stays the seam's.
 */
export function updateView(b: BattleState): void {
  const v = b.view;
  // a chosen view lasts a while, then the chase view comes back (combat.cpp:849-855)
  if (v.viewShip === null || !alive(b.ships[v.viewShip]) || (v.viewExpiry && b.now >= v.viewExpiry)) {
    v.viewShip = b.ships.length > 0 ? 0 : null;
    v.view = VIEW.chase;
    v.viewExpiry = 0;
    v.viewFrame = 0;
  }
  // the ship flies past the camera: placed once (the seam's chaseView at 2r, which `dropped` asks for), then tracked,
  // keeping the expiry (combat.cpp:933-939)
  if (v.view === VIEW.drop) {
    const expiry = v.viewExpiry;
    setView(b, v.viewShip, VIEW.tracking);
    v.viewExpiry = expiry;
    v.dropped = true;
  }
}

/** Combat::logMessage (damage.cpp:81-91): a ship's log keeps 15 lines. */
export function logMessage(ship: CombatShip, text: string): void {
  if (ship.logFrozen) return;
  ship.log.push(text);
  if (ship.log.length > 15) {
    ship.log.shift();
    if (ship.logRead > 0) ship.logRead--;
  }
}

/** Combat::updateCondition (combat.cpp:756-787): the ship's strength from its shields, weapons, tractors and sensors. */
export function updateCondition(ctx: BattleContext, b: BattleState, ship: CombatShip): void {
  ship.conditionTime = b.now + CONDITION_TIME;
  const percent = [0, 0, 0, 0];
  const count = [0, 0, 0, 0];
  const defs = unitDefs(ctx, ship);
  ship.systems.units.forEach((u, i) => {
    const type = defs[i]?.type;
    const kind = type === UNIT_SHIELD ? 0 : type === UNIT_PHASER || type === UNIT_TORPEDO ? 1 : type === UNIT_TRACTOR ? 2 : type === UNIT_SENSOR ? 3 : -1;
    if (kind < 0) return;
    percent[kind]! += unitPercent(u);
    count[kind]!++;
  });
  for (let i = 0; i < 4; i++) percent[i] = count[i] ? Math.trunc(percent[i]! / count[i]!) : 0;
  ship.condition = (percent[0]! * 2 + percent[1]! * 3 + percent[2]! + percent[3]! * 2) >> 3;
}

/** The self-destruct countdown's lines: with 7, 5, 3 and 1 seconds left (combat.cpp:481-483). */
const COUNTDOWN_SECONDS = [0, 2, 4, 6];

/**
 * Combat::step (combat.cpp:421-505), in ScummVM's order. Plan 19 owns flight, the systems' tick, decloaking, the
 * condition and the enemy self-destruct countdown; the rest are the seams (types.ts CombatSeams). Each stage returns
 * early once the exit code is set (combat.cpp:464-465, 489-490, 496-497).
 */
export function step(ctx: BattleContext, b: BattleState): void {
  const seams = ctx.seams;
  b.steps++;
  // (combat.cpp:422-424: only a live Enterprise, not dying, is steered; steer cancels Delegate and a maneuver, 519-525)
  const enterprise = b.ships[0];
  if (alive(enterprise) && !(enterprise.flags & SHIP_STATE.dying)) steer(ctx, b);

  for (const s of b.ships) {
    if (!alive(s)) continue;
    tickUnits(unitDefs(ctx, s), s.systems, b.now, MS_CLOCK);
    if (s.decloakTime && b.now >= s.decloakTime) {
      s.decloakTime = 0;
      // (the crew's cue as a cloaked ship appears: combat.cpp:433-434)
      if (s.flags & SHIP_FLAGS.canCloak) playCue(b, cueId(ctx, 'decloak'));
    }
    if (b.now >= s.conditionTime) {
      updateCondition(ctx, b, s);
      seams.enemySystemsCheck(ctx, b, s);
    }
    // (some ships have been scheduled to blow up)
    if (s.removeTime && b.now >= s.removeTime) {
      s.removeTime = 0;
      seams.destroy(ctx, b, s);
      continue;
    }
    updateMaxSpeed(s);

    // who flies it: the player, tactics, or the AI
    const isEnterprise = s.type === KIND.enterprise;
    const delegated = b.console.delegate && b.console.kernelReady;
    const ai = !isEnterprise || s.engaged || delegated;
    if (isEnterprise) {
      if (delegated) {
        seams.runAI(ctx, b, s);
      } else {
        if (s.target === null) seams.autoTarget(ctx, b, s);
        if (s.engaged && s.script) seams.runScript(ctx, b, s);
      }
    } else if (s.type === KIND.starbase) {
      seams.starbase(ctx, b, s);
    } else {
      seams.runAI(ctx, b, s);
    }
    if (b.exitCode !== NO_EXIT) return;
    if (ai) {
      seams.avoidCollision(ctx, b, s);
      if (s.waypointActive && b.now >= s.freezeTime) seams.steerTowards(ctx, b, s, s.waypoint);
      seams.filterInputs(ctx, b, s);
    }
    // a ship counting down to blowing itself up
    if (s.selfDestructTime && !isEnterprise) {
      if (b.now >= s.selfDestructTime) {
        s.selfDestructTime = 0;
        s.flags |= SHIP_FLAGS.blast;
        seams.destroy(ctx, b, s);
        continue;
      }
      // (uint32 left, uint seconds: whole seconds, rounded down)
      const left = (s.selfDestructTime - b.now) >>> 0;
      const seconds = Math.trunc(left / 1000);
      if (left % 1000 >= 1000 - STEP_TIME && COUNTDOWN_SECONDS.includes(seconds)) logMessage(s, `${seconds + 1} seconds until detonation`);
    }
    fly(ctx, s, ai);
    if (s.activeBeams) seams.updateBeams(ctx, b, s);
    seams.updateEffects(ctx, b, s);
    if (b.exitCode !== NO_EXIT) return;
  }
  seams.updateTorpedoes(ctx, b);
  seams.updateDebris(ctx, b);
  seams.updateSelfDestruct(ctx, b);
  seams.updateLamps(ctx, b);
  if (b.exitCode !== NO_EXIT) return;

  // the user orbits the camera around the Enterprise
  // (combat.cpp:500-501: left turns by kOrbitSpeed * kStepTime / 1000, in uint32, and right by -kOrbitSpeed * (int)kStepTime / 1000; both 91)
  const held = b.input.held;
  if (held & ((1 << FLIGHT.orbitLeft) | (1 << FLIGHT.orbitRight))) {
    orbit(b, held & (1 << FLIGHT.orbitLeft) ? Math.trunc((ORBIT_SPEED * STEP_TIME) / 1000) : Math.trunc((-ORBIT_SPEED * STEP_TIME) / 1000));
  }
  updateView(b);
  seams.updateCamera(ctx, b);
  b.view.viewFrame++;
}

/** kOrbitSpeed (combat.cpp:73): the camera orbits 30 degrees a second, 16384 to a turn. */
export const ORBIT_SPEED = 1380;
/** kOrbitDelay (combat.cpp:72): 0x12 ticks of the original's 291 a second, 61 ms. */
export const ORBIT_DELAY = combatTicks(0x12);

/** Combat::orbit (combat.cpp:706-714): at most every ORBIT_DELAY, unless it changes direction. */
export function orbit(b: BattleState, stepAngle: number): void {
  // (uint32 _now - _lastOrbit)
  if (((b.now - b.view.lastOrbit) >>> 0) < ORBIT_DELAY && (stepAngle < 0) === (b.view.lastOrbitStep < 0)) return;
  b.view.lastOrbit = b.now;
  b.view.lastOrbitStep = stepAngle;
  b.view.orbitAngle = (b.view.orbitAngle + stepAngle) & 0x3fff;
  setView(b, 0, VIEW.orbit);
}

/**
 * Combat::update (combat.cpp:409-419): every step due by `now` (battle ms), on the fixed STEP_TIME; after a gap of
 * more than MAX_GAP, one step and no catching up. Like ScummVM's, the loop goes on stepping after the exit code is
 * set (the screen leaves after update returns): each step's stages return early.
 */
export function updateBattle(ctx: BattleContext, b: BattleState, now: number): void {
  bindContext(ctx);
  // (the sensors are asked at the last step's time: ScummVM's radar draw saw the frame before's _now, which Plan 22's
  // traces pair with the step before, so a battle is the same however its frames fall: Plan 23 R10)
  b.now = b.lastStep;
  // (after a pause, don't try to catch up; uint32 now - _lastStep, so a clock gone back also skips to one step)
  if (((now - b.lastStep) >>> 0) > MAX_GAP) b.lastStep = now - STEP_TIME;
  while (((now - b.lastStep) >>> 0) >= STEP_TIME) {
    // the radar's draw before each step asks the sensors, while it shows and the Enterprise lives (tactical.cpp:1111-1113,
    // 1062-1063, 1315-1316): once a step, as Plan 22's traces pair them, so a battle doesn't depend on the frame rate (Plan 23 R10).
    // Its answer is the radar's: whether the blips show (tactical.cpp:1112-1113; Plan 27 R5)
    if (b.console.radarShown && alive(b.ships[0])) b.console.radarSeen = checkSensors(ctx, b);
    b.lastStep += STEP_TIME;
    b.now = b.lastStep;
    step(ctx, b);
    ctx.onStep?.(b);
  }
  b.now = now;
}
