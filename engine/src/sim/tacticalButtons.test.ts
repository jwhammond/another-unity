// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { battleWorld, CHODAK, rec } from '../testing/battle';
import { STEP_TIME } from './combat/time';
import { ASTROGATION_EXIT, retreat } from './combat/warp';
import { NO_SCENARIO } from './ship';
import { battleCommand, WARP_WAIT, type WorldBattle } from './tacticalScreen';

/** A seam called from outside a frame, as a test does: its journal entries dropped after. */
function outside<T>(run: WorldBattle, f: () => T): T {
  const value = f();
  run.journal.entries = [];
  run.journal.cursor = 0;
  return value;
}
/** A viewscreen hail from the chodak, raised by a script: a conversation (its talk string on the viewscreen). */
const talks = { communicate: { type: 7, from: CHODAK } };

describe('the console\'s Hail, Bridge and Engineering (TacticalScreen::hail and buttonAction, tactical.cpp:438-453, 503-521; Plan 23)', () => {
  it('hails the target: how the battle\'s going picks its USE group, each once; a conversation is an answer, anything else "no response" (0x5b)', async () => {
    const { world, enter, ticks, ran, events } = battleWorld({ use: [rec('use1'), rec('use2'), rec('use3'), rec('use4'), rec('use5', [talks])] });
    world.state.objects[CHODAK]!.talk = '-Zap-';
    await enter();
    const b = world.battle!.b;
    expect(b.target).toBe(1);
    battleCommand(world, { type: 'hail' });
    await ticks(1);
    // (an even fight is bucket 5, USE group 4: its hail is answered on the viewscreen)
    expect(ran.slice(1)).toEqual(['use5']);
    expect(events.some(e => e.type === 'viewscreen' && e.on)).toBe(true);
    const noAnswer = () => events.filter(e => e.type === 'battleAudio').flatMap(e => (e as { cues: { cue: number }[] }).cues.map(c => c.cue)).filter(c => c === 0x5b).length;
    expect(noAnswer()).toBe(0);
    battleCommand(world, { type: 'hail' });
    await ticks(1);
    // (the bucket's script has run: no answer)
    expect([ran.slice(1), noAnswer()]).toEqual([['use5'], 1]);
  });

  it('takes a hail they\'re making (8) as the conversation (7), and has no answer without a target', async () => {
    const { world, enter, ticks, events } = battleWorld();
    world.state.objects[CHODAK]!.talk = '-Zap-';
    await enter();
    world.state.pendingHail = { from: CHODAK, conversation: null, situation: 0, type: 8 };
    battleCommand(world, { type: 'hail' });
    await ticks(1);
    expect([world.state.pendingHail, events.filter(e => e.type === 'viewscreen').length]).toEqual([null, 2]);
    battleCommand(world, { type: 'target', ship: null });
    battleCommand(world, { type: 'hail' });
    await ticks(1);
    expect(events.filter(e => e.type === 'battleAudio').flatMap(e => (e as { cues: { cue: number }[] }).cues.map(c => c.cue))).toContain(0x5b);
  });

  it('is the hail at a red alert; without one Bridge leaves for the bridge after the frame\'s update, by the Exit object', async () => {
    const { world, enter, ticks, ship, ran } = battleWorld();
    await enter();
    const b = world.battle!.b;
    battleCommand(world, { type: 'bridge' });
    await ticks(1);
    expect([ship.station, b.target]).toEqual(['tactical', 1]);
    b.console.redAlert = false;
    const now = b.now;
    battleCommand(world, { type: 'bridge' });
    await ticks(2);
    // (the frame's update ran first, to the frame's clock: buttonAction is the update's last act)
    expect([b.now - now, ship.station, ship.combat, ran]).toEqual([17, 'bridge', null, ['b.enter', 'b.exit']]);
  });

  it('leaves the battle waiting at Engineering, and ends the game there once the Enterprise is destroyed', async () => {
    const one = battleWorld();
    await one.enter();
    battleCommand(one.world, { type: 'engineering' });
    await one.ticks(1);
    expect([one.ship.station, one.world.battle !== null]).toEqual(['engineering', true]);
    const two = battleWorld();
    await two.enter();
    two.world.battle!.b.ships[0]!.destroyed = true;
    battleCommand(two.world, { type: 'engineering' });
    await two.ticks(2);
    expect([two.world.state.onShip, two.world.battle]).toEqual([{ gameOver: 1 }, null]);
  });

  it('takes the button after the frame\'s stand-downs and red flash: Engineering in a frame whose target goes out of range', async () => {
    const { world, enter, ticks, ship } = battleWorld();
    await enter();
    const run = world.battle!;
    const b = run.b;
    expect([b.console.redAlert, ship.combat?.redAlert]).toEqual([true, true]);
    b.ships[1]!.pos = { x: 1e9, y: 0, z: 0 };
    b.console.redFlash = true;
    battleCommand(world, { type: 'engineering' });
    await ticks(2);
    // (buttonAction is the update's last act, tactical.cpp:489-494: the stand-down, the mirror and the flash came first)
    expect([ship.station, ship.battleScenario, ship.combat?.redAlert, run.redFlash, b.console.redFlash]).toEqual(['engineering', NO_SCENARIO, false, true, false]);
  });

  it('takes no button in a frame that leaves by its exit code (tactical.cpp:475-478)', async () => {
    const { world, enter, ticks, ship, events } = battleWorld();
    await enter();
    const b = world.battle!.b;
    b.exitCode = ASTROGATION_EXIT;
    battleCommand(world, { type: 'target', ship: null });
    battleCommand(world, { type: 'hail' });
    await ticks(2);
    // (the hail with no target would have cried "no response", 0x5b)
    const cues = events.filter(e => e.type === 'battleAudio').flatMap(e => (e as { cues: { cue: number }[] }).cues.map(c => c.cue));
    expect([ship.station, cues.includes(0x5b)]).toEqual(['astrogation', false]);
  });
});

describe('the AI\'s reach outside the battle (ai.cpp:246, 292-296; Plan 23)', () => {
  it('shows the warp overlay: the keys let go, the battle\'s clock on by its wait, held while it shows; the next update skips ahead (tactical.cpp:818-850)', async () => {
    const { world, enter, ticks, events } = battleWorld();
    await enter();
    const run = world.battle!;
    run.b.input.held = 5;
    const clock = run.clock;
    outside(run, () => run.ctx.seams.showWarp(run.ctx, run.b));
    expect([run.b.input.held, run.clock - clock, run.warpHold, events.at(-1)]).toEqual([0, WARP_WAIT, WARP_WAIT, { type: 'battleWarp', ms: 3000 }]);
    // (the overlay's 3000 ms, 179 ticks of 1000/60: no update, the clock where the jump left it)
    const steps = run.b.steps;
    await ticks(179);
    expect([run.b.steps, run.clock - clock, run.warpHold > 0]).toEqual([steps, WARP_WAIT, true]);
    // (the 180th ends it, and the update skips ahead to a step: combat.cpp:409-419)
    await ticks(1);
    expect([run.b.steps, run.warpHold]).toEqual([steps + 1, 0]);
  });

  it('drops the orders given while the warp overlay shows, as waitAndDraw drains the events unseen (unity.cpp:999-1009, tactical.cpp:840-846)', async () => {
    const { world, enter, ticks } = battleWorld();
    await enter();
    const run = world.battle!;
    outside(run, () => run.ctx.seams.showWarp(run.ctx, run.b));
    battleCommand(world, { type: 'steer', yaw: 1, pitch: 0, roll: 0, throttle: 1 });
    battleCommand(world, { type: 'fire', weapon: 'both' });
    expect(run.queue).toEqual([]);
    await ticks(180);
    expect([run.warpHold, run.b.input.held]).toEqual([0, 0]);
    // (once it has gone, orders are taken again)
    battleCommand(world, { type: 'allStop' });
    expect(run.queue).toEqual([{ type: 'allStop' }]);
  });

  it('drops a button pressed in the frame whose update warps away, as showWarp lets the pressed button go (tactical.cpp:846; Plan 27 R13)', async () => {
    const { world, enter, ticks, ship } = battleWorld();
    await enter();
    const run = world.battle!;
    const seams = run.ctx.seams;
    const lamps = seams.updateLamps;
    let warps = 0;
    // (the warp in the frame's first step, as warpAway's showWarp comes in the AI's turn)
    seams.updateLamps = (c, b) => {
      if (warps++ === 0) seams.showWarp(c, b);
      lamps(c, b);
    };
    // (a step due in the button's frame)
    run.b.lastStep -= STEP_TIME;
    battleCommand(world, { type: 'engineering' });
    await ticks(1);
    expect([warps, ship.station, run.warpHold > 0, run.queue]).toEqual([1, 'tactical', true, []]);
    await ticks(200);
    expect([ship.station, world.battle]).toEqual(['tactical', run]);
  });

  it('retreats to astrogation for the nearer starbase: the scripted warp asked of astrogation, the battle left without the Warp object', async () => {
    const { world, enter, ticks, ship, warnings, ran } = battleWorld();
    await enter();
    const run = world.battle!;
    const b = run.b;
    b.console.redAlert = false;
    for (const u of b.ships[0]!.systems.units) u.current = u.max;
    b.ships[0]!.systems.units[27]!.current = b.ships[0]!.systems.units[28]!.current = 1000;
    ship.pos = { x: 3, y: 90, z: 110 };
    outside(run, () => retreat(run.ctx, b, b.ships[0]!));
    // (the second starbase is nearer: code 1, which this made-up universe has no warp to)
    expect([b.exitCode, b.console.warped, warnings().at(-1)]).toEqual([ASTROGATION_EXIT, true, 'no scripted warp to 1']);
    await ticks(2);
    expect([ship.station, ship.combat, ran]).toEqual(['astrogation', null, ['b.enter']]);
  });
});
