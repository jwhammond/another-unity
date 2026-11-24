// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { RuleGroup } from '../content/types';
import { BATTLE, battleWorld, CHODAK, hail, rec } from '../testing/battle';
import { miniTacticsCombat } from '../testing/combat';
import { cloneBattle } from './combat/clone';
import { blowUpInTurn, BRIDGE_EXIT, standDown, tacticalUpdate } from './combat/tactical';
import { combatTicks } from './combat/time';
import { NO_EXIT, NO_HOOK, playCueAfter, SHIP_STATE, type BattleContext, type BattleState, type HookResult } from './combat/types';
import { NO_SCENARIO, STATION_CODE } from './ship';
import { gotoShipScreen } from './stations';
import { battleHails } from './tacticalScreen';

/** miniTacticsCombat's battle with the chodak 9000 ahead: Worf (Delegate) and the chodak's zapTactics fight it out. */
function tacticsCombat() {
  const combat = miniTacticsCombat();
  combat.battles[BATTLE]!.ships[1] = { ...combat.battles[BATTLE]!.ships[1]!, position: [2000, 9000, 0] };
  return combat;
}

/**
 * The battle a world is fighting, fought again beside it in the sim alone, with seams that answer every hook at once as
 * `answer` says (ScummVM's scripts run inside the step): what the world's battle must match, frame for frame (R7).
 */
function shadow(ctx: BattleContext, b: BattleState, answer: (kind: string, b: BattleState, ship: number, arg: number) => HookResult) {
  const ref = cloneBattle(b, structuredClone(b.ships[0]!.systems));
  const calls: string[] = [];
  /** The cues the shadow's frames played, in order (the world hands its on in battleAudio). */
  const heard: number[] = [];
  const hook = (kind: string) => (_c: BattleContext, bs: BattleState, ship: { index: number }, arg = 0): HookResult => {
    calls.push(`${kind} ${ship.index} ${arg}`);
    return answer(kind, bs, ship.index, arg);
  };
  const refCtx: BattleContext = {
    ...ctx,
    seams: {
      ...ctx.seams, deactivate: () => {},
      eventScript: hook('event'), hailScript: hook('hail'), hullLowScript: (c, bs, s) => hook('hullLow')(c, bs, s), destroyedScript: (c, bs, s) => hook('destroyed')(c, bs, s),
    },
  };
  /** The game's frame to `now`: the update (the radar's check in its steps) and what the world takes after it. */
  const frame = (now: number) => {
    const r = tacticalUpdate(refCtx, ref, now);
    heard.push(...ref.cues.map(c => c.cue));
    ref.cues.length = 0;
    ref.sounds.length = 0;
    ref.console.redFlash = false;
    return r;
  };
  return { ref, calls, heard, frame };
}

describe('the world\'s scripts in a battle (damage.cpp:656-732, tactical.cpp:377-436; Plan 23 R7)', () => {
  it('runs each hook\'s script once, where the step calls it, and fights on as a battle whose scripts ran inside the step does', async () => {
    const look: RuleGroup[] = Array.from({ length: 12 }, (_, i) => rec(`look${i}`));
    const { world, enter, ticks, ran } = battleWorld({ combat: tacticsCombat(), look, difficulty: 0 });
    await enter();
    const run = world.battle!;
    const { ref, calls, frame } = shadow(run.ctx, run.b, () => NO_HOOK);
    for (let i = 0; i < 900 && world.battle; i++) {
      await ticks(1);
      frame(run.clock);
    }
    expect(run.b).toEqual(ref);
    // (Worf's lock at the start ran the chodak's hook 0, before the Enter object; the rest ran in the steps)
    const inSteps = calls.filter(c => c.startsWith('event 1 ')).map(c => `look${c.split(' ')[2]}`);
    expect(inSteps.length).toBeGreaterThan(2);
    expect(ran).toEqual(['look0', 'b.enter', ...inSteps]);
  });

  it('takes what a script\'s processHails left at the point it ran: a hail of 0xd mid-step ends the battle for the bridge as it would have', async () => {
    const look: RuleGroup[] = Array.from({ length: 12 }, (_, i) => rec(`look${i}`, i === 3 ? [hail(0xd)] : []));
    const { world, enter, ticks, ship, ran } = battleWorld({ combat: tacticsCombat(), look, difficulty: 0 });
    await enter();
    const run = world.battle!;
    const b = run.b;
    const { ref, frame } = shadow(run.ctx, b, (kind, bs, _ship, arg) => {
      // (the chodak's first shot runs its hook 3, whose 0xd stands down and leaves for the bridge)
      if (kind === 'event' && arg === 3) { bs.console.redAlert = false; bs.exitCode = BRIDGE_EXIT; }
      return NO_HOOK;
    });
    let left = -1;
    for (let i = 0; i < 900 && world.battle; i++) {
      await ticks(1);
      const r = frame(run.clock);
      if (r.leave !== null && left < 0) left = ref.steps;
    }
    expect(left).toBeGreaterThan(0);
    expect([b.steps, b.exitCode, ship.station, ship.combat, world.battle, ran.includes('look3')]).toEqual([left, NO_EXIT, 'bridge', null, null, true]);
    // (the bridge's next tick uses the Exit object: endCombat's bridgeUse, tactical.cpp:357-359)
    await ticks(1);
    expect(ran.at(-1)).toBe('b.exit');
  });

  it('ends the battle where a script leaves tactical mid-step, without a leave: endCombat by the screen change, the step not run again (unity.cpp:284-286)', async () => {
    // (a script that changes the ship screen, as a conversation's can: the chodak's hook 3, run by its first shot)
    const look: RuleGroup[] = Array.from({ length: 12 }, (_, i) => rec(`look${i}`, i === 3 ? [{ call: { hook: 'toBridge', args: {} } }] : []));
    const { world, enter, ticks, ship, ran, warnings } = battleWorld({ combat: tacticsCombat(), look, difficulty: 0 });
    let at = -1;
    let left: BattleState | null = null;
    world.hooks.register('toBridge', async w => {
      at = w.battle!.b.steps;
      ran.push('toBridge');
      await gotoShipScreen(w, STATION_CODE.bridge);
      left = structuredClone(w.combatMemory.previous);
      return 0;
    });
    await enter();
    const run = world.battle!;
    for (let i = 0; i < 900 && world.battle === run; i++) await ticks(1);
    // (endCombat cleared the battle in the middle of its step, tactical.cpp:344-362: nothing is left to run, and no exit code)
    expect([at > 0, run.b.steps, run.b.exitCode]).toEqual([true, at, NO_EXIT]);
    expect(run.b).toEqual(left);
    expect([ship.station, ship.combat, world.battle, ship.battleScenario, world.combatMemory.previous === run.b]).toEqual(['bridge', null, null, NO_SCENARIO, true]);
    expect(ran.filter(n => n === 'look3' || n === 'toBridge')).toEqual(['look3', 'toBridge']);
    // (on the bridge, the Exit object: endCombat's bridgeUse, tactical.cpp:357-359)
    await ticks(1);
    expect([ran.at(-1), warnings()]).toEqual(['b.exit', []]);
  });

  it('pauses the battle for a viewscreen conversation a script raises mid-step; the step goes on after it, and the clock\'s gap is skipped (combat.cpp:409-419)', async () => {
    const look: RuleGroup[] = Array.from({ length: 12 }, (_, i) => rec(`look${i}`, i === 3 ? [{ communicate: { type: 7, from: CHODAK } }] : []));
    const { world, enter, ticks, events, ran } = battleWorld({ combat: tacticsCombat(), look, difficulty: 0 });
    world.state.objects[CHODAK]!.talk = '-Zap-';
    await enter();
    const run = world.battle!;
    let at = -1;
    for (let i = 0; i < 900 && at < 0; i++) {
      await ticks(1);
      if (ran.includes('look3')) at = run.b.steps;
    }
    // (the conversation ran inside the frame; the frame then went on to its end, at its own clock)
    expect(events.filter(e => e.type === 'viewscreen').map(e => (e as { on: boolean }).on)).toEqual([true, false]);
    expect([world.state.ship.station, world.state.pendingHail]).toEqual(['tactical', null]);
    const steps = run.b.steps;
    await ticks(1);
    // (the line took a second of the world's clock: the next update skips the gap, a step and no more)
    expect(run.b.steps).toBe(steps + 1);
  });

  it('runs processHails\' battle half: 0xd for the bridge, 8 the hailing cue, 0xb a stand-down, 0xf a red alert, 0x10 everyone blown up in turn', async () => {
    const { world, enter, run: task, ship } = battleWorld();
    await enter();
    const b = world.battle!.b;
    const raise = (type: number) => { world.state.pendingHail = { from: null, conversation: null, situation: 0, type }; };
    raise(8);
    await task(() => battleHails(world, b));
    expect([b.cues.map(c => c.cue), world.state.pendingHail?.type]).toEqual([[0x5a], 8]);
    raise(0xf);
    b.console.redAlert = false;
    await task(() => battleHails(world, b));
    expect([b.console.redAlert, world.state.pendingHail]).toEqual([true, null]);
    ship.battleScenario = BATTLE;
    raise(0xb);
    await task(() => battleHails(world, b));
    expect([b.console.redAlert, ship.battleScenario, b.exitCode]).toEqual([false, NO_SCENARIO, NO_EXIT]);
    raise(0x10);
    await task(() => battleHails(world, b));
    expect(b.ships.map(s => s.removeTime)).toEqual([b.now + combatTicks(3 * 0x5af), b.now + combatTicks(2 * 0x5af)]);
    raise(0xd);
    await task(() => battleHails(world, b));
    expect([b.exitCode, world.state.pendingHail]).toEqual([BRIDGE_EXIT, null]);
  });

  it('makes the start again after Worf\'s lock runs the target\'s hook 0 at an Ensign\'s start: once, with the systems shared and filled once', async () => {
    const { world, enter, ran, events, ship } = battleWorld({ difficulty: 0, look: [rec('look0', [hail(0xf)])] });
    await enter(8);
    const b = world.battle!.b;
    expect(ran).toEqual(['look0', 'b.enter']);
    expect(events.filter(e => e.type === 'rng').length).toBe(1);
    expect(b.ships[0]!.systems).toBe(ship.systems);
    // (battle 8 starts without a red alert; the hook's 0xf raised one, kept through the start made again)
    expect([b.console.redAlert, b.console.weaponsLock, b.console.powerLevel]).toEqual([true, true, 4]);
  });

  it('takes the Enterprise\'s systems as a script left them: a repair in Worf\'s hook 0 at the start mends a damaged unit', async () => {
    const { world, enter, ship } = battleWorld({ difficulty: 0, look: [rec('look0', [{ ship: { repair: true } }])] });
    ship.systems.units[3]!.damage = 40;
    await enter();
    expect([world.battle!.b.ships[0]!.systems, ship.systems.units[3]!.damage]).toEqual([ship.systems, 0]);
  });

  it('runs the hull-low script once a hit leaves the ship under its threshold, and at the end the kill list of a ship destroyed, once', async () => {
    const { world, enter, ticks, run: task, ran } = battleWorld({ combat: tacticsCombat(), difficulty: 0, stun: [rec('stun')], kill: [rec('kill')] });
    await enter();
    const b = world.battle!.b;
    // (any condition is under this threshold: the chodak's first hit runs the stun list, damage.cpp:701-714)
    b.ships[1]!.hullLowThreshold = 1000;
    for (let i = 0; i < 900 && world.battle; i++) await ticks(1);
    expect(ran.filter(n => n === 'stun')).toEqual(['stun']);
    expect([world.state.objects[CHODAK]!.stunned, world.state.phaser[CHODAK]!.stunned]).toEqual([true, true]);
    b.ships[1]!.destroyed = true;
    await task(() => gotoShipScreen(world, STATION_CODE.bridge));
    expect([ran.filter(n => n === 'kill'), world.state.objects[CHODAK]!.active, world.state.phaser[CHODAK]!.destroyed]).toEqual([['kill'], false, true]);
  });

  it('runs a destroyed ship\'s kill list once: in the step that removes it, not again at the end (damage.cpp:719, tactical.cpp:349-353)', async () => {
    // (the chodak's hook 3, run by its first shot, blows everyone up in turn: the chodak first, 2 * 0x5af on)
    const look: RuleGroup[] = Array.from({ length: 12 }, (_, i) => rec(`look${i}`, i === 3 ? [hail(0x10)] : []));
    const { world, enter, ticks, run: task, ran } = battleWorld({ combat: tacticsCombat(), look, difficulty: 0, kill: [rec('kill')] });
    await enter();
    const b = world.battle!.b;
    for (let i = 0; i < 3000 && world.battle && !b.ships[1]!.removed; i++) await ticks(1);
    expect([world.battle !== null, b.ships[1]!.removed, b.ships[1]!.destroyed, ran.filter(n => n === 'kill')]).toEqual([true, true, true, ['kill']]);
    // (endCombat runs the destroyed ships' hooks: the kill list has run, so phaser_data->destroyed stops it)
    await task(() => gotoShipScreen(world, STATION_CODE.bridge));
    expect([world.battle, ran.filter(n => n === 'kill')]).toEqual([null, ['kill']]);
  });

  /** Fights the world's battle beside its shadow until `done(ref)` or the world's battle ends; what both came to. */
  async function fightBeside(o: { look: RuleGroup[]; before?: (w: ReturnType<typeof battleWorld>) => void; answer: Parameters<typeof shadow>[2]; done: (ref: BattleState) => boolean }) {
    const bw = battleWorld({ combat: tacticsCombat(), look: o.look, difficulty: 0 });
    const { world, enter, ticks, events } = bw;
    world.state.objects[CHODAK]!.talk = '-Zap-';
    await enter();
    o.before?.(bw);
    const run = world.battle!;
    const from = events.length;
    const { ref, heard, frame } = shadow(run.ctx, run.b, o.answer);
    for (let i = 0; i < 3000; i++) {
      await ticks(1);
      if (world.battle !== run) break;
      frame(run.clock);
      if (o.done(ref)) break;
    }
    const played = events.slice(from).flatMap(e => e.type === 'battleAudio' ? e.cues.map(c => c.cue) : []);
    return { run, ref, heard, played, world };
  }

  it('replays the remove times a script\'s 0x10 set mid-step: the chodak blows up as in the shadow (HookEffect.removeTimes)', async () => {
    const look: RuleGroup[] = Array.from({ length: 12 }, (_, i) => rec(`look${i}`, i === 3 ? [hail(0x10)] : []));
    const { run, ref } = await fightBeside({
      look,
      answer: (kind, bs, ship, arg) => {
        if (kind === 'event' && ship === 1 && arg === 3) { standDown(bs); blowUpInTurn(bs, bs.now); }
        return NO_HOOK;
      },
      done: ref => ref.ships[1]!.destroyed,
    });
    expect(ref.ships[1]!.destroyed).toBe(true);
    expect(run.b).toEqual(ref);
  });

  it('replays the cues a script\'s processHails played mid-step: a hail of 8 is heard as in the shadow (HookEffect.cues)', async () => {
    // (8 stays pending: every later script's processHails plays the hailing cue again, tactical.cpp:406-408)
    const look: RuleGroup[] = Array.from({ length: 12 }, (_, i) => rec(`look${i}`, i === 3 ? [{ communicate: { type: 8, conversation: 'zap', situation: 0 } }] : []));
    // (a hail of 8 pends with its conversation: CommunicateBlock::execute, object.cpp:1849-1888)
    let hailing = false;
    const { run, ref, heard, played } = await fightBeside({
      look,
      answer: (kind, bs, ship, arg) => {
        if (kind === 'event' && ship === 1 && (arg === 3 || hailing)) { hailing = true; playCueAfter(bs, 0x5a); }
        return NO_HOOK;
      },
      done: ref => ref.steps >= 600,
    });
    expect(heard.filter(c => c === 0x5a).length).toBeGreaterThan(0);
    expect(played).toEqual(heard);
    expect(run.b).toEqual(ref);
  });

  it('holds the explosion back when the destroyed hook\'s 7 bails, the Enterprise dying (HookResult.hailPending, damage.cpp:472-477)', async () => {
    const look: RuleGroup[] = Array.from({ length: 12 }, (_, i) => rec(`look${i}`, i === 11 ? [{ communicate: { type: 7, from: CHODAK } }] : []));
    let pending = false;
    const { run, ref, world } = await fightBeside({
      look,
      // (the Enterprise dying, processHails' 7 bails, tactical.cpp:383-384; the chodak due to blow up a moment on)
      before: ({ world }) => {
        const b = world.battle!.b;
        b.ships[0]!.flags |= SHIP_STATE.dying;
        b.ships[1]!.removeTime = b.now + combatTicks(0x100);
      },
      answer: (kind, _bs, ship, arg) => {
        if (kind === 'event' && ship === 1 && arg === 11) pending = true;
        return kind === 'event' && pending ? { hailPending: true, answered: false } : NO_HOOK;
      },
      done: ref => ref.ships[1]!.destroyed,
    });
    expect([ref.ships[1]!.destroyed, world.state.pendingHail?.type]).toEqual([true, 7]);
    expect(run.b).toEqual(ref);
  });

  it('holds the explosion back for a 7 left pending though the ship has no hook 11 to run: processHails\' global, read after the hook (damage.cpp:472-474)', async () => {
    const look: RuleGroup[] = Array.from({ length: 11 }, (_, i) => rec(`look${i}`));
    const { run, ref, world } = await fightBeside({
      look,
      // (a 7 an earlier script left as it bailed, the Enterprise dying)
      before: ({ world }) => {
        const b = world.battle!.b;
        b.ships[0]!.flags |= SHIP_STATE.dying;
        b.ships[1]!.removeTime = b.now + combatTicks(0x100);
        world.state.pendingHail = { from: CHODAK, conversation: null, situation: 0, type: 7 };
      },
      answer: kind => kind === 'event' ? { hailPending: true, answered: false } : NO_HOOK,
      done: ref => ref.ships[1]!.destroyed,
    });
    expect([ref.ships[1]!.destroyed, world.state.pendingHail?.type]).toEqual([true, 7]);
    expect(run.b).toEqual(ref);
  });

  it('has the conversation a start-time hook 0 raises once, and starts the battle once: the return to tactical finds it starting (kept in spirit, tactical.cpp:289-290, 335, 391)', async () => {
    // (ScummVM's start() runs again as processHails comes back to tactical, and its hook 0 hails again, without end)
    const { world, enter, ticks, ran, events, ship } = battleWorld({ difficulty: 0, look: [rec('look0', [{ communicate: { type: 7, from: CHODAK } }])] });
    world.state.objects[CHODAK]!.talk = '-Zap-';
    await enter();
    expect([ran, events.filter(e => e.type === 'rng').length]).toEqual([['look0', 'b.enter'], 1]);
    expect(events.filter(e => e.type === 'viewscreen').map(e => (e as { on: boolean }).on)).toEqual([true, false]);
    expect(events.filter(e => e.type === 'combat').map(e => (e as { on: boolean }).on)).toEqual([true]);
    expect([ship.station, world.state.pendingHail, world.battle!.b.ships[1]!.hooksRun]).toEqual(['tactical', null, 1]);
    // (and fights on)
    await ticks(30);
    expect(world.battle!.b.steps).toBeGreaterThan(0);
  });
});
