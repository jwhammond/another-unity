// SPDX-License-Identifier: GPL-3.0-or-later
import type { CombatData } from '../../content/types';
import type { BattleState, CombatShip } from '../../sim/combat/types';

/**
 * The Combat Options' preview (Plan 32 Task 11): the original's F1 screen sets a small 3D viewport, (399,128)-(547,269), and draws the
 * Enterprise there with the options chosen (tactical_hooks_ui.md §8). The remake draws it with a second SpaceScene, through the app's one
 * renderer (M8 Decision 4), from a battle of its own: the Enterprise alone, as the battle has it (its model, its damage), at the origin, turning
 * slowly before a still camera. Its stars, its detail and its resolution are the options'.
 */

/** The preview's window in the original's pixels: (399,128)-(547,269), inclusive. */
export const PREVIEW_RECT = { x: 399, y: 128, width: 149, height: 142 } as const;
/** One turn of the Enterprise in the preview, ms of the wall clock. */
export const PREVIEW_TURN_MS = 12000;
/** A full turn in the original's angles (16384: FIELD_OF_VIEW's units). */
const TURN = 16384;
/** The Enterprise's tilt toward the camera, so its top shows (the original's angle units). */
const PREVIEW_PITCH = -0x280;
/** How far the camera stands, in the Enterprise's sizes: it fills most of the window. */
const PREVIEW_DISTANCE = 1.5;

/**
 * The preview's battle, from the battle `b`: its Enterprise alone (no beams, shield flash, explosion or target), with no torpedoes or debris,
 * no enemy target, at the step's end (no interpolation), and the camera on the Enterprise's back looking along +z. Null without an Enterprise.
 * The returned battle is kept and turned (turnPreview), so the scene keeps its instances: a new battle object makes it forget them.
 */
export function previewBattle(b: Readonly<BattleState>, combat: CombatData): BattleState | null {
  const e = b.ships[0];
  if (!e) return null;
  const s = e.models.detail ? combat.models[e.models.detail]?.size : undefined;
  const size = s ? Math.max(s[0], s[1], s[2]) : e.radius;
  const ship: CombatShip = {
    ...e,
    pos: { x: 0, y: 0, z: 0 },
    angles: [0, PREVIEW_PITCH, 0],
    trail: [],
    banks: e.banks.map(bank => ({ ...bank, active: false })),
    shieldFlash: { ...e.shieldFlash, frames: null },
    explosion: { ...e.explosion, frames: null },
    decloakTime: 0,
    target: null,
    destroyed: false,
    removed: false,
  };
  const camera = { pos: { x: 0, y: 0, z: -PREVIEW_DISTANCE * Math.max(1, size) }, axes: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
  return {
    ...b,
    ships: [ship],
    target: null,
    torpedoes: [],
    debris: [],
    lastStep: b.now - 1e9,
    view: { ...b.view, camera, stepCamera: camera, viewFrame: 0 },
  } as BattleState;
}

/** Turns the preview's Enterprise to where it is at `wall` ms (one turn in PREVIEW_TURN_MS), or holds it still (reduced motion). */
export function turnPreview(b: BattleState, wall: number, still = false): void {
  const ship = b.ships[0];
  if (!ship) return;
  const yaw = still ? TURN / 8 : Math.trunc((((wall % PREVIEW_TURN_MS) + PREVIEW_TURN_MS) % PREVIEW_TURN_MS) / PREVIEW_TURN_MS * TURN);
  ship.angles = [yaw, PREVIEW_PITCH, 0];
}
