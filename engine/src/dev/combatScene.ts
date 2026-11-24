// SPDX-License-Identifier: GPL-3.0-or-later
import { SHIP_FLAGS } from '../content/types';
import { fromInternal } from '../sim/combat/aim';
import { add, angleToRadians, type V3 } from '../sim/combat/math';
import { KIND, MAX_RANGE, type BattleState } from '../sim/combat/types';

export interface ScenePoint { x: number; y: number }
/** A ship as the debug view draws it: where (canvas pixels), which way (a unit vector on the canvas) and how. */
export interface SceneShip extends ScenePoint {
  index: number; hx: number; hy: number; colour: string; label: string; cloaked: boolean; destroyed: boolean; target: boolean;
}
/** A phaser beam: from its ship to where its tip is (weapons.cpp:378-380), or to the target until the tip is placed. */
export interface SceneBeam { from: ScenePoint; to: ScenePoint; miss: boolean }
export interface SceneTorpedo extends ScenePoint { enterprise: boolean }
/** A ring of `r` canvas pixels: an explosion, growing with its frame. */
export interface SceneRing extends ScenePoint { r: number }
/** A shield flash: the ship's radius around it, and where the hit landed (shieldImpact, damage.cpp:444). */
export interface SceneShield extends SceneRing { impact: ScenePoint }
/** A piece of debris, fading (Debris::alpha, damage.cpp:583-587): 1 opaque to 0 gone. */
export interface SceneDebris extends ScenePoint { alpha: number }
export interface CombatScene {
  /** Canvas pixels per battle unit. */
  scale: number;
  ships: SceneShip[];
  torpedoes: SceneTorpedo[];
  beams: SceneBeam[];
  explosions: SceneRing[];
  shields: SceneShield[];
  debris: SceneDebris[];
  /** The Enterprise's weapons range (kMaxRange) around it. */
  range: (ScenePoint & { r: number }) | null;
}

/** The least half-width the view shows, in battle units, so two ships close together don't fill it. */
export const MIN_HALF_WIDTH = 2000;
/** The least size of a shield's ring, in canvas pixels. */
const MIN_SHIELD = 6;
const isZero = (v: V3) => v.x === 0 && v.y === 0 && v.z === 0;

/**
 * The battle from above (spec §4.8): battle x to the right and y (forward) up the canvas; z, up, is left out. The view
 * fits every ship not yet removed, every torpedo in flight and every piece of debris, with a tenth to spare.
 */
export function combatScene(b: BattleState, width: number, height: number): CombatScene {
  const ships = b.ships.filter(s => !s.removed);
  const torpedoes = b.torpedoes.filter(t => t.active);
  const pieces = b.debris.flatMap(d => d.pieces.map(p => ({ debris: d, piece: p })));
  const points = [...ships.map(s => s.pos), ...torpedoes.map(t => t.pos), ...pieces.map(p => p.piece.pos)];
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const [minX, maxX] = xs.length ? [Math.min(...xs), Math.max(...xs)] : [0, 0];
  const [minY, maxY] = ys.length ? [Math.min(...ys), Math.max(...ys)] : [0, 0];
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const half = Math.max(MIN_HALF_WIDTH, (maxX - minX) / 2, (maxY - minY) / 2) * 1.1;
  const scale = Math.min(width, height) / (2 * half);
  const at = (p: ScenePoint): ScenePoint => ({ x: width / 2 + (p.x - cx) * scale, y: height / 2 - (p.y - cy) * scale });
  const beams: SceneBeam[] = [];
  for (const s of ships) {
    const target = s.target === null ? null : b.ships[s.target];
    if (!target) continue;
    for (const bank of s.banks) {
      if (!bank.active) continue;
      // (the tip is the end less the bank's start, in the model's axes; the start is drawn at the ship)
      const to = !isZero(bank.tip) ? add(s.pos, fromInternal(bank.tip)) : bank.miss ? add(target.pos, fromInternal(bank.missOffset)) : target.pos;
      beams.push({ from: at(s.pos), to: at(to), miss: bank.miss });
    }
  }
  const enterprise = b.ships[0];
  return {
    scale,
    ships: ships.map(s => {
      const yaw = angleToRadians(s.angles[0]);
      return {
        index: s.index, ...at(s.pos), hx: Math.sin(yaw), hy: -Math.cos(yaw),
        colour: s.destroyed ? '#666' : s.index === 0 ? '#6cf' : s.flags & SHIP_FLAGS.friendly ? '#6c6' : '#f66',
        label: String(s.index), cloaked: s.decloakTime !== 0, destroyed: s.destroyed, target: s.index === b.target,
      };
    }),
    torpedoes: torpedoes.map(t => ({ ...at(t.pos), enterprise: t.shooter !== null && b.ships[t.shooter]?.type === KIND.enterprise })),
    beams,
    explosions: [
      ...ships.filter(s => s.explosion.frames !== null).map(s => ({ ...at(s.pos), r: 6 + 2 * s.explosion.frame })),
      ...pieces.filter(p => p.piece.boom.frames !== null).map(p => ({ ...at(p.piece.pos), r: 3 + p.piece.boom.frame })),
    ],
    shields: ships.filter(s => s.shieldFlash.frames !== null).map(s => ({ ...at(s.pos), r: Math.max(MIN_SHIELD, s.radius * scale), impact: at(s.shieldImpact) })),
    debris: pieces.map(p => ({ ...at(p.piece.pos), alpha: p.debris.alpha < 0 ? 1 : 1 - p.debris.alpha / 0x4000 })),
    range: enterprise && !enterprise.removed ? { ...at(enterprise.pos), r: MAX_RANGE * scale } : null,
  };
}
