// SPDX-License-Identifier: GPL-3.0-or-later
import { roll } from './effects';
import { isEnterprise, type BattleContext, type BattleState, type CombatShip } from './types';

/**
 * The assists (spec §5): one object the player keeps with the settings, which the sim reads. With the defaults a
 * battle is the original, bit for bit (Decision 1). Only Story changes a battle's numbers; the rest change how its
 * time runs (pause, fast-forward, auto-resolve: the game's driver, tacticalScreen.ts) and modern controls are M8's.
 */

/** The combat difficulty: as the game's (the original's way), one of the original's levels apart from it, or Story. */
export const COMBAT_DIFFICULTIES = ['game', 'ensign', 'lieutenant', 'captain', 'story'] as const;
export type CombatDifficulty = (typeof COMBAT_DIFFICULTIES)[number];
/** Fast-forward: battle time to each of the world's, 1 to 8 (spec §5). */
export const BATTLE_SPEEDS = [1, 2, 4, 8] as const;
export type BattleSpeed = (typeof BATTLE_SPEEDS)[number];

export interface CombatAssists { difficulty: CombatDifficulty; speed: BattleSpeed }
/** Everything off: the original. */
export const ORIGINAL_ASSISTS: Readonly<CombatAssists> = Object.freeze({ difficulty: 'game', speed: 1 });

/** Story's multiplier on what an enemy's hit does to the Enterprise (spec §5). */
export const STORY_DAMAGE = 0.25;

/** A stored assists object, read leniently: anything unknown is the original's. */
export function readAssists(value: unknown): CombatAssists {
  const v = (value ?? {}) as Partial<Record<keyof CombatAssists, unknown>>;
  const difficulty = (COMBAT_DIFFICULTIES as readonly unknown[]).includes(v.difficulty) ? v.difficulty as CombatDifficulty : ORIGINAL_ASSISTS.difficulty;
  const speed = (BATTLE_SPEEDS as readonly unknown[]).includes(v.speed) ? v.speed as BattleSpeed : ORIGINAL_ASSISTS.speed;
  return { difficulty, speed };
}

/**
 * The difficulty a battle is fought at, 0 Ensign to 2 Captain: the game's (UnityEngine::difficulty, awayteam.cpp:103),
 * or the one set apart from it. Story is fought at Ensign's (its enemies halved, firing on a 1-in-3 roll, Delegate on
 * at the start) with Story's own two changes on top.
 */
export function battleDifficulty(assists: Readonly<CombatAssists>, game: 0 | 1 | 2): 0 | 1 | 2 {
  switch (assists.difficulty) {
    case 'game': return game;
    case 'lieutenant': return 1;
    case 'captain': return 2;
    default: return 0;
  }
}

/** Whether this is an enemy's weapon on the Enterprise in a Story battle: the only hits Story changes. */
function storyHitsEnterprise(ctx: BattleContext, shooter: CombatShip, target: CombatShip): boolean {
  return ctx.assists?.difficulty === 'story' && !isEnterprise(shooter) && isEnterprise(target);
}

/** Story halves an enemy's chance to hit the Enterprise with a phaser beam (the chance weapons.cpp:283 rolls against). */
export function storyHitChance(ctx: BattleContext, shooter: CombatShip, target: CombatShip, chance: number): number {
  return storyHitsEnterprise(ctx, shooter, target) ? Math.trunc(chance / 2) : chance;
}

/**
 * Story halves an enemy torpedo's chance to hit the Enterprise: one that reaches it is lost on a coin flip, from the
 * battle's own random source (its draw is Story's: the original has none there). False, with no draw, otherwise.
 */
export function storyTorpedoLost(ctx: BattleContext, b: BattleState, shooter: CombatShip, target: CombatShip): boolean {
  return storyHitsEnterprise(ctx, shooter, target) && roll(ctx, b, 2, 'assists.ts:story') === 0;
}

/**
 * Story quarters what an enemy's hit does to the Enterprise's units (phaserHit, weapons.cpp:365; torpedoHit,
 * weapons.cpp:513): each unit's damage gained and charge lost, shields included, truncated. The hit's rolls and log
 * are the original's, so a hit can still break through, shake a unit loose or destroy the ship: a real battle.
 */
export function storyHit(ctx: BattleContext, shooter: CombatShip, target: CombatShip, hit: () => void): void {
  if (!storyHitsEnterprise(ctx, shooter, target)) return hit();
  const before = target.systems.units.map(u => ({ damage: u.damage, current: u.current }));
  hit();
  target.systems.units.forEach((u, i) => {
    const was = before[i];
    if (!was) return;
    if (u.damage > was.damage) u.damage = was.damage + Math.trunc((u.damage - was.damage) * STORY_DAMAGE);
    if (u.current < was.current) u.current = was.current - Math.trunc((was.current - u.current) * STORY_DAMAGE);
  });
}
