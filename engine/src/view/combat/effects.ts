// SPDX-License-Identifier: GPL-3.0-or-later
import type { CombatData, CombatModel } from '../../content/types';
import { toInternal } from '../../sim/combat/aim';
import { add, apply, fr, fromAngles, sub, type M3, type V3 } from '../../sim/combat/math';
import { isEnterprise, type Animation, type BattleState, type CombatShip, type PhaserBank } from '../../sim/combat/types';
import type { CombatSpriteSheet } from './files';
import { shipPose } from './draw';

/**
 * What Combat::render draws besides the ships (combat.cpp:964-1003, 1058-1077), as pure functions of the battle's state
 * (M8 spec §3.2): the phaser beams, the shields where they are hit, the explosions, the torpedoes, the debris and its
 * booms. The scene (spaceScene.ts) draws the list; the rules are here, tested on their own.
 */

/** kShieldScale (weapons.cpp:63): a shield or an explosion is drawn at its model's size times the ship's mean size over this. */
export const SHIELD_SCALE = fr(412.667);

/**
 * The scale setupWeapons gives a ship's shield and billboard models (weapons.cpp:132-136): 1 for the Enterprise, else
 * the mean of its detailed model's size over kShieldScale, in float32 as ScummVM works it.
 */
export function effectScale(combat: CombatData, ship: Pick<CombatShip, 'type' | 'models'>): number {
  const model = ship.models.detail ? combat.models[ship.models.detail] : undefined;
  if (isEnterprise(ship) || !model) return 1;
  const [x, y, z] = model.size;
  return fr(fr(fr(fr(x + y) + z) / 3) / SHIELD_SCALE);
}

/**
 * How opaque a material of this alpha is (SpaceRenderer::drawPolygon and drawTriangle, space3d.cpp:390-395, 440-442):
 * from 0x4000 nothing is drawn; from 0x100 a pixel is alpha >> 8 sixty-fourths the background's; below, opaque.
 */
export function materialOpacity(alpha: number): number {
  if (alpha >= 0x4000) return 0;
  if (alpha >= 0x100) return 1 - (alpha >> 8) / 64;
  return 1;
}

/**
 * A bound on how far a model's vertices are from its origin, times `scale`: its box's centre's distance plus half the box's
 * diagonal (SpaceModel::_size and _centre, space3d.cpp:134-135, are the box's extent and middle: measured on every model).
 * drawModel's cull takes the largest extent (combat.cpp:1008), which bounds a ship's vertices but not a debris piece's,
 * whose vertices sit where they were on the ship (measured: 27 of the 85 models reach past it).
 */
export function modelRadius(model: Pick<CombatModel, 'size' | 'centre'>, scale = 1): number {
  const [sx, sy, sz] = model.size;
  const [cx, cy, cz] = model.centre;
  return (Math.hypot(cx, cy, cz) + Math.hypot(sx, sy, sz) / 2) * scale;
}

/**
 * Where a sprite's frame sits in its sheet (files.ts' CombatSpriteSheet: frames left to right, then rows), as a texture
 * transform for a material whose UVs run 0 to 1 down the picture (the space build's, glTF's way): the sheet's texture is
 * flipped as three loads it (flipY), so v runs up the sheet. A UV of 0 or 1 lands on the frame's edge texels' middles, as
 * drawPolygon maps u * (width - 1) (space3d.cpp:338-339), so no neighbour's texel bleeds in.
 */
export function frameUv(sheet: Pick<CombatSpriteSheet, 'frames' | 'columns' | 'cell'>, frame: number): { offset: [number, number]; repeat: [number, number] } {
  const [w, h] = sheet.cell;
  const columns = Math.max(1, sheet.columns);
  const rows = Math.ceil(sheet.frames / columns);
  const W = w * columns, H = h * rows;
  const f = Math.max(0, Math.min(sheet.frames - 1, frame));
  const col = f % columns, row = Math.floor(f / columns);
  return { offset: [(col * w + 0.5) / W, 1 - (row * h + 0.5) / H], repeat: [(w - 1) / W, -(h - 1) / H] };
}

/**
 * How a beam was aimed, from the sim's state (updateBeams, weapons.cpp:301-383), for the tests: `to`, the ship it fires at
 * (its ship's target); `kind`, a miss (the end 0.75 R beside the target, :286), a hit while the target's shield flashes
 * (the end on the shield's impact, R out, or the centre if the roll failed), or a hit (the centre); `stale`, the flash
 * began this step, when the end is the impact the last flash left ((0, 0, 0) for a ship's first: a quirk kept,
 * :370-371); `lag`, for a target later in the list, which moves after the shooter in a step (battle.ts' order), its
 * travel this step (internal), which the end lags it by, as ScummVM's does; null for one earlier. `at`, where the target
 * is drawn (internal), and `radius`, its CombatShip.radius: every end but a stale one is within that of it, and the lag.
 */
export interface BeamAim { to: number; kind: 'hit' | 'miss' | 'shield'; stale: boolean; lag: V3 | null; at: V3; radius: number }

/** What an effect is: Combat::drawEffects' beams, shields and explosions, render's torpedoes, debris pieces and their booms. */
export type EffectKind = 'beam' | 'shield' | 'explosion' | 'torpedo' | 'debris' | 'boom';

/** One model render draws this frame besides the ships, and how. */
export interface EffectDraw {
  kind: EffectKind;
  /** The same thing from frame to frame (a ship's bank, a torpedo's slot and launch, a piece): the scene keeps its instance by it. */
  key: string;
  /** CombatData.models' key. */
  model: string;
  /** Internal position and orientation (drawModel's pos and orientation); a billboard part ignores the orientation. */
  pos: V3;
  m: M3;
  /** The model's scale (SpaceModel::scale: the shield's and billboard's effectScale, a debris piece's Debris.scale). */
  scale: number;
  /** The sprite and frame drawn in place of the material texture named `texture` (drawModel's texture, textureName), or null for the material's own. */
  sprite: string | null;
  frame: number;
  texture: string | null;
  /** A beam's first vertex (internal, from `pos`), or null to keep the model's (PhaserBank.tip before the beam first reached anything). */
  tip: V3 | null;
  /** A debris piece's fade (Debris.alpha, -1 for the materials' own), else -1. */
  alpha: number;
  /** The ship it belongs to, or -1 for a torpedo. */
  ship: number;
  /** How a beam with a tip was aimed (BeamAim), else null: for the tests' check that it reaches what it fires at. */
  aim: BeamAim | null;
  /** A debris piece without materials of its own (the generic pieces'): the dying ship's detailed model, whose it takes (damage.cpp:486). */
  borrow: string | null;
}

/** The sprite an animation shows now (TextureAnimation::texture, combat.cpp:99-101): none when stopped. */
function shows(a: Animation): { sprite: string | null; frame: number } {
  return { sprite: a.frames, frame: a.frames === null ? 0 : a.frame };
}

const IDENTITY: M3 = fromAngles(0, 0, 0);

/**
 * Remembers where the torpedoes and debris pieces were at the step before, so the view can draw them between two steps
 * as it does the ships (M8 spec Decision 7). They have no trail: the scene keeps their last positions itself, by key.
 * A frame after more than one step has no step before to go from, so draws the step's own.
 */
export class StepMemory {
  private steps = -1;
  private before = new Map<string, V3>();
  private now = new Map<string, V3>();

  /** Called each frame before `at`: a new step makes this step's positions the step before's. */
  see(b: Pick<BattleState, 'steps'>): void {
    if (b.steps === this.steps) return;
    this.before = b.steps === this.steps + 1 ? this.now : new Map();
    this.now = new Map();
    this.steps = b.steps;
  }

  /** Where `key` is drawn: from its place at the step before towards `pos` (this step's), or `pos` if it wasn't there. */
  at(key: string, pos: V3, t: number): V3 {
    this.now.set(key, pos);
    const p = this.before.get(key);
    if (!p || t >= 1) return pos;
    return { x: p.x + (pos.x - p.x) * t, y: p.y + (pos.y - p.y) * t, z: p.z + (pos.z - p.z) * t };
  }
}

/** How a beam fires at `target` (BeamAim), from the sim's state after the step. */
function beamAim(b: BattleState, ship: CombatShip, bank: PhaserBank, target: CombatShip, t: number): BeamAim {
  const flash = target.shieldFlash;
  const shielded = !bank.miss && flash.frames !== null;
  const was = target.trail[0];
  return {
    to: target.index,
    kind: bank.miss ? 'miss' : shielded ? 'shield' : 'hit',
    // (flashShield started it this step (startAnimation's lastFrame, the step's now), and no step has placed its impact since)
    stale: shielded && flash.frame === 0 && flash.lastFrame === b.lastStep,
    lag: target.index > ship.index && was ? toInternal(sub(target.pos, was.pos)) : null,
    at: shipPose(target, t).pos,
    radius: target.radius,
  };
}

/**
 * Everything Combat::render draws but the ships, in its order (combat.cpp:968-1003): for each ship not removed, its
 * beams, its shield and its explosion (drawEffects, :1058-1077); then the torpedoes in flight; then each debris piece and
 * its boom. A ship's effects go where the ship is drawn (shipPose at `t`); torpedoes and pieces between their last two
 * steps (`memory`). A model the battle's data lacks is skipped, as drawEffects skips without materials.
 */
export function effectsOf(b: BattleState, combat: CombatData, t: number, memory: StepMemory): EffectDraw[] {
  const out: EffectDraw[] = [];
  const fx = combat.effects;
  memory.see(b);
  const base = { scale: 1, sprite: null, frame: 0, texture: null, tip: null, alpha: -1, aim: null, borrow: null } as const;
  b.ships.forEach((ship, i) => {
    if (ship.removed) return;
    const pose = shipPose(ship, t);
    // phaser beams: the bank's offset turned with the ship, the beam's first vertex on what it hits (combat.cpp:1060-1067)
    if (fx.phaser) {
      const target = ship.target === null ? undefined : b.ships[ship.target];
      ship.banks.forEach((bank, j) => {
        if (!bank.active) return;
        const pos = add(pose.pos, apply(pose.m, bank.offset));
        let tip = bank.tip.x === 0 && bank.tip.y === 0 && bank.tip.z === 0 ? null : bank.tip;
        // (the sim's tip runs from the bank where the step left it to the end on the target where the step found it; drawn
        // between steps, the end keeps its place on the target as drawn, from the bank as drawn. At the step, the sim's tip)
        if (tip && target && t < 1) {
          const now = shipPose(ship, 1);
          const start = add(now.pos, apply(now.m, bank.offset));
          const there = shipPose(target, t).pos, was = toInternal(target.pos);
          tip = { x: tip.x + (there.x - was.x) - (pos.x - start.x), y: tip.y + (there.y - was.y) - (pos.y - start.y), z: tip.z + (there.z - was.z) - (pos.z - start.z) };
        }
        out.push({ ...base, kind: 'beam', key: `beam:${i}:${j}`, model: fx.phaser!, pos, m: IDENTITY, ...shows(bank.beam), texture: 'phaser1.lbm', tip, ship: i, aim: tip && target ? beamAim(b, ship, bank, target, t) : null });
      });
    }
    // the shield, turned to whoever hit it (combat.cpp:1069-1072)
    const shield = fx.shields[ship.index] ?? null;
    if (ship.shieldFlash.frames !== null && shield) {
      out.push({ ...base, kind: 'shield', key: `shield:${i}`, model: shield, pos: pose.pos, m: fromAngles(ship.shieldAngles[0], ship.shieldAngles[1], 0), scale: effectScale(combat, ship), ...shows(ship.shieldFlash), texture: 'shield.lbm', ship: i });
    }
    // and explosions (combat.cpp:1074-1076)
    if (ship.explosion.frames !== null && fx.billboard) {
      out.push({ ...base, kind: 'explosion', key: `explosion:${i}`, model: fx.billboard, pos: pose.pos, m: IDENTITY, scale: effectScale(combat, ship), ...shows(ship.explosion), texture: 'boom.lbm', ship: i });
    }
  });
  // torpedoes: launched and not yet spent, in the shooter's photon frames (combat.cpp:978-987)
  if (fx.photon) {
    b.torpedoes.forEach((torpedo, i) => {
      if (!torpedo.active || torpedo.launchTime > b.now) return;
      const shooter = torpedo.shooter === null ? undefined : b.ships[torpedo.shooter];
      const sprite = shooter ? combat.kinds[shooter.type]?.effects.photonSprite ?? null : null;
      const frames = sprite === null ? 0 : combat.animations?.[sprite] ?? 0;
      const key = `torpedo:${i}:${torpedo.launchTime}`;
      out.push({
        ...base, kind: 'torpedo', key, model: fx.photon!, pos: memory.at(key, toInternal(torpedo.pos), t), m: IDENTITY,
        sprite: frames > 0 ? sprite : null, frame: frames > 0 ? torpedo.frame % frames : 0, texture: 'photon.lbm', ship: -1,
      });
    });
  }
  // and what's left of ships: each piece faded by its debris's alpha, and its boom (combat.cpp:990-1002)
  for (const debris of b.debris) {
    const ship = b.ships[debris.ship];
    if (!ship) continue;
    const materials = ship.models.detail !== null;
    debris.pieces.forEach((piece, j) => {
      const key = `debris:${debris.ship}:${j}`;
      const pos = memory.at(key, toInternal(piece.pos), t);
      if (piece.model && materials) {
        const borrow = combat.models[piece.model]?.materials === null ? ship.models.detail : null;
        out.push({ ...base, kind: 'debris', key, model: piece.model, pos, m: fromAngles(Math.trunc(piece.angles[0]), Math.trunc(piece.angles[1]), Math.trunc(piece.angles[2])), scale: debris.scale, alpha: debris.alpha, ship: debris.ship, borrow });
      }
      if (piece.boom.frames !== null && fx.billboard) {
        out.push({ ...base, kind: 'boom', key: `boom:${debris.ship}:${j}`, model: fx.billboard, pos, m: IDENTITY, scale: effectScale(combat, ship), ...shows(piece.boom), texture: 'boom.lbm', ship: debris.ship });
      }
    });
  }
  return out;
}

/** TacticalScreen::update's red flash (tactical.cpp:484-487): palette entry 0, space's background, set to (0x80, 0x40, 0x40). */
export const FLASH_COLOUR: readonly [number, number, number] = [0x80, 0x40, 0x40];
// (the flash's strength under prefers-reduced-motion is files.ts', which the main bundle's view host reads without this module)
export { REDUCED_FLASH } from './files';

/** Space's background in a red flash of `strength` (0 none, 1 the original's), as 0-1 sRGB values. */
export function flashColour(strength: number): [number, number, number] {
  return [FLASH_COLOUR[0] / 255 * strength, FLASH_COLOUR[1] / 255 * strength, FLASH_COLOUR[2] / 255 * strength];
}
