// SPDX-License-Identifier: GPL-3.0-or-later
import { add, angleFromSinCos, apply, clip, cosAngle, fma32, fr, fromAngles, mul, scale, sinAngle, sqrtf, transpose, v3 } from './math';
import { ENTERPRISE_UNITS, KIND, cueId, playCue, type BattleContext, type BattleState, type CombatShip } from './types';
import { STEP_TIME } from './time';

/** kStepSeconds (combat.cpp:60): kStepTime / 1000.0f. */
export const STEP_SECONDS = fr(STEP_TIME / 1000);
/** kControlRamp (combat.cpp:62): 100.0f * kStepSeconds / 3.0f, so the controls reach full deflection in 3 s. */
export const CONTROL_RAMP = fr(fr(100 * STEP_SECONDS) / 3);
/** kControlRelease (combat.cpp:63): and recentre within 2 s (battle ms, already ScummVM's clock). */
export const CONTROL_RELEASE = 2000;
/** kMinReverseSpeed (combat.cpp:64). */
export const MIN_REVERSE_SPEED = -500;

/** FlightAction (combat.h:249-260): bit numbers of Combat::_held (BattleState.input.held). */
export const FLIGHT = {
  pitchDown: 0, pitchUp: 1, rollLeft: 2, rollRight: 3, yawLeft: 4, yawRight: 5, accelerate: 6, decelerate: 7, orbitLeft: 8, orbitRight: 9,
} as const;
/** steer's flightKeys (combat.cpp:517): the keys that fly the ship, pitchDown to decelerate (not the camera's orbit). */
const FLIGHT_KEYS = 0xff;
/** The controls' range, CLIP(value, -100.0f, 100.0f) (combat.cpp:549, 561), and full deflection in fly (inputs[i] / 100.0f, combat.cpp:613, 617, 626). */
const FULL = 100;
/** (combat.cpp:634-635): a ship this small turns a quarter faster under the AI. */
const SMALL_RADIUS = 400;
const SMALL_TURN = fr(1.25);
/** All stop (combat.cpp:607): the throttle stops once it is under this. */
const STOPPED = 0.5;

/** signOf (combat.cpp:591-593). */
const signOf = (n: number): number => (n < 0 ? -1 : n > 0 ? 1 : 0);

/**
 * Combat::steer (combat.cpp:515-562): the held keys move the Enterprise's controls. Flying by hand stops a maneuver
 * and Delegate (spec §4.5). Each axis ramps by CONTROL_RAMP a step while held; let go, it recentres, by value × the
 * time since release / 2 s each step, and is 0 after 2 s. The throttle is a lever: it stays where it is left.
 * Combat::step calls it only for a live Enterprise not dying (combat.cpp:422-424); Plan 19's step does the same.
 */
export function steer(ctx: BattleContext, b: BattleState): void {
  const ship = b.ships[0];
  if (!ship) return;
  const controls = ship.controls;
  const held = b.input.held;
  if ((held & FLIGHT_KEYS) && (ship.engaged || b.console.delegate)) {
    ctx.seams.engage(ctx, b, 0);
    if (b.console.delegate) ctx.seams.setDelegate(ctx, b, false, false);
    // (the crew's cue as the player takes the helm: combat.cpp:524)
    if (!ship.engaged) playCue(b, cueId(ctx, 'handFlight'));
  }
  // pitch, roll and yaw: each has a key for either way
  const axes = ['pitch', 'roll', 'yaw'] as const;
  for (let axis = 0; axis < axes.length; axis++) {
    const less = (held & (1 << (FLIGHT.pitchDown + axis * 2))) !== 0;
    const more = (held & (1 << (FLIGHT.pitchUp + axis * 2))) !== 0;
    let value = controls[axes[axis]!];
    if (less || more) {
      if (less) value = fr(value - CONTROL_RAMP);
      if (more) value = fr(value + CONTROL_RAMP);
      b.input.releaseStart[axis] = 0;
    } else if (value !== 0) {
      // the controls recentre once let go
      if (!b.input.releaseStart[axis]) b.input.releaseStart[axis] = b.now;
      // (uint32 time = _now - _releaseStart[axis])
      const time = (b.now - b.input.releaseStart[axis]!) >>> 0;
      if (time >= CONTROL_RELEASE) value = 0;
      // (value -= value * time / (float)kControlRelease: a product under a division is not fused, Plan 19's R2)
      else value = fr(value - fr(fr(value * fr(time)) / CONTROL_RELEASE));
    }
    controls[axes[axis]!] = clip(value, -FULL, FULL);
  }
  // but the throttle is a lever
  if (held & (1 << FLIGHT.accelerate)) {
    controls.throttle = fr(controls.throttle + CONTROL_RAMP);
    controls.stopping = false;
  }
  if (held & (1 << FLIGHT.decelerate)) {
    controls.throttle = fr(controls.throttle - CONTROL_RAMP);
    controls.stopping = false;
  }
  controls.throttle = clip(controls.throttle, -FULL, FULL);
}

/** Combat::stop (combat.cpp:507-513): all stop. The throttle runs down in fly; the turns centre at once. */
export function stop(b: BattleState): void {
  const ship = b.ships[0];
  // (!alive(ship), combat.cpp:386-388)
  if (!ship || ship.destroyed) return;
  ship.controls.stopping = true;
  ship.controls.yaw = ship.controls.pitch = ship.controls.roll = 0;
}

/** r[i] = units[i].max ? (float)units[i].current / units[i].max : 0.0f (combat.cpp:568-569, 581-582). */
function ratios(ship: CombatShip, count: number): number[] {
  const r: number[] = [];
  for (let i = 0; i < count; i++) {
    const u = ship.systems.units[i];
    r.push(u && u.max ? fr(u.current / u.max) : 0);
  }
  return r;
}

/**
 * Combat::updateMaxSpeed (combat.cpp:564-589): a ship's top speed follows its engines; the Enterprise's, its impulse
 * engines (units 29-31) and reactors (33-34); another ship's, its units 15-16 and 18-19. A ship with engines and
 * nothing else still makes 15%.
 */
export function updateMaxSpeed(ship: CombatShip): void {
  if (ship.type !== KIND.enterprise) {
    const r = ratios(ship, ship.systems.units.length);
    const at = (i: number) => r[i] ?? 0;
    // (combat.cpp:570-571: r[16] * 0.85f + r[15] * 0.15f; (r[18] * 0.75f + r[19] * 0.25f) * engines * 1.2f)
    const engines = fma32(at(16), fr(0.85), fr(at(15) * fr(0.15)));
    let f = fr(fr(fma32(at(18), fr(0.75), fr(at(19) * fr(0.25))) * engines) * fr(1.2));
    f = Math.min(f, 1);
    if (f === 0 && engines > 0) f = fr(0.15);
    ship.maxSpeed = fr(ship.baseMaxSpeed * f);
    return;
  }
  // the Enterprise's top speed depends on its engines and reactors
  const r = ratios(ship, ENTERPRISE_UNITS);
  // (combat.cpp:583-584: r[29] * 0.5f + r[30] * 0.25f + r[31] * 0.25f; ((r[33] * 0.25f + 0.65f) + r[34] * 0.1f) * impulse * 1.2f)
  const impulse = fma32(r[31]!, fr(0.25), fma32(r[29]!, fr(0.5), fr(r[30]! * fr(0.25))));
  let f = fr(fr(fma32(r[34]!, fr(0.1), fma32(r[33]!, fr(0.25), fr(0.65))) * impulse) * fr(1.2));
  f = Math.min(f, 1);
  if (f === 0 && impulse > 0) f = fr(0.15);
  ship.maxSpeed = fr(ship.baseMaxSpeed * f);
}

/**
 * Combat::fly (combat.cpp:595-674): a step of flight. By hand (`ai` false), the controls index the flight tables:
 * turns by deflection, a target speed by throttle, slower turns at speed. Flown by the AI or tactics, the inputs are
 * turn rates already, scaled by speed. Then the ship turns in its own frame, its speed eases toward the target, and
 * it moves along its heading.
 */
export function fly(ctx: BattleContext, ship: CombatShip, ai: boolean): void {
  const { turns, speeds, turnScales: scales } = ctx.combat.flight;
  const controls = ship.controls;
  const dt = STEP_SECONDS;
  const d = [0, 0, 0];
  const inputs = [controls.yaw, controls.pitch, controls.roll];
  if (!ai) {
    if (controls.stopping) {
      // (combat.cpp:606: throttle -= throttle * dt)
      controls.throttle = fma32(-controls.throttle, dt, controls.throttle);
      if (Math.abs(controls.throttle) < STOPPED) {
        controls.throttle = 0;
        controls.stopping = false;
      }
    }
    for (let i = 0; i < 3; i++) {
      const n = Math.trunc(fr(fr(inputs[i]! / FULL) * (turns.length - 1)));
      d[i] = fr(signOf(n) * turns[Math.abs(n)]!);
    }
    if (controls.throttle !== 0) {
      const n = Math.trunc(fr(fr(controls.throttle / FULL) * (speeds.length - 1)));
      let target = fr(signOf(n) * speeds[Math.abs(n)]!);
      // (sic) (combat.cpp:619-623, so marked in ScummVM: a faster target is eased back, a slower one pushed on;
      // target -= target * dt and target += target * dt are fused)
      if (Math.abs(target) > Math.abs(ship.targetSpeed)) target = fma32(-target, dt, target);
      else target = fma32(target, dt, target);
      ship.targetSpeed = Math.max(target, MIN_REVERSE_SPEED);
      // ships turn more slowly at speed
      const s = scales[Math.abs(Math.trunc(fr(fr(controls.throttle / FULL) * (scales.length - 1))))]!;
      for (let i = 0; i < 3; i++) d[i] = fr(d[i]! * s);
    }
  } else {
    const maxScaleSpeed = speeds[speeds.length - 1]!;
    const s = Math.min(ship.speed, maxScaleSpeed);
    // (combat.cpp:633: ABS((int)(...) >> 1), the index halved, so only the table's first half is read; kept as ScummVM has it)
    let sc = scales[Math.abs(Math.trunc(fr(fr(s / maxScaleSpeed) * (scales.length - 1))) >> 1)]!;
    if (ship.radius < SMALL_RADIUS) sc = Math.min(fr(sc * SMALL_TURN), 1);
    for (let i = 0; i < 3; i++) d[i] = fr(inputs[i]! * sc);
  }
  for (let i = 0; i < 3; i++) ship.rates[i] = Math.trunc(d[i]!) | 0; // (C's (int) gives 0, never -0)

  // turn, within the ship's own frame (ship->orientation(), combat.cpp:111-113)
  if (ship.rates[0] || ship.rates[1] || ship.rates[2]) {
    const r = mul(fromAngles(ship.rates[0], ship.rates[1], ship.rates[2]), fromAngles(ship.angles[0], ship.angles[1], ship.angles[2]));
    const x = v3(r[0], r[1], r[2]);
    const z = v3(r[6], r[7], r[8]);
    ship.angles[0] = angleFromSinCos(z.x, z.z);
    // (sqrtf(z.x * z.x + z.z * z.z): fma(z.x, z.x, z.z * z.z))
    ship.angles[1] = angleFromSinCos(-z.y, sqrtf(fma32(z.x, z.x, fr(z.z * z.z))));
    const xs = apply(transpose(fromAngles(ship.angles[0], ship.angles[1], 0)), x);
    ship.angles[2] = angleFromSinCos(xs.y, xs.x);
  }

  // the speed follows the target, smoothly
  // (combat.cpp:654: (speed + history[0] + history[1] + 2.0f * targetSpeed) / 5.0f: fma(2, targetSpeed, ...), exact either way)
  let speed = fr(fma32(2, ship.targetSpeed, fr(fr(ship.speed + ship.history[0]) + ship.history[1])) / 5);
  ship.history[1] = ship.history[0];
  ship.history[0] = ship.speed;
  if (ship.targetSpeed >= 0) speed = Math.min(speed, ship.maxSpeed);
  else speed = Math.max(speed, -ship.maxSpeed);
  ship.speed = speed;

  // and on, along the ship's heading (Vector3's operators are functions: pos + forward * k is not fused)
  // (combat.cpp:664-666: angles * 2.0f * (float)M_PI / 16384.0f, unmasked; every writer of a ship's angles masks
  // them, so they are whole angles 0..0x3fff and their sinf and cosf are the table's)
  const [a0, a1] = ship.angles;
  const forward = v3(fr(sinAngle(a0) * cosAngle(a1)), fr(cosAngle(a0) * cosAngle(a1)), sinAngle(a1));
  ship.velocity = scale(forward, ship.speed);
  // (combat.cpp:668-672: the trail moves down one, newest first)
  ship.trail.pop();
  ship.trail.unshift({ pos: { ...ship.pos }, angles: [ship.angles[0], ship.angles[1], ship.angles[2]] });
  ship.pos = add(ship.pos, scale(forward, fr(ship.speed * dt)));
}
