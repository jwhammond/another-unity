// SPDX-License-Identifier: GPL-3.0-or-later
import type { SystemsState } from '../shipSystems';
import type { BattleState } from './types';

/**
 * A battle's state copied, and put back. In a live battle the Enterprise's systems are the world's own object
 * (createShip, combat.cpp:356; spec §4.4), which structuredClone copies like the rest: a copy's Enterprise no longer
 * writes the ship's systems. restoreBattle puts a copy's values back into the live objects, so the battle and the
 * world go on sharing one systems object (the game's journal re-runs a frame from its start: Plan 23 R7), and
 * cloneBattle links a clone to the systems it is given.
 */
export function copyBattle(b: BattleState): BattleState {
  return structuredClone(b);
}

/**
 * Puts `copy` (copyBattle's) back into `b`, in place: the Enterprise keeps its systems object, with the copy's values
 * in it. A key `b` has and the copy lacks (an optional field set since the copy) goes, so `b` is the copy's again.
 */
export function restoreBattle(b: BattleState, copy: BattleState): void {
  const systems = b.ships[0]?.systems;
  const fresh = structuredClone(copy);
  const live = b as unknown as Record<string, unknown>;
  for (const key of Object.keys(live)) if (!(key in fresh)) delete live[key];
  Object.assign(b, fresh);
  const enterprise = b.ships[0];
  if (systems && enterprise) {
    Object.assign(systems, enterprise.systems);
    enterprise.systems = systems;
  }
}

/** A clone of `b` whose Enterprise writes `systems` (a copy of the world's, say): structuredClone, linked again. */
export function cloneBattle(b: BattleState, systems: SystemsState): BattleState {
  const clone = structuredClone(b);
  if (clone.ships[0]) {
    Object.assign(systems, clone.ships[0].systems);
    clone.ships[0].systems = systems;
  }
  return clone;
}
