// SPDX-License-Identifier: GPL-3.0-or-later
import { TICKS_PER_SECOND } from '../clock';
import type { SystemsState } from '../shipSystems';

/** kCombatStepTime (combat.h:43): the battle moves on in fixed steps of 66 ms. */
export const STEP_TIME = 66;
/** Combat::update (combat.cpp:411-412): a gap longer than this skips ahead to one step. */
export const MAX_GAP = 1000;

/** combatTicks (combat.h:41): the original's clock, 291 ticks a second, as milliseconds, in uint32 arithmetic. */
export function combatTicks(ticks: number): number {
  return Math.trunc((Math.imul(ticks >>> 0, 1000) >>> 0) / 291);
}

/**
 * The battle's clock is milliseconds, as ScummVM's; the sim's is ticks (TICKS_PER_SECOND). A battle starts at the
 * world's tick as milliseconds, and the Enterprise's persistent systems (spec §4.4) move between the two clocks
 * when it starts and ends. 0 stays 0 ("never ticked", "due now").
 *
 * The rule: the battle clock is relative to the world's at the battle's start and end, and carried times are
 * rebased. Retiming keeps each time's distance from the clock's now, not its absolute value, so a world tick that
 * did not move by the battle's length (a pause, fast-forward, auto-resolve, or the ship tick stopped for the battle)
 * leaves no time in the future. setupBattle rebases what the last battle left (carryOver) the same way when the
 * battle clock has gone back.
 */
export function shipTickToMs(tick: number): number {
  return tick === 0 ? 0 : Math.floor(tick * 1000 / TICKS_PER_SECOND);
}
export function msToShipTick(ms: number): number {
  return ms === 0 ? 0 : Math.ceil(ms * TICKS_PER_SECOND / 1000);
}
/** A span of ticks as ms, and back: floor then ceil, so a span goes there and back to itself, either sign. */
const ticksToMsSpan = (n: number) => Math.floor(n * 1000 / TICKS_PER_SECOND);
const msToTicksSpan = (n: number) => Math.ceil(n * TICKS_PER_SECOND / 1000);

/** The Enterprise's systems' times, from the ship's clock at `worldTick` to the battle's at `battleStart` (when a battle starts). */
export function systemsToBattleClock(s: SystemsState, worldTick: number, battleStart: number): void {
  retime(s, t => battleStart - ticksToMsSpan(worldTick - t));
}
/** And back, from the battle's clock at `battleNow` to the ship's at `worldTick` (Plan 22, when the battle ends). */
export function systemsToShipClock(s: SystemsState, battleNow: number, worldTick: number): void {
  retime(s, t => worldTick - msToTicksSpan(battleNow - t));
}
function retime(s: SystemsState, rebase: (t: number) => number): void {
  // (0 stays "never"; a time rebased to before the clock began is the earliest time there is, 1, not "never")
  const f = (t: number) => (t === 0 ? 0 : Math.max(1, rebase(t)));
  s.lastTick = f(s.lastTick);
  s.lastReactorTick = f(s.lastReactorTick);
  for (const u of s.units) {
    u.nextStep = f(u.nextStep);
    u.nextRepair = f(u.nextRepair);
  }
}
