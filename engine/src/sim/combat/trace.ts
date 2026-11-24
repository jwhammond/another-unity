// SPDX-License-Identifier: GPL-3.0-or-later
import type { BattleState, CombatShip } from './types';

/**
 * A battle's trace (docs/trace-format.md, "Space combat"): the events ScummVM's private trace writes for a battle and
 * the port's parity replay writes for the same battle, in one shape, so tools/tracediff compares them line for line.
 * Every number is as the original keeps it: floats are float32 values, times are the battle clock's milliseconds.
 */

/** A snapshot every this many steps, after the step (and at step 0, at a leave and at the run's end). */
export const SNAPSHOT_STEPS = 15;

export type Vec = [number, number, number];
/** A unit as a snapshot has it: current, target, max, damage, repair. */
export type UnitRow = [number, number, number, number, number];

export interface ShipSnap {
  index: number; pos: Vec; velocity: Vec; angles: Vec; speed: number; condition: number; flags: number;
  destroyed: boolean; removed: boolean; target: number; engaged: boolean; removeTime: number;
  units: UnitRow[]; pool: number; torpedoes: number;
}
export interface TorpedoSnap { slot: number; pos: Vec; angles: Vec; shooter: number; target: number; expiry: number }
/** The camera updateCamera placed (Combat::_camera, combat.h:434-438): its position and axes' rows (internal coordinates), and the view (M8 spec Decision 12). */
export interface CameraSnap { pos: Vec; axes: number[]; view: number }

/** The battle's events: those both engines write, compared in order (rolls, hails, stand-downs, leaves, inputs, the end) or by step (snapshots). */
export type CombatEvent =
  | { ev: 'roll'; step: number; site: string; n: number; value: number }
  | {
    ev: 'snap'; step: number; now: number; exit: number; target: number; redAlert: boolean; delegate: boolean; weaponsLock: boolean;
    shieldsRaised: boolean; powerLevel: number; kernelReady: boolean; random: number; camera: CameraSnap; ships: ShipSnap[]; torpedoes: TorpedoSnap[];
  }
  | { ev: 'hails'; step: number; site: string; type: number }
  | { ev: 'hailsEnd'; step: number; result: boolean; type: number; exit: number; redAlert: boolean; removeTimes: number[] }
  | { ev: 'standDown'; step: number; site: string }
  | { ev: 'leave'; step: number; code: number }
  | { ev: 'warp'; step: number; wait: number }
  | { ev: 'input'; step: number; line: string }
  | { ev: 'atan2'; step: number; site: string; s: number; c: number; angle: number; rounded: number }
  | { ev: 'combatEnd'; step: number; reason: 'leave' | 'won' | 'cap' };

const vec = (v: { x: number; y: number; z: number }): Vec => [v.x, v.y, v.z];
const shipIndex = (i: number | null): number => (i === null ? -1 : i);

function shipSnap(s: CombatShip): ShipSnap {
  return {
    index: s.index, pos: vec(s.pos), velocity: vec(s.velocity), angles: [...s.angles], speed: s.speed, condition: s.condition, flags: s.flags,
    destroyed: s.destroyed, removed: s.removed, target: shipIndex(s.target), engaged: s.engaged, removeTime: s.removeTime,
    units: s.systems.units.map((u): UnitRow => [u.current, u.target, u.max, u.damage, u.repair]),
    pool: s.systems.pool, torpedoes: s.systems.torpedoes,
  };
}

/** CombatTrace::snapshot (the export's combattrace.cpp): the battle at `step`, as ScummVM's trace writes it. */
export function snapshot(b: BattleState): Extract<CombatEvent, { ev: 'snap' }> {
  return {
    ev: 'snap', step: b.steps, now: b.now, exit: b.exitCode, target: shipIndex(b.target),
    redAlert: b.console.redAlert, delegate: b.console.delegate, weaponsLock: b.console.weaponsLock, shieldsRaised: b.console.shieldsRaised,
    powerLevel: b.console.powerLevel, kernelReady: b.console.kernelReady, random: b.random.state,
    camera: { pos: vec(b.view.camera.pos), axes: [...b.view.camera.axes], view: b.view.view },
    ships: b.ships.map(shipSnap),
    torpedoes: b.torpedoes.flatMap((t, slot) => (t.active
      ? [{ slot, pos: vec(t.pos), angles: [...t.angles] as Vec, shooter: shipIndex(t.shooter), target: shipIndex(t.target), expiry: t.expiry }]
      : [])),
  };
}
