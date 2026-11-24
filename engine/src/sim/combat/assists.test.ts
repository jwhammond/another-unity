// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { miniBattle, miniBattleContext, miniCombat, miniTacticsCombat } from '../../testing/combat';
import {
  battleDifficulty, ORIGINAL_ASSISTS, readAssists, storyHit, storyHitChance, storyTorpedoLost, type CombatAssists,
} from './assists';
import { applyCommand } from './commands';
import { collide, DAMAGE_SEAMS, destroy, phaserHit, torpedoHit } from './damage';
import { SIM_SEAMS } from './seams';
import { STEP_TIME } from './time';
import { updateBattle } from './battle';
import { firePhasers, fireTorpedoes, WEAPON_SEAMS } from './weapons';
import { SHIP_FLAGS } from '../../content/types';
import { KIND, type BattleContext, type BattleState } from './types';

const STORY: CombatAssists = { difficulty: 'story', speed: 1 };

/** miniTacticsCombat's battle, Delegate against two chodaks with the AI and tactics (aiBattle.test.ts'), for `steps` steps. */
function delegateBattle(assists: Readonly<CombatAssists> | undefined, steps = 600): BattleState {
  const ctx: BattleContext = { ...miniBattleContext({ ...SIM_SEAMS }, miniTacticsCombat()), ...(assists ? { assists } : {}) };
  const { b } = miniBattle({ ctx });
  applyCommand(ctx, b, { type: 'delegate', on: true });
  for (let i = 0; i < steps; i++) updateBattle(ctx, b, b.lastStep + STEP_TIME);
  return b;
}

/** The chodak 4000 ahead, firing everything it has at the Enterprise every 30 steps, which doesn't fire back (shields up). */
function underFire(assists?: Readonly<CombatAssists>): { b: BattleState; draws: string[] } {
  const combat = miniCombat();
  combat.battles[3]!.ships[1]!.position = [0, 4000, 0];
  const draws: string[] = [];
  const ctx: BattleContext = {
    ...miniBattleContext({ ...WEAPON_SEAMS, ...DAMAGE_SEAMS }, combat), ...(assists ? { assists } : {}),
    onDraw: site => { draws.push(site); },
  };
  const { b } = miniBattle({ ctx });
  applyCommand(ctx, b, { type: 'powerLevel', level: 4 });
  for (let step = 0; step < 900; step++) {
    if (step % 30 === 5) {
      firePhasers(ctx, b, b.ships[1]!);
      fireTorpedoes(ctx, b, b.ships[1]!, 0);
    }
    updateBattle(ctx, b, b.lastStep + STEP_TIME);
  }
  return { b, draws };
}
const harm = (b: BattleState) => b.ships[0]!.systems.units.reduce((n, u) => n + u.damage, 0);

describe('the assists the sim reads (spec §5; Plan 23 R3)', () => {
  it('reads a stored assists object leniently: anything unknown is the original\'s', () => {
    expect(readAssists(undefined)).toEqual(ORIGINAL_ASSISTS);
    expect(readAssists({ difficulty: 'story', speed: 4 })).toEqual({ difficulty: 'story', speed: 4 });
    expect(readAssists({ difficulty: 'easy', speed: 3 })).toEqual(ORIGINAL_ASSISTS);
    expect(readAssists('story')).toEqual(ORIGINAL_ASSISTS);
  });

  it('fights at the game\'s difficulty, one set apart from it, or Story at Ensign\'s', () => {
    const at = (difficulty: CombatAssists['difficulty']) => ([0, 1, 2] as const).map(game => battleDifficulty({ difficulty, speed: 1 }, game));
    expect([at('game'), at('ensign'), at('lieutenant'), at('captain'), at('story')]).toEqual([[0, 1, 2], [0, 0, 0], [1, 1, 1], [2, 2, 2], [0, 0, 0]]);
  });

  it('leaves a battle bit for bit the original\'s with every number-changing assist off, whatever the speed or level set', () => {
    const original = delegateBattle(undefined);
    expect(delegateBattle(ORIGINAL_ASSISTS)).toEqual(original);
    expect(delegateBattle({ difficulty: 'captain', speed: 8 })).toEqual(original);
    expect(original.steps).toBe(600);
  });

  it('changes only an enemy\'s hits on the Enterprise in Story: half a phaser\'s chance to hit', () => {
    const { b } = miniBattle();
    const [e, chodak] = [b.ships[0]!, b.ships[1]!];
    const story = { ...miniBattleContext(), assists: STORY };
    const plain = miniBattleContext();
    expect([storyHitChance(story, chodak, e, 75), storyHitChance(story, e, chodak, 75), storyHitChance(plain, chodak, e, 75)]).toEqual([37, 75, 75]);
    // (an enemy on an enemy is not the Enterprise's: unchanged)
    expect(storyHitChance(story, chodak, chodak, 75)).toBe(75);
  });

  it('loses an enemy torpedo that reaches the Enterprise on a coin flip, a draw of its own, and draws nothing otherwise', () => {
    const { b } = miniBattle();
    const [e, chodak] = [b.ships[0]!, b.ships[1]!];
    const draws: string[] = [];
    const story: BattleContext = { ...miniBattleContext(), assists: STORY, onDraw: site => { draws.push(site); } };
    const flips = Array.from({ length: 8 }, () => storyTorpedoLost(story, b, chodak, e));
    expect(flips.filter(Boolean).length).toBeGreaterThan(0);
    expect(flips.filter(x => !x).length).toBeGreaterThan(0);
    expect(draws).toEqual(Array.from({ length: 8 }, () => 'assists.ts:story'));
    expect(storyTorpedoLost(story, b, e, chodak)).toBe(false);
    expect(storyTorpedoLost(miniBattleContext(), b, chodak, e)).toBe(false);
    expect(draws).toHaveLength(8);
  });

  it('quarters what an enemy\'s hit does to the Enterprise\'s units, a torpedo\'s or a phaser\'s, with the original\'s rolls', () => {
    const hit = (assists: CombatAssists | undefined, weapon: 'torpedo' | 'phaser') => {
      const ctx: BattleContext = { ...miniBattleContext({ ...WEAPON_SEAMS, ...DAMAGE_SEAMS }), ...(assists ? { assists } : {}) };
      const { b } = miniBattle({ ctx, seed: 77 });
      const e = b.ships[0]!;
      // (the shields down to 10, so the hit gets through)
      e.systems.units.slice(0, 8).forEach(u => { u.current = 10; });
      const before = e.systems.units.map(u => ({ ...u }));
      storyHit(ctx, b.ships[1]!, e, () => (weapon === 'torpedo' ? torpedoHit(ctx, b, e, 1) : phaserHit(ctx, b, e, 1, 400)));
      return { before, after: e.systems.units, draws: b.random.draws, log: e.log };
    };
    for (const weapon of ['torpedo', 'phaser'] as const) {
      const plain = hit(undefined, weapon);
      const story = hit(STORY, weapon);
      expect([story.draws, story.log]).toEqual([plain.draws, plain.log]);
      expect(plain.after.some((u, i) => u.damage > plain.before[i]!.damage)).toBe(true);
      story.after.forEach((u, i) => {
        const was = plain.before[i]!, full = plain.after[i]!;
        expect(u.damage).toBe(was.damage + Math.trunc(Math.max(full.damage - was.damage, 0) * 0.25));
        expect(u.current).toBe(was.current - Math.trunc(Math.max(was.current - full.current, 0) * 0.25));
      });
    }
  });

  it('spares the Enterprise under fire in Story: a quarter of the damage or less, and the coin flips are Story\'s only extra draws', () => {
    const plain = underFire();
    const story = underFire(STORY);
    // (measured for Plan 23: the Enterprise's units' damage after 900 steps, and Story's coin flips)
    expect([harm(plain.b), harm(story.b)]).toEqual([21, 4]);
    expect(story.draws.filter(s => s === 'assists.ts:story').length).toBe(80);
    expect(plain.draws.includes('assists.ts:story')).toBe(false);
  });

  /** The chodak blowing up beside the Enterprise (shields down to 10, so it gets through), or colliding with it: the harm done. */
  const blastHarm = (assists: CombatAssists | undefined, how: 'blast' | 'collide' | 'friend' | 'self') => {
    const ctx: BattleContext = { ...miniBattleContext({ ...WEAPON_SEAMS, ...DAMAGE_SEAMS }), ...(assists ? { assists } : {}) };
    const { b } = miniBattle({ ctx, seed: 77 });
    const [e, chodak] = [b.ships[0]!, b.ships[1]!];
    e.systems.units.slice(0, 8).forEach(u => { u.current = how === 'collide' ? 0 : 10; });
    if (how === 'blast') {
      chodak.flags |= SHIP_FLAGS.blast;
      destroy(ctx, b, chodak);
    } else if (how === 'collide') {
      e.pos = { x: 0, y: 0, z: 0 };
      chodak.pos = { x: 0, y: 100, z: 0 };
      e.radius = chodak.radius = 500;
      collide(ctx, b, e, chodak);
    } else {
      if (how === 'friend') chodak.type = KIND.klingon;
      storyHit(ctx, how === 'self' ? e : chodak, e, () => phaserHit(ctx, b, e, 1, 400));
    }
    return harm(b);
  };

  it('quarters an enemy self-destruct blast on the Enterprise in Story, and leaves it at full harm with the assists off', () => {
    const plain = blastHarm(undefined, 'blast');
    const story = blastHarm(STORY, 'blast');
    expect(plain).toBeGreaterThan(0);
    expect(story).toBeLessThan(plain);
    expect(story * 3).toBeLessThan(plain);
    expect(blastHarm(ORIGINAL_ASSISTS, 'blast')).toBe(plain);
  });

  it('leaves a collision at full harm in Story: both ships take it and neither deals it', () => {
    const plain = blastHarm(undefined, 'collide');
    expect(plain).toBeGreaterThan(0);
    expect(blastHarm(STORY, 'collide')).toBe(plain);
  });

  it('treats any shooter that is not the Enterprise as Story\'s: a friendly ship\'s hit on it is quartered, its own is not', () => {
    const { b } = miniBattle();
    const e = b.ships[0]!;
    const friend = { ...b.ships[1]!, type: KIND.klingon };
    const story = { ...miniBattleContext(), assists: STORY };
    expect([storyHitChance(story, friend, e, 75), storyHitChance(story, e, e, 75)]).toEqual([37, 75]);
    expect(blastHarm(STORY, 'friend')).toBeLessThan(blastHarm(undefined, 'friend'));
    expect(blastHarm(STORY, 'self')).toBe(blastHarm(undefined, 'self'));
  });
});
