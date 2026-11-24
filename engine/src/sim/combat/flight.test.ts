// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { miniBattle, miniBattleContext, recordingSeams } from '../../testing/combat';
import { CONTROL_RAMP, FLIGHT, fly, STEP_SECONDS, steer, stop, updateMaxSpeed } from './flight';
import { fr, v3 } from './math';
import type { BattleContext, BattleState, CombatShip } from './types';

const bit = (n: number) => 1 << n;
/** Steps the controls alone, as step does: the battle clock moves 66 ms, then steer. */
function steerFor(ctx: BattleContext, b: BattleState, steps: number): void {
  for (let i = 0; i < steps; i++) {
    b.now += 66;
    steer(ctx, b);
  }
}
/** The Enterprise at rest at the origin, heading 0, top speed 300. */
function atRest(b: BattleState): CombatShip {
  const ship = b.ships[0]!;
  Object.assign(ship, { pos: v3(), angles: [0, 0, 0], speed: 0, history: [0, 0], targetSpeed: 0, maxSpeed: 300 });
  ship.controls = { yaw: 0, pitch: 0, roll: 0, throttle: 0, stopping: false };
  return ship;
}

describe('steer (combat.cpp:515-562)', () => {
  it('ramps a held control by 100 * 0.066 / 3 a step, to full in about 3 s, and stops at 100', () => {
    const { ctx, b } = miniBattle();
    expect(STEP_SECONDS).toBe(fr(0.066));
    expect(CONTROL_RAMP).toBe(2.200000047683716);
    b.input.held = bit(FLIGHT.yawRight) | bit(FLIGHT.accelerate) | bit(FLIGHT.pitchDown);
    steerFor(ctx, b, 30);
    const c = b.ships[0]!.controls;
    // (the C reference, from combat.cpp's steer: 66.00001525878906)
    expect([c.yaw, c.throttle, c.pitch]).toEqual([66.00001525878906, 66.00001525878906, -66.00001525878906]);
    steerFor(ctx, b, 20);
    expect([c.yaw, c.throttle, c.pitch]).toEqual([100, 100, -100]);
  });

  it('recentres a let-go control by value * time since release / 2 s each step, to 0 after 2 s; the throttle stays', () => {
    const { ctx, b } = miniBattle();
    b.input.held = bit(FLIGHT.yawRight) | bit(FLIGHT.accelerate);
    steerFor(ctx, b, 30);
    b.input.held = 0;
    steerFor(ctx, b, 30);
    const c = b.ships[0]!.controls;
    // (the C reference after 30 steps let go, 1980 ms: 1.9781909443850054e-10)
    expect(c.yaw).toBe(1.9781909443850054e-10);
    expect(c.throttle).toBe(66.00001525878906);
    expect(b.input.releaseStart[2]).toBe(10000 + 31 * 66);
    // (1980 ms let go: still not quite 0; 2046 ms: 0)
    steerFor(ctx, b, 1);
    expect(c.yaw).toBeGreaterThan(0);
    steerFor(ctx, b, 1);
    expect(c.yaw).toBe(0);
  });

  it('stops a maneuver and Delegate when the player flies by hand (combat.cpp:519-525), with the cue', () => {
    const log: string[] = [];
    const ctx = miniBattleContext(recordingSeams(log));
    const { b } = miniBattle({ ctx });
    log.length = 0;
    b.console.delegate = true;
    b.input.held = bit(FLIGHT.rollLeft);
    steer(ctx, b);
    expect(log).toEqual(['engage', 'setDelegate']);
    expect(b.cues.at(-1)).toEqual({ cue: 0xb, delay: 0, interrupt: false });
    // (the camera keys are not flight keys)
    log.length = 0;
    b.input.held = bit(FLIGHT.orbitLeft);
    steer(ctx, b);
    expect(log).toEqual([]);
  });
});

describe('all stop (combat.cpp:507-513)', () => {
  it('centres the turns at once and lets the throttle run down in fly, until it is under 0.5', () => {
    const { ctx, b } = miniBattle();
    const ship = atRest(b);
    ship.controls = { yaw: 40, pitch: 10, roll: -5, throttle: 1, stopping: false };
    stop(b);
    expect(ship.controls).toEqual({ yaw: 0, pitch: 0, roll: 0, throttle: 1, stopping: true });
    // (6.6% a step: 0.934^10 is 0.505, so the 11th step stops it)
    let steps = 0;
    for (; steps < 20 && ship.controls.stopping; steps++) fly(ctx, ship, false);
    expect(steps).toBe(11);
    expect(ship.controls.throttle).toBe(0);
    expect(ship.controls.stopping).toBe(false);
  });
});

describe('updateMaxSpeed (combat.cpp:564-593)', () => {
  it('gives the Enterprise its full speed with its impulse engines and reactors whole', () => {
    const { b } = miniBattle();
    updateMaxSpeed(b.ships[0]!);
    expect(b.ships[0]!.maxSpeed).toBe(300);
  });

  it('slows the Enterprise with its reactors off (78%) or half a port impulse engine (30%), as the C reference works it', () => {
    const { b } = miniBattle();
    const e = b.ships[0]!;
    e.systems.units[33]!.current = e.systems.units[34]!.current = 0;
    updateMaxSpeed(e);
    expect(e.maxSpeed).toBe(234.00001525878906);
    e.systems.units[33]!.current = e.systems.units[34]!.current = 100;
    e.systems.units[29]!.current = 50;
    e.systems.units[30]!.current = e.systems.units[31]!.current = 0;
    updateMaxSpeed(e);
    expect(e.maxSpeed).toBe(90);
  });

  it('gives another ship 15% while its engines (15-16) work and its units 18-19 do not, and scales in between', () => {
    const { b } = miniBattle();
    const ship = b.ships[1]!;
    ship.systems.units[18]!.current = ship.systems.units[19]!.current = 0;
    updateMaxSpeed(ship);
    expect(ship.maxSpeed).toBe(45);
    ship.systems.units[18]!.current = 100;
    ship.systems.units[16]!.current = 40;
    ship.systems.units[19]!.current = 50;
    updateMaxSpeed(ship);
    expect(ship.maxSpeed).toBe(154.35000610351562);
    ship.systems.units[15]!.current = ship.systems.units[16]!.current = 0;
    updateMaxSpeed(ship);
    expect(ship.maxSpeed).toBe(0);
  });
});

describe('fly (combat.cpp:595-674)', () => {
  it('by hand at full throttle from rest: the target eases back from the top speed (sic), the speed a fifth of the way there', () => {
    const { ctx, b } = miniBattle();
    const ship = atRest(b);
    ship.controls.throttle = 100;
    fly(ctx, ship, false);
    // (the C reference: speeds[39] = 487.5, less 487.5 * 0.066; then (0 + 0 + 0 + 2 * target) / 5, at most 300)
    expect([ship.targetSpeed, ship.speed]).toEqual([455.32501220703125, 182.1300048828125]);
    expect(ship.pos).toEqual({ x: 0, y: 12.020580291748047, z: 0 });
    expect(ship.velocity).toEqual({ x: 0, y: 182.1300048828125, z: 0 });
    expect(ship.history).toEqual([0, 0]);
    expect(ship.trail[0]).toEqual({ pos: { x: 0, y: 0, z: 0 }, angles: [0, 0, 0] });
  });

  it('by hand, turns by the table in the ship\'s own frame: yaw 50, pitch -25, roll 10 (the C reference)', () => {
    const { ctx, b } = miniBattle();
    const ship = atRest(b);
    Object.assign(ship.controls, { yaw: 50, pitch: -25, roll: 10 });
    fly(ctx, ship, false);
    expect(ship.rates).toEqual([164, -80, 32]);
    expect(ship.angles).toEqual([164, 16305, 31]);
  });

  it('flown by the AI, takes its inputs as rates, scaled by speed (the table index halved, combat.cpp:633), and turns a unit short', () => {
    const { ctx, b } = miniBattle();
    const ship = atRest(b);
    Object.assign(ship, { speed: 250, radius: 200 });
    ship.controls.yaw = 30;
    fly(ctx, ship, true);
    // (index (int)(250 / 487.5 * 23) >> 1 = 5: 1 - 5/32, times 1.25 for a small ship, at most 1; the turn of 30 comes out 29)
    expect(ship.rates).toEqual([30, 0, 0]);
    expect(ship.angles).toEqual([29, 0, 0]);
    expect(ship.speed).toBe(50);
  });

  it('keeps reverse to -500 and the speed within the top speed either way', () => {
    const { ctx, b } = miniBattle();
    // (a full-astern speed past -500 even after the (sic) easing: -600 eased back is -560.4, held at -500)
    ctx.combat.flight.speeds[39] = 600;
    const ship = atRest(b);
    ship.controls.throttle = -100;
    for (let i = 0; i < 40; i++) fly(ctx, ship, false);
    expect(ship.targetSpeed).toBe(-500);
    expect(ship.speed).toBe(-300);
  });
});
