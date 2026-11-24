// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { battleOutcome, miniBattle, miniBattleContext, miniTacticsCombat } from '../../testing/combat';
import { SHIP_FLAGS } from '../../content/types';
// (through the barrel, as the game and the tools take them)
import { applyCommand, ASTROGATION_EXIT, GAME_OVER_EXIT, NO_SEAMS, SIM_SEAMS, STEP_TIME, updateBattle, type BattleContext, type BattleState } from './index';

/**
 * A whole battle fought by the AI and tactics (Plans 19-21): miniTacticsCombat's Enterprise under Delegate (on after
 * the first step, once its script's setup has made the kernel ready) against two chodaks running zapTactics, on
 * Ensign, so the enemies roll to fire (ai.cpp:367, 380). The pinned numbers are this port's own: no ScummVM trace
 * of a synthetic battle exists (Plan 22's parity suite compares the real battles with ScummVM's traces). A change to
 * any roll, its order, a decision or the maths moves them.
 */
const CAP = 3000;

function fight(): { ctx: BattleContext; b: BattleState; sites: Record<string, number>; warnings: string[] } {
  const combat = miniTacticsCombat();
  const ships = combat.battles[3]!.ships;
  ships[1] = { ...ships[1]!, position: [2000, 9000, 0] };
  ships[2] = { ...ships[1]!, object: 'space.zap2', position: [-3000, 12000, 500] };
  const sites: Record<string, number> = {};
  const warnings: string[] = [];
  const ctx: BattleContext = {
    ...miniBattleContext({ ...SIM_SEAMS }, combat),
    onDraw: site => { sites[site] = (sites[site] ?? 0) + 1; },
    onWarning: m => { warnings.push(m); },
  };
  const { b } = miniBattle({ ctx, difficulty: 0 });
  return { ctx, b, sites, warnings };
}
/** Steps from `from` until the battle is decided or `to`; Delegate goes on after the first step. Returns the steps taken. */
function play(ctx: BattleContext, b: BattleState, from: number, to: number): number {
  let step = from;
  for (; step < to && battleOutcome(b) === 'fighting'; step++) {
    if (step === 1) applyCommand(ctx, b, { type: 'delegate', on: true });
    updateBattle(ctx, b, b.lastStep + STEP_TIME);
    b.cues.length = 0;
    b.sounds.length = 0;
  }
  return step;
}

describe('a battle fought by the AI and tactics, Delegate against two chodaks', () => {
  it('fights in a context whose seams are NO_SEAMS and SIM_SEAMS, which stay frozen', () => {
    const { ctx } = fight();
    expect(ctx.seams).toEqual({ ...NO_SEAMS, ...SIM_SEAMS });
    expect([Object.isFrozen(NO_SEAMS), Object.isFrozen(SIM_SEAMS), Object.isFrozen(ctx.seams)]).toEqual([true, true, false]);
  });

  it('builds the Enterprise\'s maneuvers in its first step, all at once, and makes the kernel ready', () => {
    const { ctx, b } = fight();
    play(ctx, b, 0, 1);
    expect(b.console.menu.map(m => [m.label, m.buttons.map(button => button.label)])).toEqual([['-Menu-', ['-Close-', '-Weave-']]]);
    expect([b.console.kernelReady, b.console.scriptLock, b.console.engageLock, b.ships[0]!.engaged]).toEqual([true, false, false, true]);
    // (the chodaks run a token each script period: the IDLE, then the MESSAGE)
    expect(b.ships.slice(1).map(s => s.log)).toEqual([[], []]);
    play(ctx, b, 1, 2);
    expect([b.ships.slice(1).map(s => s.log), b.console.delegate]).toEqual([[['Zap ready'], ['Zap ready']], true]);
  });

  it('ends as it always has: both chodaks destroyed by step 425, by these rolls, with no warning', () => {
    const { ctx, b, sites, warnings } = fight();
    const steps = play(ctx, b, 0, CAP);
    const [e, one, two] = b.ships;
    expect([battleOutcome(b), steps, b.random.draws, e!.destroyed, one!.destroyed, two!.destroyed, b.console.delegate, warnings]).toEqual([
      'win', 425, 796, false, true, true, true, [],
    ]);
    expect([e!.condition, one!.condition, two!.condition]).toEqual([78, 167, 187]);
    expect(e!.log.slice(-3)).toEqual(['Shield S5 holding at 74.21', 'Shield S5 holding at 74.21', 'Unit -Unit 12- damaged by concussion.']);
    // (the AI's and tactics' rolls: the chodaks' rnd(3)s to fire, the kernel's and IDLE's random choices)
    expect([sites['ai.cpp:367'], sites['ai.cpp:380'], sites['tactics.cpp:490'], sites['tactics.cpp:715']]).toEqual([4, 2, 7, 4]);
    expect(Object.values(sites).reduce((n, k) => n + k, 0)).toBe(796);
  });

  it('tells each way out of a battle apart, whichever of its signs is set', () => {
    const { b } = fight();
    const outcome = (set: (c: BattleState) => void): string => { const c = structuredClone(b); set(c); return battleOutcome(c); };
    const friendly = (c: BattleState, i: number) => { c.ships[i]!.flags |= SHIP_FLAGS.friendly; };
    expect([
      outcome(() => {}),
      outcome(c => { c.ships[0]!.destroyed = true; }),
      outcome(c => { c.exitCode = GAME_OVER_EXIT; }),
      outcome(c => { c.console.warped = true; }),
      outcome(c => { c.exitCode = ASTROGATION_EXIT; }),
      outcome(c => { friendly(c, 1); friendly(c, 2); }),
      outcome(c => { c.ships[1]!.destroyed = true; friendly(c, 2); }),
      outcome(c => { c.ships[1]!.destroyed = true; }),
      outcome(c => { c.ships[1]!.destroyed = true; c.ships[2]!.destroyed = true; }),
      // (lost before fled: an Enterprise destroyed as it warps has lost)
      outcome(c => { c.ships[0]!.destroyed = true; c.console.warped = true; }),
    ]).toEqual(['fighting', 'loss', 'loss', 'flee', 'flee', 'peace', 'win', 'fighting', 'win', 'loss']);
  });

  it('reads a battle with no other ships as peace', () => {
    const { b } = fight();
    expect(battleOutcome({ ...b, ships: b.ships.slice(0, 1) })).toBe('peace');
  });

  it('is the same battle run twice, and a copy taken midway goes on as the original does', () => {
    const one = fight(), two = fight();
    play(one.ctx, one.b, 0, CAP);
    play(two.ctx, two.b, 0, 200);
    // (still fighting at the copy)
    expect(battleOutcome(two.b)).toBe('fighting');
    const copy = structuredClone(two.b);
    play(two.ctx, two.b, 200, CAP);
    play(two.ctx, copy, 200, CAP);
    expect(two.b).toEqual(one.b);
    expect(copy).toEqual(one.b);
  });
});
