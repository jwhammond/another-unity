// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { TACTIC, TOKEN } from '../content/tactics';
import type { RuleGroup } from '../content/types';
import { BATTLE, battleWorld, rec } from '../testing/battle';
import { addTactics, miniTacticsCombat } from '../testing/combat';
import { assembleTactics, type TacticItem } from '../testing/tactics';
import { GAME_OVER_EXIT } from './combat/types';
import { STATION_CODE } from './ship';
import { gotoShipScreen } from './stations';
import { AUTO_RESOLVE_YIELD, autoResolve, battleCommand, finishResolved, pauseBattle } from './tacticalScreen';

/** miniTacticsCombat's battle with the chodak 9000 ahead, `strength` as strong (100 is the template's). */
function tacticsCombat(strength = 100) {
  const combat = miniTacticsCombat();
  combat.battles[BATTLE]!.ships[1] = { ...combat.battles[BATTLE]!.ships[1]!, position: [2000, 9000, 0], strength };
  return combat;
}

/**
 * tacticsCombat with a made-up Enterprise script that warps away (warpAway, ai.cpp:222-267) at its first chance, and
 * again each 0x369 ticks after: the chodak stays within range after the first, so the battle goes on.
 */
function warpCombat() {
  const combat = tacticsCombat();
  const page = (name: string): TacticItem[] => [{ cls: TOKEN.page, opcode: 0x1f, page: name, args: [{ label: name }] }, { label: name }];
  addTactics(combat, 'jump.bin', assembleTactics([
    ...page('MAIN'),
    { cls: TOKEN.when, opcode: TACTIC.delta, args: [0x369, 0] }, { cls: TOKEN.branch, opcode: TACTIC.goto, args: [TACTIC.goto, { label: 'JUMP' }, 0] },
    ...page('JUMP'),
    { cls: TOKEN.do, opcode: TACTIC.flush, args: [TACTIC.all] },
    { cls: TOKEN.do, opcode: TACTIC.warp, args: [1] },
    ...page('END'),
  ]).bin);
  combat.battles[BATTLE]!.ships[0]!.tactics = 'jump.bin';
  return combat;
}

/** A warpCombat battle entered, its Enterprise able to warp a short way (both warp engines at 200, the grid at 800 of 3000). */
async function warpBattle() {
  const w = battleWorld({ combat: warpCombat(), difficulty: 0 });
  await w.enter();
  const units = w.world.battle!.b.ships[0]!.systems.units;
  for (const i of [27, 28]) Object.assign(units[i]!, { current: 200, target: 200, max: 200 });
  Object.assign(units[32]!, { current: 800, target: 800 });
  return w;
}

describe('the assists in the world\'s battle (spec §5; Plan 23 R9)', () => {
  it('applies an order given while paused at the next step exactly as if given then: the battle goes as the same order given live', async () => {
    const fight = async (paused: boolean) => {
      const w = battleWorld({ combat: tacticsCombat(), difficulty: 0 });
      await w.enter();
      await w.ticks(40);
      if (paused) pauseBattle(w.world, true);
      battleCommand(w.world, { type: 'delegate', on: false });
      battleCommand(w.world, { type: 'steer', yaw: 1, pitch: 0, roll: 0, throttle: 1 });
      if (paused) {
        const b = structuredClone(w.world.battle!.b);
        await w.ticks(300);
        // (paused: the clock stands, nothing steps, the orders wait)
        expect(w.world.battle!.b).toEqual(b);
        expect(w.world.battle!.queue).toHaveLength(2);
        pauseBattle(w.world, false);
      }
      await w.ticks(400);
      return w.world.battle!.b;
    };
    const live = await fight(false);
    expect(live.steps).toBeGreaterThan(100);
    expect(await fight(true)).toEqual(live);
  });

  it('fast-forwards at 2, 4 or 8 times the battle time to each world tick', async () => {
    const steps: number[] = [];
    for (const speed of [2, 4, 8] as const) {
      const { world, enter, ticks } = battleWorld({ assists: { difficulty: 'game', speed } });
      await enter();
      const run = world.battle!;
      const clock = run.clock;
      await ticks(60);
      expect(run.clock - clock).toBe(1000 * speed);
      steps.push(run.b.steps);
    }
    // (61 ticks from the start, the Enter frame's included: 61 * 1000 / 60 * speed ms of battle, in steps of 66 ms:
    // 2033 ms is 30, 4066 ms is 61, 8133 ms is 123)
    expect(steps).toEqual([30, 61, 123]);
  });

  it('fights a Story battle at Ensign\'s difficulty, whatever the game\'s, with Story\'s changes in the battle\'s context', async () => {
    const { world, enter } = battleWorld({ difficulty: 2, assists: { difficulty: 'story', speed: 1 } });
    await enter();
    const run = world.battle!;
    expect([run.b.difficulty, run.b.console.delegate, run.ctx.assists?.difficulty, world.combatMemory.lastDifficulty]).toEqual([0, true, 'story', 0]);
  });

  it('auto-resolves a battle with Delegate on, nothing drawn, to its end: a real battle, lost here, the game\'s end once the player goes on', async () => {
    const { world, enter, ship } = battleWorld({ combat: tacticsCombat(10) });
    await enter();
    const result = await autoResolve(world);
    // (measured for Plan 23: the Enterprise is destroyed at step 2888 (its steps asking the sensors, R10), its log's last line says so)
    expect([result.outcome, result.leave, result.steps, result.log.at(-1)]).toEqual(['left', GAME_OVER_EXIT, 2888, 'SHIP DESTROYED']);
    expect([world.battle!.resolved, world.battle!.b.console.delegate, ship.station]).toEqual([result, true, 'tactical']);
    await finishResolved(world);
    expect([world.state.onShip, world.battle]).toEqual([{ gameOver: 1 }, null]);
  });

  it('ends one that stands down by the Bridge button, the battle\'s Exit object\'s USE on the bridge', async () => {
    const combat = tacticsCombat();
    combat.battles[BATTLE]!.ships[1]!.position = [0, 300000, 0];
    const { world, enter, ticks, ship, ran } = battleWorld({ combat, kill: [rec('kill')] });
    await enter();
    const result = await autoResolve(world);
    expect([result.outcome, result.leave, result.steps]).toEqual(['stoodDown', null, 1]);
    await finishResolved(world);
    await ticks(1);
    expect([ship.station, ship.combat, ran]).toEqual(['bridge', null, ['b.enter', 'b.exit']]);
  });

  it('hands a battle still undecided at the cap back, Delegate on, its clock going on from where the battle is', async () => {
    const { world, enter, ticks } = battleWorld({ combat: tacticsCombat() });
    await enter();
    const result = await autoResolve(world, 50);
    const run = world.battle!;
    expect([result.outcome, result.steps, run.resolved, run.b.console.delegate, run.clock]).toEqual(['undecided', 50, null, true, run.b.now]);
    await ticks(60);
    expect(run.b.steps).toBe(65);
  });

  it('credits the ticks since the last frame when it pauses: a busy world\'s ticks are the battle\'s, then the clock stands', async () => {
    const { world, enter, ticks } = battleWorld();
    await enter();
    const run = world.battle!;
    const clock = run.clock;
    let release = () => {};
    const busy = world.enqueue(() => new Promise<void>(resolve => { release = resolve; }));
    await new Promise(resolve => setTimeout(resolve, 0));
    // (the world busy: its ticks run no frame)
    for (let i = 0; i < 30; i++) world.tick();
    expect(run.clock).toBe(clock);
    pauseBattle(world, true);
    // (30 ticks of 1000/60 ms)
    expect(run.clock - clock).toBe(500);
    release();
    await busy;
    await ticks(30);
    expect(run.clock - clock).toBe(500);
  });

  it('keeps showWarp\'s jump in an auto-resolved battle: a warp that leaves the chodak in range goes as the same battle fought live by Delegate', async () => {
    const auto = await warpBattle();
    const result = await autoResolve(auto.world, 40);
    const warps = (w: typeof auto) => w.events.filter(e => e.type === 'battleWarp').length;
    expect([result.outcome, warps(auto), auto.world.battle!.b.console.warped]).toEqual(['undecided', 1, true]);
    // (handed back undecided with no overlay waiting: nothing was drawn, so none shows)
    expect(auto.world.battle!.warpHold).toBe(0);
    // (live, Delegate on, a frame at each step's time: 66 ms of battle a tick, the clock from the last step, as auto-resolve's)
    const live = await warpBattle();
    const run = live.world.battle!;
    battleCommand(live.world, { type: 'delegate', on: true });
    run.clock = run.b.lastStep;
    while (run.b.steps < 40) {
      // (a warp's overlay ends in the frame the step after it is due: its time and the step's, as auto-resolve has no overlay)
      run.owed = (66 + run.warpHold) * 60 - 1000;
      await live.ticks(1);
    }
    expect(warps(live)).toBe(1);
    expect(run.b).toEqual(auto.world.battle!.b);
    expect(run.clock).toBe(auto.world.battle!.clock);
  });

  it('is silent and hands the host a turn every AUTO_RESOLVE_YIELD steps (M8 spec §6.3)', async () => {
    const { world, enter, events } = battleWorld({ combat: tacticsCombat(10) });
    await enter();
    // (the steps that cue a sound, as each step leaves the battle)
    let cued = 0;
    world.battle!.ctx.onStep = b => { if (b.cues.length > 0 || b.sounds.length > 0) cued++; };
    let yields = 0;
    world.yieldToHost = async () => { yields++; };
    const before = events.length;
    const result = await autoResolve(world);
    expect(result.steps).toBe(2888);
    // (a turn before steps 201, 401, ... 2801)
    expect([AUTO_RESOLVE_YIELD, yields]).toEqual([200, 14]);
    expect(cued).toBeGreaterThan(0);
    expect(events.slice(before).filter(e => e.type === 'battleAudio')).toEqual([]);
    expect([world.battle!.b.cues, world.battle!.b.sounds]).toEqual([[], []]);
  });

  it('reports a battle a script ended in the middle of a step as ended: nothing waits, and going on does nothing', async () => {
    const look: RuleGroup[] = Array.from({ length: 12 }, (_, i) => rec(`look${i}`, i === 3 ? [{ call: { hook: 'toBridge', args: {} } }] : []));
    const { world, enter, ship, ran } = battleWorld({ combat: tacticsCombat(), look, difficulty: 0 });
    world.hooks.register('toBridge', async w => {
      await gotoShipScreen(w, STATION_CODE.bridge);
      return 0;
    });
    await enter();
    const run = world.battle!;
    const result = await autoResolve(world);
    expect([result.outcome, result.leave, result.steps, run.resolved]).toEqual(['ended', null, run.b.steps, null]);
    expect([world.battle, ship.station, ran.includes('look3')]).toEqual([null, 'bridge', true]);
    await finishResolved(world);
    expect([world.battle, ship.station]).toEqual([null, 'bridge']);
  });
});
