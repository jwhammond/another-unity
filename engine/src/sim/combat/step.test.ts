// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { SHIP_FLAGS } from '../../content/types';
import { miniBattle, miniBattleContext, miniCombat, recordingSeams } from '../../testing/combat';
import { CONDITION_TIME, orbit, ORBIT_DELAY, step, updateBattle, updateCondition } from './battle';
import { applyCommand } from './commands';
import { KIND, NO_EXIT, SHIP_STATE, type BattleContext, type BattleState } from './types';

/** Runs `steps` steps the way the screen does: update every 66 ms of battle time. */
function run(ctx: BattleContext, b: BattleState, steps: number): void {
  for (let i = 0; i < steps; i++) updateBattle(ctx, b, b.now + 66);
}

describe('updateBattle (Combat::update, combat.cpp:409-419)', () => {
  it('steps every 66 ms due, at the step times, and leaves the clock at now', () => {
    const { ctx, b } = miniBattle();
    updateBattle(ctx, b, 10065);
    expect([b.steps, b.lastStep, b.now]).toEqual([0, 10000, 10065]);
    updateBattle(ctx, b, 10066);
    expect([b.steps, b.lastStep]).toEqual([1, 10066]);
    updateBattle(ctx, b, 10066 + 3 * 66 + 10);
    expect([b.steps, b.lastStep, b.now]).toEqual([4, 10264, 10274]);
  });

  it('after a gap of more than a second, takes one step and does not catch up', () => {
    const { ctx, b } = miniBattle();
    const times: number[] = [];
    ctx.seams.updateCamera = (_c, s) => { times.push(s.now); };
    updateBattle(ctx, b, 11000);
    expect(b.steps).toBe(15);
    updateBattle(ctx, b, 16000);
    expect(b.steps).toBe(16);
    expect([b.lastStep, times.at(-1)]).toEqual([16000, 16000]);
  });

  it('plays the same however the frames fall, while no gap is over a second', () => {
    const a = miniBattle(), c = miniBattle();
    for (const x of [a, c]) applyCommand(x.ctx, x.b, { type: 'steer', yaw: 1, pitch: -1, roll: 0, throttle: 1 });
    for (let t = 10000; t <= 14000; t += 16) updateBattle(a.ctx, a.b, t);
    for (let t = 10000; t <= 14000; t += 250) updateBattle(c.ctx, c.b, t);
    updateBattle(c.ctx, c.b, 14000);
    expect(c.b).toEqual(a.b);
  });

  it('asks the sensors before each step, at the last step\'s time, while the radar shows (tactical.cpp:1111-1113; Plan 23 R10)', () => {
    const { ctx, b } = miniBattle();
    const e = b.ships[0]!;
    // (the sensor units at 25: a quality of 35, unreliable, so each check rolls, weapons.cpp:602)
    for (let i = 8; i <= 12; i++) e.systems.units[i]!.current = 25;
    applyCommand(ctx, b, { type: 'radar', open: false });
    updateBattle(ctx, b, 10066);
    expect([b.steps, b.console.sensorCheckTime, b.console.sensorQuality]).toEqual([1, 0, 100]);
    applyCommand(ctx, b, { type: 'radar', open: true });
    applyCommand(ctx, b, { type: 'wide', on: true });
    updateBattle(ctx, b, 10132);
    expect([b.steps, b.console.sensorCheckTime, b.console.sensorQuality]).toEqual([2, 0, 100]);
    applyCommand(ctx, b, { type: 'wide', on: false });
    // (a frame of three steps: the first asks at 10132, the last step's time; the next check is combatTicks(0xb5e) = 10000 on)
    updateBattle(ctx, b, 10330);
    expect([b.steps, b.console.sensorCheckTime, b.console.sensorQuality, b.console.sensorsDamaged]).toEqual([5, 20132, 35, true]);
  });

  it('keeps each asking step\'s answer for the radar\'s blips, and leaves it while the radar is hidden (tactical.cpp:1112-1113; Plan 27 R5)', () => {
    const { ctx, b } = miniBattle();
    const e = b.ships[0]!;
    expect(b.console.radarSeen).toBe(true);
    // (no sensors: a quality of 0, blank, so the radar shows nothing whatever the roll, weapons.cpp:589-602)
    for (let i = 8; i <= 12; i++) e.systems.units[i]!.current = 0;
    updateBattle(ctx, b, 10066);
    expect([b.steps, b.console.sensorQuality, b.console.radarSeen]).toEqual([1, 0, false]);
    // (wide, the steps don't ask: the answer stays the last one, though the sensors are back)
    for (let i = 8; i <= 12; i++) e.systems.units[i]!.current = e.systems.units[i]!.max;
    applyCommand(ctx, b, { type: 'wide', on: true });
    b.console.sensorCheckTime = 0;
    updateBattle(ctx, b, 10132);
    expect([b.steps, b.console.radarSeen]).toEqual([2, false]);
    applyCommand(ctx, b, { type: 'wide', on: false });
    updateBattle(ctx, b, 10198);
    expect([b.steps, b.console.sensorQuality, b.console.radarSeen]).toEqual([3, 100, true]);
  });

  it('asks no sensors once the Enterprise is lost, though the radar shows (tactical.cpp:1062-1063; Plan 23 R10)', () => {
    const { ctx, b } = miniBattle();
    const e = b.ships[0]!;
    for (let i = 8; i <= 12; i++) e.systems.units[i]!.current = 25;
    expect(b.console.radarShown).toBe(true);
    // (a step with the Enterprise alive: the sensors are unreliable, quality 35, and the check rolls)
    updateBattle(ctx, b, 10066);
    expect([b.steps, b.random.draws, b.console.sensorsReliable]).toEqual([1, 1, false]);
    e.destroyed = true;
    const [draws, checkTime] = [b.random.draws, b.console.sensorCheckTime];
    updateBattle(ctx, b, 10132);
    expect([b.steps, b.random.draws, b.console.sensorCheckTime]).toEqual([2, draws, checkTime]);
  });

  it('plays the same however the frames fall with the sensors rolling: the radar asks once a step, not once a frame (Plan 23 R10)', () => {
    const a = miniBattle(), c = miniBattle();
    for (const x of [a, c]) {
      for (let i = 8; i <= 12; i++) x.b.ships[0]!.systems.units[i]!.current = 25;
      applyCommand(x.ctx, x.b, { type: 'steer', yaw: 1, pitch: -1, roll: 0, throttle: 1 });
    }
    for (let t = 10000; t <= 14000; t += 16) updateBattle(a.ctx, a.b, t);
    for (let t = 10000; t <= 14000; t += 250) updateBattle(c.ctx, c.b, t);
    updateBattle(c.ctx, c.b, 14000);
    // (the battle's only draws are the sensors' rolls, one a step, however many frames there were)
    expect([a.b.steps, a.b.random.draws]).toEqual([60, 60]);
    expect(c.b).toEqual(a.b);
  });

  it('treats a clock gone back as ScummVM\'s uint32 does: a gap of more than a second, so one step (combat.cpp:411-412)', () => {
    const { ctx, b } = miniBattle();
    updateBattle(ctx, b, 9000);
    expect([b.steps, b.lastStep, b.now]).toEqual([1, 9000, 9000]);
  });
});

describe('step (Combat::step, combat.cpp:421-505)', () => {
  it('calls the seams in ScummVM\'s order for the player\'s Enterprise and an enemy', () => {
    const log: string[] = [];
    const { ctx, b } = miniBattle({ ctx: miniBattleContext(recordingSeams(log)) });
    log.length = 0;
    b.ships[0]!.target = null;
    step(ctx, b);
    expect(log).toEqual([
      'autoTarget:0', 'updateEffects:0',
      'runAI:1', 'avoidCollision:1', 'filterInputs:1', 'updateEffects:1',
      'updateTorpedoes', 'updateDebris', 'updateSelfDestruct', 'updateLamps', 'updateCamera',
    ]);
  });

  it('has the AI fly the Enterprise under Delegate once the kernel is ready, tactics fly it when engaged, and the starbase its own', () => {
    const log: string[] = [];
    const combat = miniCombat();
    combat.battles[3]!.ships[1]!.type = KIND.starbase;
    const { ctx, b } = miniBattle({ ctx: miniBattleContext(recordingSeams(log), combat) });
    Object.assign(b.console, { delegate: true, kernelReady: true });
    log.length = 0;
    step(ctx, b);
    expect(log.slice(0, 4)).toEqual(['runAI:0', 'avoidCollision:0', 'filterInputs:0', 'updateEffects:0']);
    expect(log).toContain('starbase:1');
    b.console.delegate = false;
    b.ships[0]!.engaged = true;
    b.ships[0]!.script = { file: 'mini.bin', data: new Uint8Array(0), pc: 0, idle: 0, kernel: 0, trace: 0, queues: [], depth: 0, buffer: false, returns: [] };
    b.ships[0]!.waypointActive = true;
    b.ships[0]!.freezeTime = b.now + 1000;
    log.length = 0;
    step(ctx, b);
    // (still frozen: no steering to the waypoint yet)
    expect(log.slice(0, 4)).toEqual(['runScript:0', 'avoidCollision:0', 'filterInputs:0', 'updateEffects:0']);
    b.ships[0]!.freezeTime = 0;
    log.length = 0;
    step(ctx, b);
    expect(log.slice(0, 4)).toEqual(['runScript:0', 'avoidCollision:0', 'steerTowards:0', 'filterInputs:0']);
  });

  it('steers only a live Enterprise, and flying it by hand on the step stops Delegate and a maneuver (combat.cpp:422-424, 519-525)', () => {
    const log: string[] = [];
    const { ctx, b } = miniBattle({ ctx: miniBattleContext(recordingSeams(log, { setDelegate: (_c, s, on) => { s.console.delegate = on; } })) });
    b.console.delegate = true;
    applyCommand(ctx, b, { type: 'steer', yaw: 1, pitch: 0, roll: 0, throttle: 0 });
    // (the command only holds the keys: nothing is cancelled until the step steers)
    expect(b.console.delegate).toBe(true);
    log.length = 0;
    step(ctx, b);
    expect(log.slice(0, 2)).toEqual(['engage', 'setDelegate']);
    expect(b.console.delegate).toBe(false);
    expect(b.cues.at(-1)).toEqual({ cue: 0xb, delay: 0, interrupt: false });
    expect(b.ships[0]!.controls.yaw).toBe(2.200000047683716);
    // a dying Enterprise isn't steered, nor a destroyed one
    b.ships[0]!.flags |= SHIP_STATE.dying;
    step(ctx, b);
    expect(b.ships[0]!.controls.yaw).toBe(2.200000047683716);
    b.ships[0]!.flags &= ~SHIP_STATE.dying;
    b.ships[0]!.destroyed = true;
    step(ctx, b);
    expect(b.ships[0]!.controls.yaw).toBe(2.200000047683716);
  });

  it('stops the step where the exit code is set', () => {
    const log: string[] = [];
    const { ctx, b } = miniBattle({ ctx: miniBattleContext(recordingSeams(log, { runAI: (_c, s) => { s.exitCode = 0xfe | 0x100; } })) });
    log.length = 0;
    step(ctx, b);
    expect(log).toEqual(['updateEffects:0', 'runAI:1']);
  });

  it('stops the step where updateEffects sets the exit code: no later ship and no step tail (combat.cpp:489-490)', () => {
    const log: string[] = [];
    const { ctx, b } = miniBattle({ ctx: miniBattleContext(recordingSeams(log, { updateEffects: (_c, s, ship) => { if (ship.index === 0) s.exitCode = 0xfe | 0x100; } })) });
    log.length = 0;
    step(ctx, b);
    expect(log.at(-1)).toBe('updateEffects:0');
    expect(log.some(l => l.endsWith(':1') || l === 'updateTorpedoes')).toBe(false);
  });

  it('stops the step where updateLamps sets the exit code: no orbit and no camera (combat.cpp:496-497)', () => {
    const log: string[] = [];
    const { ctx, b } = miniBattle({ ctx: miniBattleContext(recordingSeams(log, { updateLamps: (_c, s) => { s.exitCode = 0xfe | 0x100; } })) });
    // (setup calls updateLamps too, combat.cpp:271)
    b.exitCode = NO_EXIT;
    applyCommand(ctx, b, { type: 'orbit', direction: 1 });
    const frame = b.view.viewFrame;
    log.length = 0;
    step(ctx, b);
    expect(log.slice(-2)).toEqual(['updateSelfDestruct', 'updateLamps']);
    expect(log).not.toContain('updateCamera');
    expect([b.view.orbitAngle, b.view.viewFrame]).toEqual([0, frame]);
  });

  it('orbits at most once every 61 ms the same way, but at once the other way (combat.cpp:706-714)', () => {
    const { b } = miniBattle();
    expect(ORBIT_DELAY).toBe(61);
    orbit(b, 91);
    expect([b.view.orbitAngle, b.view.lastOrbit]).toEqual([91, 10000]);
    b.now = 10000 + 60;
    orbit(b, 91);
    expect([b.view.orbitAngle, b.view.lastOrbit]).toEqual([91, 10000]);
    orbit(b, -91);
    expect([b.view.orbitAngle, b.view.lastOrbit, b.view.lastOrbitStep]).toEqual([0, 10060, -91]);
    b.now = 10060 + 61;
    orbit(b, -91);
    expect(b.view.orbitAngle).toBe(16384 - 91);
  });

  it('decloaks a ship on time, with the cue only for a ship that can cloak', () => {
    const { ctx, b } = miniBattle();
    b.ships[1]!.decloakTime = 10132;
    run(ctx, b, 1);
    expect(b.ships[1]!.decloakTime).toBe(10132);
    run(ctx, b, 1);
    expect(b.ships[1]!.decloakTime).toBe(0);
    expect(b.cues.at(-1)!.cue).toBe(0x3f);
    b.ships[1]!.flags &= ~SHIP_FLAGS.canCloak;
    b.ships[1]!.decloakTime = b.now + 66;
    const before = b.cues.length;
    run(ctx, b, 1);
    expect(b.cues.length).toBe(before);
  });

  it('works out each ship\'s condition every 5 s from its shields, weapons, tractors and sensors (combat.cpp:756-787)', () => {
    const log: string[] = [];
    const { ctx, b } = miniBattle({ ctx: miniBattleContext(recordingSeams(log)) });
    const e = b.ships[0]!;
    // (shields 0-7 at half: (50 * 2 + 100 * 3 + 100 + 100 * 2) >> 3 = 87)
    for (let i = 0; i < 8; i++) e.systems.units[i]!.current = e.systems.units[i]!.target = 50;
    expect(CONDITION_TIME).toBe(5000);
    run(ctx, b, 75);
    expect(e.condition).toBe(100);
    run(ctx, b, 1);
    expect([e.condition, e.conditionTime]).toEqual([87, 10000 + 76 * 66 + 5000]);
    expect(log.filter(l => l.startsWith('enemySystemsCheck'))).toEqual(['enemySystemsCheck:0', 'enemySystemsCheck:1']);
    // (miniCombat's enemy template: shields 0-5 at half, weapons, the tractor and sensors full: (50 * 2 + 100 * 3 + 100 + 100 * 2) >> 3)
    for (let i = 0; i < 6; i++) b.ships[1]!.systems.units[i]!.current = 50;
    updateCondition(ctx, b, b.ships[1]!);
    expect(b.ships[1]!.condition).toBe(87);
  });

  it('blows up a ship whose time has come through destroy, and does not fly it that step', () => {
    const log: string[] = [];
    const { ctx, b } = miniBattle({ ctx: miniBattleContext(recordingSeams(log)) });
    b.ships[1]!.removeTime = 10066;
    log.length = 0;
    step(ctx, b);
    b.now = 10066;
    log.length = 0;
    step(ctx, b);
    expect(log.filter(l => l.endsWith(':1'))).toEqual(['destroy:1']);
    expect(b.ships[1]!.removeTime).toBe(0);
  });

  it('counts an enemy down to self-destruct in its log at 7, 5, 3 and 1 seconds, then blasts it', () => {
    const log: string[] = [];
    const { ctx, b } = miniBattle({ ctx: miniBattleContext(recordingSeams(log)) });
    const s = b.ships[1]!;
    s.selfDestructTime = 10000 + 8000;
    // (the lines come at steps 16, 46, 76 and 107, in the last 66 ms of each even second left)
    run(ctx, b, 121);
    expect(s.log).toEqual(['7 seconds until detonation', '5 seconds until detonation', '3 seconds until detonation', '1 seconds until detonation']);
    expect(log).not.toContain('destroy:1');
    run(ctx, b, 1);
    expect(log).toContain('destroy:1');
    expect(s.flags & SHIP_FLAGS.blast).toBe(SHIP_FLAGS.blast);
  });

  it('ticks every ship\'s systems on the battle clock: the Enterprise\'s grid fills after half a second', () => {
    const { ctx, b } = miniBattle();
    run(ctx, b, 8);
    expect(b.ships[0]!.systems.units[32]!.current).toBe(0);
    run(ctx, b, 1);
    expect(b.ships[0]!.systems.units[32]!.current).toBe(b.ships[0]!.systems.pool);
    expect(b.ships[0]!.systems.lastTick).toBe(b.now);
  });

  it('orbits the camera while an orbit key is held, at most every 61 ms', () => {
    const { ctx, b } = miniBattle();
    applyCommand(ctx, b, { type: 'orbit', direction: -1 });
    run(ctx, b, 2);
    expect([b.view.orbitAngle, b.view.view]).toEqual([182, 0xe]);
    applyCommand(ctx, b, { type: 'orbit', direction: 1 });
    run(ctx, b, 1);
    expect(b.view.orbitAngle).toBe(91);
  });
});

describe('a scripted battle (miniCombat battle 3, seed 1234, from 10 s)', () => {
  /** Yaw right and accelerate for 30 steps, let go for 30, then all stop for 30. */
  function scripted() {
    const { ctx, b } = miniBattle();
    const e = b.ships[0]!;
    const seen: Record<number, unknown> = {};
    const look = () => ({ yaw: e.controls.yaw, throttle: e.controls.throttle, stopping: e.controls.stopping, angles: [...e.angles], speed: e.speed, targetSpeed: e.targetSpeed, pos: { ...e.pos } });
    applyCommand(ctx, b, { type: 'steer', yaw: 1, pitch: 0, roll: 0, throttle: 1 });
    run(ctx, b, 1); seen[1] = look();
    run(ctx, b, 29); seen[30] = look();
    applyCommand(ctx, b, { type: 'steer', yaw: 0, pitch: 0, roll: 0, throttle: 0 });
    run(ctx, b, 30); seen[60] = look();
    applyCommand(ctx, b, { type: 'allStop' });
    run(ctx, b, 30); seen[90] = look();
    return { b, seen };
  }

  it('flies the Enterprise exactly so: the controls and speeds as the C reference (ScummVM\'s steer and fly), the turn and course as this port', () => {
    const { b, seen } = scripted();
    // (yaw, throttle, stopping, speed and target speed are bit for bit the C reference's at every point. The angles and
    // positions are this port's: with Apple's sinf, cosf and atan2f ScummVM turns 2279 by step 30 and 3016 by step 60, the
    // libm difference math.ts describes, which Plan 22's parity suite settles)
    expect(seen[1]).toEqual({ yaw: 2.200000047683716, throttle: 2.200000047683716, stopping: false, angles: [4, 0, 0], speed: 0, targetSpeed: 0, pos: { x: 0, y: 0, z: 0 } });
    expect(seen[30]).toEqual({ yaw: 66.00001525878906, throttle: 66.00001525878906, stopping: false, angles: [2281, 0, 0], speed: 264.2723693847656, targetSpeed: 291.875, pos: { x: 118.79879760742188, y: 206.6201934814453, z: 0 } });
    expect(seen[60]).toEqual({ yaw: 1.9781909443850054e-10, throttle: 66.00001525878906, stopping: false, angles: [3018, 0, 0], speed: 291.8570556640625, targetSpeed: 291.875, pos: { x: 633.4517822265625, y: 451.9241638183594, z: 0 } });
    expect(seen[90]).toEqual({ yaw: 0, throttle: 8.510406494140625, stopping: true, angles: [3018, 0, 0], speed: 51.13468933105469, targetSpeed: 39.974998474121094, pos: { x: 918.3802490234375, y: 576.9192504882812, z: 0 } });
    expect([b.steps, b.now, b.lastStep, b.exitCode]).toEqual([90, 15940, 15940, NO_EXIT]);
    expect(b.cues).toEqual([{ cue: 0xa, delay: 0, interrupt: false }]);
    // (the enemy, with no AI yet, sits still)
    expect(b.ships[1]!.pos).toEqual({ x: 1000, y: 0, z: 5000 });
    expect(b.random).toEqual({ state: 1234, draws: 0 });
  });

  it('is the same every time, and a copy taken midway goes on the same', () => {
    const one = scripted(), two = scripted();
    expect(two.b).toEqual(one.b);
    const { ctx, b } = miniBattle();
    applyCommand(ctx, b, { type: 'steer', yaw: -1, pitch: 1, roll: 1, throttle: 1 });
    run(ctx, b, 20);
    const copy = structuredClone(b);
    run(ctx, b, 20);
    run(ctx, copy, 20);
    expect(copy).toEqual(b);
  });
});
