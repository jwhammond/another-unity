// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { SHIP_FLAGS } from '../../content/types';
import { miniBattle, miniBattleContext } from '../../testing/combat';
import {
  afterHit, collide, critical, DAMAGE_SEAMS, destroy, explode, flashShield, hailBucket, hailResponse, phaserHit, pickUnit, runDestroyedHook, runEventHook, strengthBucket, torpedoHit,
  updateDebris, updateEffects,
} from './damage';
import { phaserEnergy } from './aim';
import { setTarget } from './commands';
import { v3 } from './math';
import { newRandom, nextRandom } from './random';
import { GAME_OVER_EXIT, NO_EXIT, NO_HOOK, SHIP_STATE, type BattleContext, type CombatSeams, type HookResult } from './types';

/**
 * The expected values are worked by hand from damage.cpp and AstroRandom (Plan 19's C reference: seed 1 draws 16838,
 * 5758, 10113, 17515, 31051, ...). rnd(n) is ((next() & 0xff) * n + 0x80) >> 8; each comment gives the draw's low
 * byte. miniCombat's units: depth i % 3; the Enterprise's hit weight 5 + i, the enemy's 10 + i and max damage 20 + i.
 */

/** Seeded battle: the trace hook keeps the sites, and the world scripts are recorded (`ship:hook`). */
function battle(seed: number, scripts: Partial<CombatSeams> = {}) {
  const sites: string[] = [];
  const hooks: string[] = [];
  const base = miniBattleContext({
    eventScript: (_c, _b, ship, hook): HookResult => { hooks.push(`${ship.index}:${hook}`); return NO_HOOK; },
    ...scripts,
  });
  const ctx: BattleContext = { ...base, onDraw: site => { sites.push(site); } };
  const { b } = miniBattle({ ctx });
  b.random = newRandom(seed);
  b.cues.length = 0;
  return { ctx, b, e: b.ships[0]!, chodak: b.ships[1]!, sites, hooks };
}

describe('pickUnit (damage.cpp:93-122)', () => {
  it('picks by weight among the units at a depth on the shield\'s list, skipping the damaged, and nothing on a boundary', () => {
    const { ctx, b, e } = battle(1);
    // (shield 3's list is 3, 8, 12, 16, 20, 32; at depth 0, units 3 (weight 8) and 12 (weight 17): total 25)
    // (byte 198: rnd(25) = 5078 >> 8 = 19; 8 < 19 < 25 is unit 12)
    expect(pickUnit(ctx, b, e, 3, 0)).toBe(12);
    // (byte 126: rnd(25) = 3278 >> 8 = 12, unit 12 again)
    expect(pickUnit(ctx, b, e, 3, 0)).toBe(12);
    // (bytes 129, 107, 75, 251, 226, 251, then 84: rnd(25) = 2228 >> 8 = 8, on the boundary: neither 0 < 8 < 8 nor 8 < 8 < 25)
    for (let i = 0; i < 6; i++) nextRandom(b.random);
    expect(pickUnit(ctx, b, e, 3, 0)).toBeNull();
    // (a damaged unit counts in the total but is never picked: seed 1 again, 19 lands on unit 12, which is damaged)
    b.random = newRandom(1);
    e.systems.units[12]!.damage = 5;
    expect(pickUnit(ctx, b, e, 3, 0)).toBeNull();
    // (nothing at depth 3: no roll)
    const draws = b.random.draws;
    expect(pickUnit(ctx, b, e, 3, 3)).toBeNull();
    expect(pickUnit(ctx, b, e, 8, 0)).toBeNull();
    expect(b.random.draws).toBe(draws);
  });
});

describe('phaserHit (damage.cpp:185-253)', () => {
  it('lets a strong shield hold, logs it, and may shake something loose', () => {
    const { ctx, b, e, hooks } = battle(1);
    phaserHit(ctx, b, e, 0, 30);
    // ((10000 / 291) & 1 is 0: cue 0x13; the shield holds at 70, 70 / 1.334 = 52.47; byte 198: rnd(100) = 77, not under (80 - 70) * 0.3125 + 25 = 28: Worf's 0x31)
    expect(e.systems.units[0]!.current).toBe(70);
    expect(e.log).toEqual(['Shield S0 holding at 52.47']);
    expect(e.logTime).toBe(13000);
    expect(b.cues.map(c => [c.cue, c.interrupt])).toEqual([[0x13, true], [0x7e, true], [0x31, false]]);
    // (afterHit: the conditions are even, bucket 5)
    expect(hooks).toEqual(['0:5']);
    expect(e.hooksRun).toBe(1 << 5);
  });

  it('ignores a small hit on a weak shield, without a roll', () => {
    const { ctx, b, e } = battle(1);
    e.systems.units[0]!.current = 30;
    phaserHit(ctx, b, e, 0, 50);
    expect([e.systems.units[0]!.current, b.random.draws, e.log]).toEqual([30, 0, []]);
    // (on the boundary, damage.cpp:193: 30 >= 60 / 2 is still ignored; 30 < 62 / 2 is not, and the hit gets through)
    phaserHit(ctx, b, e, 0, 60);
    expect([e.systems.units[0]!.current, b.random.draws]).toEqual([30, 0]);
    phaserHit(ctx, b, e, 0, 62);
    expect(e.systems.units[0]!.current).toBe(0);
  });

  it('shakes a unit loose by concussion: a pick at depth 0 and its base damage (damage.cpp:124-133)', () => {
    const { ctx, b, chodak, hooks } = battle(3);
    chodak.systems.units[2]!.current = 60;
    phaserHit(ctx, b, chodak, 2, 60);
    // (holds at 0; byte 83: rnd(100) = 32 < (80 - 0) * 0.3125 + 25 = 50. Shield 2's list 12, 6, 18, 19, 15, 16, 13, 14, 17;
    // at depth 0: 12 (22), 6 (16), 18 (28), 15 (25), total 91; byte 195: rnd(91) = 17873 >> 8 = 69: past 22, 38 and 66, unit 15.
    // Its damage, 0 + 2 + rnd(2) (byte 125: 1) = 3)
    expect(chodak.log).toEqual(['Shield -Unit 2- holding at 0.00', 'Unit -Unit 15- damaged by concussion.']);
    expect(chodak.systems.units[15]).toMatchObject({ damage: 3, current: 0, target: 0 });
    expect(b.random.draws).toBe(3);
    expect(hooks).toEqual(['1:5']);
  });

  it('gets through a weak shield: an explosion, a damaged texture, and units hit deck by deck, then a critical\'s rolls', () => {
    const { ctx, b, chodak, sites, hooks } = battle(1);
    phaserHit(ctx, b, chodak, 0, 300);
    // explode: byte 198, rnd(3) = 2: 2_boom.spr; byte 126, rnd(4) = 2. damageTexture: byte 129, rnd(3) = 2, textured in mini.dmg
    expect(chodak.explosion).toEqual({ frames: '2_boom.spr', frame: 0, frameTime: 103, lastFrame: 10000 });
    expect(b.sounds).toMatchObject([{ sound: '2_explo.mac', ship: 1 }]);
    expect(chodak.damagedMaterials).toEqual([2]);
    expect(chodak.flags & (SHIP_STATE.shielding | SHIP_STATE.flashing)).toBe(0x18);
    // 300 - 100 = 200 left. Depth 0: bytes 107, 75, 251, rnd(20) = 8, 6, 20: 200 - 11 = 189; only unit 12 (weight 22) at depth 0;
    // byte 226: rnd(22) = 19, unit 12; m from bytes 251, 84, 246, rnd(32) = 31, 11, 31: 24; 24 * ((int)(189 / 44.0f) >> 1) = 48, at most 32.
    // 189 - 22 = 167. Depth 1: bytes 189, 223, 124: 15, 17, 10: 167 - 14 = 153; 10 (20), 7 (17), 13 (23): byte 28, rnd(60) = 7, unit 10;
    // m from 225, 135, 1, rnd(30) = 26, 16, 0: 14; 14 * ((int)(153 / 40.0f) >> 1) = 14. 153 - 20 = 133.
    // Depth 2: 191, 49, 222: 15, 4, 17: 133 - 12 = 121; 8 (18), 14 (24), 17 (27): byte 86, rnd(69) = 23, unit 14;
    // m from 114, 15, 71, rnd(34) = 15, 2, 9: 8; 8 * ((int)(121 / 48.0f) >> 1) = 8. 121 - 24 = 97.
    // Depth 3: 103, 102, 135: 8, 8, 11: 97 - 9 = 88, and no unit that deep.
    expect(chodak.systems.units[0]).toMatchObject({ current: 0, target: 0 });
    expect([12, 10, 14].map(i => [chodak.systems.units[i]!.damage, chodak.systems.units[i]!.hitWeight])).toEqual([[32, 1], [14, 1], [8, 1]]);
    expect(chodak.log).toEqual(['Shield -Unit 0- penetrated.', 'Unit -Unit 12- damaged', 'Unit -Unit 10- damaged', 'Unit -Unit 14- damaged']);
    expect(chodak.logTime).toBe(12000);
    // 88 left: critical, gated: byte 89, rnd(30) = 10, not over 25; then bytes 170, 136, 60, 89, 234, 86: 66, 53, 23, 35, 91, 34: nothing
    const deck = ['232', '232', '232', '109', '238', '238', '238'];
    expect(sites.map(s => s.slice(11))).toEqual([
      '417', '418', '175', ...deck, ...deck, ...deck, '232', '232', '232', '340', '345', '356', '368', '397', '397', '408',
    ]);
    expect(sites.every(s => s.startsWith('damage.cpp:'))).toBe(true);
    // (critical's afterHit runs bucket 5; phaserHit's own finds it run)
    expect(hooks).toEqual(['1:5']);
  });
});

describe('torpedoHit (damage.cpp:255-337)', () => {
  it('is repelled by a shield over 19, which loses 25', () => {
    const { ctx, b, e, hooks } = battle(1);
    torpedoHit(ctx, b, e, 2);
    expect(e.systems.units[2]!.current).toBe(75);
    expect(e.log).toEqual(['Photon torpedo repelled by S2']);
    expect(e.torpedoLogTime).toBe(12000);
    // (0x12 as it hits; (10000 / 291) & 1 is 0: 0x7e)
    expect(b.cues.map(c => c.cue)).toEqual([0x12, 0x7e]);
    expect([b.random.draws, hooks]).toEqual([0, ['0:5']]);
  });

  it('reaches the decks: r 25 to 49 knocks out a unit at depth 0 and one at depth 1, then the blast picks one', () => {
    const { ctx, b, chodak } = battle(3);
    chodak.systems.units[4]!.current = 0;
    torpedoHit(ctx, b, chodak, 4);
    // (byte 83: r = rnd(100) = 32. damageTexture: byte 195, rnd(3) = 2. byte 125: deck rnd(8) = 4.
    // Shield 4's list 10, 13, 14, 17, 12, 6. Concussion at depth 0: 12 (22), 6 (16); byte 120, rnd(38) = 18: unit 12; byte 142, rnd(2) = 1: 3.
    // At depth 1: 10 (20), 13 (23); byte 180, rnd(43) = 30: unit 13, life support, which a concussion spares.
    // The blast at depth 1: byte 77, rnd(43) = 13: unit 10; byte 183, q = 71, so 3 rolls of rnd(30): 72, 47, 109 give 8, 6, 13: 9)
    expect(chodak.log).toEqual([
      'Photon torpedo penetrated -Unit 4-', 'Photon penetration of deck 4.', 'Unit -Unit 12- damaged by concussion.', 'Unit -Unit 10- damaged by photon blast.',
    ]);
    expect([chodak.systems.units[12]!.damage, chodak.systems.units[13]!.damage, chodak.systems.units[10]!.damage]).toEqual([3, 0, 9]);
    expect(chodak.damagedMaterials).toEqual([2]);
    expect(b.random.draws).toBe(11);
  });

  it('reaches the core over 75: a critical, then the blast', () => {
    const { ctx, b, chodak, sites } = battle(1);
    chodak.systems.units[1]!.current = 10;
    torpedoHit(ctx, b, chodak, 1);
    // (byte 198: r = 77. damageTexture: byte 126, rnd(3) = 1. The critical: bytes 129, 107, 75, 251, 226, 251 give 50, 42, 29, 98, 88, 98: nothing.
    // The blast at depth 0 of shield 1's list (8, 9, 13, 14, 17, 12, 6, 18, 19, 15, 16): 9 (19), 12 (22), 6 (16), 18 (28), 15 (25), total 110;
    // byte 84, rnd(110) = 36: past 19, unit 12. Byte 246: q = 96, so rnd(32) of 189, 223, 124: 24, 28, 16: 22)
    expect(chodak.log).toEqual(['Photon torpedo penetrated -Unit 1-', 'Photon penetration of ship core.', 'Unit -Unit 12- damaged by photon blast.']);
    expect(chodak.systems.units[12]).toMatchObject({ damage: 22, current: 0 });
    expect(chodak.damagedMaterials).toEqual([1]);
    expect(sites.map(s => s.slice(11))).toEqual(['280', '175', '345', '356', '368', '397', '397', '408', '109', '324', '331', '331', '331']);
  });

  it('finishes off a stopped ship whose shield is all but gone, on r under 50', () => {
    const { ctx, b, chodak } = battle(3);
    chodak.systems.units[4]!.current = 0;
    chodak.systems.units[4]!.damage = 20;
    torpedoHit(ctx, b, chodak, 4);
    // (byte 83: r = 32 < 50, damage 20 >= 24 - 5, speed 0)
    expect(chodak.destroyed).toBe(true);
    expect(chodak.log.at(-1)).toBe('SHIP DESTROYED');
  });
});

describe('critical (damage.cpp:339-411)', () => {
  it('takes the shields offline, a reactor down, and can destroy the ship', () => {
    const { ctx, b, chodak, sites, hooks } = battle(13);
    critical(ctx, b, chodak, false);
    // (byte 18: 7 < 20, shields offline. For shields 0-5, rnd(8) of 29, 102, 219, 79, 98, 13 is 1, 3, 7, 2, 3, 0:
    // unit 1 is damaged rnd(21) (byte 185: 15), unit 4 rnd(24) (byte 98: 9). Phasers: byte 75, 29. Major: byte 221, 86.
    // Warp reactor: byte 70, 27. Fusion: byte 1, 0: unit 18 down. Destroy: byte 7, 3 < 15)
    expect(chodak.systems.units.slice(0, 6).map(u => [u.current, u.target, u.damage])).toEqual([[0, 0, 0], [0, 0, 15], [0, 0, 0], [0, 0, 0], [0, 0, 9], [0, 0, 0]]);
    expect(chodak.systems.units[18]).toMatchObject({ current: 0, target: 0, damage: 38 });
    expect(chodak.log).toEqual(['Shields temporarily offline', 'Fusion reactor down', 'SHIP DESTROYED']);
    expect(b.cues[0]!.cue).toBe(0x37);
    expect(sites.slice(0, 14).map(s => s.slice(11))).toEqual(['345', '351', '351', '352', '351', '351', '351', '352', '351', '356', '368', '397', '397', '408']);
    // (destroy's six pieces of debris, seven rolls each, and its explosion; the destroyed hook first)
    expect(sites.length).toBe(14 + 42 + 2);
    expect(hooks).toEqual(['1:11']);
  });

  it('takes the phasers offline, one damageTexture each (damage.cpp:356-364)', () => {
    const { ctx, b, chodak, sites } = battle(5);
    critical(ctx, b, chodak, false);
    // (seed 5's bytes 223, 9: rnd(100) = 87, not shields; 4 < 20, phasers. Units 8 and 9 to their max damage, 28 and 29, each
    // with a damageTexture: bytes 120, 133, rnd(3) = 1, 2, both textured in mini.dmg. Then 209, 184 and 115 for 368 (82), the
    // reactors (42, 72) and 408 (45): nothing. No cue: the chodak isn't the Enterprise)
    expect(sites.map(s => s.slice(11))).toEqual(['345', '356', '175', '175', '368', '397', '397', '408']);
    expect([8, 9].map(i => chodak.systems.units[i])).toMatchObject([{ current: 0, target: 0, damage: 28 }, { current: 0, target: 0, damage: 29 }]);
    expect(chodak.systems.units.filter(u => u.damage).length).toBe(2);
    expect(chodak.damagedMaterials).toEqual([1, 2]);
    expect(chodak.log).toEqual(['Phasers offline']);
    expect(b.cues).toEqual([]);
  });

  it('takes every major system offline, rolling its damage between each unit\'s two damageTextures, and leaves every other unit fully damaged (damage.cpp:368-390)', () => {
    const { ctx, b, chodak, sites } = battle(47);
    critical(ctx, b, chodak, false);
    // (seed 47's bytes 104, 182: 41, 71, neither; byte 25: rnd(100) = 10 < 15. Units 0-12 aren't major: two damageTextures
    // each (bytes 150, 70, ... 70, 194). The major ones, life support 13, warp 15, impulse 16, the grid 17, fusion 18 and
    // matter/antimatter 19, roll their damage first: bytes 169, 221, 79, 15, 234, 137 give rnd(33) = 22, rnd(35) = 30,
    // rnd(36) = 11, rnd(37) = 2, rnd(38) = 35, rnd(39) = 21. The computer 14 between them: 99, 59. The reactors' 155, 175
    // (61, 68) and 408's 59 (23): nothing. damageTexture's first two: rnd(3) of 150 and 70 is 2 and 1, both textured)
    const tex = ['175', '175'];
    const minor = Array.from({ length: 13 }, () => tex).flat();
    expect(sites.map(s => s.slice(11))).toEqual([
      '345', '356', '368', ...minor, '380', ...tex, ...tex, '380', ...tex, '380', ...tex, '380', ...tex, '380', ...tex, '380', ...tex,
      '397', '397', '408',
    ]);
    // (the quirk, damage.cpp:382-384: the others' damage is their max, and their current is left as it was)
    const units = chodak.systems.units;
    expect(units.map((u, i) => [i, u.current, u.target, u.damage])).toEqual([
      ...Array.from({ length: 13 }, (_, i) => [i, 100, 100, 20 + i]),
      [13, 0, 0, 22], [14, 100, 100, 34], [15, 0, 0, 30], [16, 0, 0, 11], [17, 0, 0, 2], [18, 0, 0, 35], [19, 0, 0, 21],
    ]);
    expect(chodak.damagedMaterials).toEqual([2, 1]);
    expect(chodak.log).toEqual(['All major systems offline']);
    expect(b.cues.map(c => c.cue)).toEqual([0x36]);
  });

  it('takes the Enterprise\'s fusion reactor down (unit 33), or its warp reactor (unit 34), with cue 0x49 (damage.cpp:396-407)', () => {
    // (seed 18's bytes 241, 74, 219: 94, 29, 86, none; 218: 85, no warp reactor; 1: 0 < 20, fusion; 157: 61, no destroy)
    const fusion = battle(18);
    critical(fusion.ctx, fusion.b, fusion.e, false);
    expect(fusion.sites.map(s => s.slice(11))).toEqual(['345', '356', '368', '397', '397', '408']);
    expect(fusion.e.log).toEqual(['Fusion reactor down']);
    expect([fusion.e.systems.units[33], fusion.e.systems.units[34]]).toMatchObject([{ current: 0, target: 0, damage: 100 }, { current: 100, damage: 0 }]);
    expect(fusion.b.cues.map(c => c.cue)).toEqual([0x49]);
    // (seed 25's bytes 93, 189, 75: 36, 74, 29; 7: 3 < 20, warp; 106: 41; 163: 64)
    const warp = battle(25);
    critical(warp.ctx, warp.b, warp.e, false);
    expect(warp.e.log).toEqual(['Warp reactor down']);
    expect([warp.e.systems.units[33], warp.e.systems.units[34]]).toMatchObject([{ current: 100, damage: 0 }, { current: 0, target: 0, damage: 100 }]);
    expect(warp.b.cues.map(c => c.cue)).toEqual([0x49]);
  });

  it('is gated after a phaser hit: a roll over 25 of 30 is nothing (40 - kFrameRate)', () => {
    // (seed 1234's first draw is 3558, byte 230: rnd(30) = 7028 >> 8 = 27)
    const { ctx, b, chodak } = battle(1234);
    critical(ctx, b, chodak, true);
    expect([b.random.draws, chodak.log]).toEqual([1, []]);
  });
});

describe('explode and flashShield (damage.cpp:413-433)', () => {
  it('starts one of four booms once, and flashes the hit shield; the Enterprise\'s bridge flashes red on next() under 0x4000', () => {
    const { ctx, b, e, chodak } = battle(1);
    explode(ctx, b, chodak);
    explode(ctx, b, chodak);
    expect(b.random.draws).toBe(2);
    flashShield(ctx, b, chodak, e, e.pos, 1);
    expect(chodak.shieldFlash).toEqual({ frames: '__shield.spr', frame: 0, frameTime: 247, lastFrame: 10000 });
    expect([chodak.shieldAttacker, b.random.draws, b.console.redFlash]).toEqual([0, 2, false]);
    // (seed 1's third next() is 10113, under 0x4000)
    flashShield(ctx, b, e, chodak, chodak.pos, 0);
    expect([b.random.draws, b.console.redFlash]).toEqual([3, true]);
    expect(b.sounds.map(s => s.sound)).toEqual(['2_explo.mac', 'sheldht2.mac', 'sheldht2.mac']);
    // (no flash for a shield down to 0, or without the sprite)
    const { ctx: c2, b: b2, chodak: k2 } = battle(1);
    k2.systems.units[1]!.current = 0;
    flashShield(c2, b2, k2, null, v3(), 1);
    delete c2.combat.animations!['__shield.spr'];
    flashShield(c2, b2, k2, null, v3(), 2);
    expect(k2.shieldFlash.frames).toBeNull();
  });
});

describe('the hooks (damage.cpp:640-732)', () => {
  it('buckets how the battle is going by the condition gap: 5 within 28, 6 or 9 losing, 7 or 10 winning', () => {
    const { b, e, chodak } = battle(1);
    const at = (gap: number) => { chodak.condition = 50; e.condition = 50 + gap; return [strengthBucket(b, chodak), strengthBucket(b, e)]; };
    expect([at(0), at(28), at(-28), at(29), at(49), at(50), at(-29), at(-49), at(-50)].map(x => x[0])).toEqual([5, 5, 5, 7, 7, 10, 6, 6, 9]);
    // (the Enterprise's own: against its target)
    expect(at(-50)[1]).toBe(9);
  });

  it('runs each hook once a ship, and a hail\'s bucket once, and the hull-low script when the condition is under the threshold', () => {
    const answered: string[] = [];
    const hullLow: number[] = [];
    const { ctx, b, chodak, hooks } = battle(1, {
      hailScript: (_c, _b, ship, bucket) => { answered.push(`${ship.index}:${bucket}`); return { hailPending: false, answered: true }; },
      hullLowScript: (_c, _b, ship) => { hullLow.push(ship.index); return NO_HOOK; },
    });
    runEventHook(ctx, b, chodak, 3);
    runEventHook(ctx, b, chodak, 3);
    expect(hooks).toEqual(['1:3']);
    expect(hailResponse(ctx, b, chodak)).toBe(true);
    expect(hailResponse(ctx, b, chodak)).toBe(false);
    expect(answered).toEqual(['1:5']);
    chodak.condition = 40;
    chodak.systems.units[0]!.current = 1000;
    phaserHit(ctx, b, chodak, 0, 10);
    // (40 is under the threshold of 50; the gap of 60 is bucket 10)
    expect(hullLow).toEqual([1]);
    expect(hooks).toEqual(['1:3', '1:10']);
  });

  it('runs nothing for a ship without its object, and marks no hook run, so one given its object later runs them (damage.cpp:658-659, 679-680, 698-699; Plan 23 R5)', () => {
    let sourced = false;
    const answered: number[] = [];
    const hullLow: number[] = [];
    const { ctx, b, chodak, hooks } = battle(1, {
      hasSource: () => sourced,
      hailScript: (_c, _b, _s, bucket) => { answered.push(bucket); return { hailPending: false, answered: true }; },
      hullLowScript: (_c, _b, ship) => { hullLow.push(ship.index); return NO_HOOK; },
    });
    expect(runEventHook(ctx, b, chodak, 3)).toBe(NO_HOOK);
    expect([hailBucket(ctx, b, chodak), hailResponse(ctx, b, chodak)]).toEqual([null, false]);
    chodak.condition = 40;
    afterHit(ctx, b, chodak);
    expect([hooks, answered, hullLow, chodak.hooksRun]).toEqual([[], [], [], 0]);
    sourced = true;
    runEventHook(ctx, b, chodak, 3);
    // (the gap of 60 is bucket 10)
    expect([hailBucket(ctx, b, chodak), hailBucket(ctx, b, chodak)]).toEqual([10, null]);
    expect([hooks, chodak.hooksRun]).toEqual([['1:3'], (1 << 3) | (1 << 10)]);
  });

  it('runs no destroyed script for a ship without its object (damage.cpp:718-720; Plan 23 R5)', () => {
    let sourced = false;
    const destroyed: number[] = [];
    const { ctx, b, chodak } = battle(1, {
      hasSource: () => sourced,
      destroyedScript: (_c, _b, ship) => { destroyed.push(ship.index); return NO_HOOK; },
    });
    expect(runDestroyedHook(ctx, b, chodak)).toBe(NO_HOOK);
    expect(destroyed).toEqual([]);
    sourced = true;
    runDestroyedHook(ctx, b, chodak);
    expect(destroyed).toEqual([1]);
  });
});

describe('destroy (damage.cpp:462-563)', () => {
  it('breaks a ship into six pieces of debris with their spins, speeds and booms, and asks for the destroyed cues', () => {
    const deactivated: number[] = [];
    const { ctx, b, chodak, hooks } = battle(1, { deactivate: (_c, _b, ship) => { deactivated.push(ship.index); } });
    chodak.velocity = v3(0, 100, 0);
    destroy(ctx, b, chodak);
    expect(hooks).toEqual(['1:11']);
    expect(b.view).toMatchObject({ view: 0xc, viewShip: 1 });
    const [debris] = b.debris;
    expect(debris).toMatchObject({ ship: 1, scale: 1, alpha: -1, fadeTime: 12000, removeTime: 20000 });
    // (piece 0: bytes 198, 126, 129 give rnd(0xa80) = 2079, 1323, 1355, less 0x564; 107, 75, 251 give rnd(500) = 209, 146, 490, less 250,
    // plus twice the ship's velocity; 226 gives rnd(0x246) = 514, combatTicks(514) = 1766)
    expect(debris!.pieces[0]).toMatchObject({ model: 'generic.pc1', pos: chodak.pos, angles: [8192, 0, 0], rates: [699, -57, -25], velocity: v3(-41, 96, 240), boomTime: 11766, boomStarted: false });
    expect(debris!.pieces).toHaveLength(6);
    // (then the explosion: bytes 85 and 47 of the 43rd and 44th draws, rnd(3) = 1, rnd(4) = 1)
    expect(chodak.explosion.frames).toBe('1_boom.spr');
    expect(b.random.draws).toBe(44);
    expect([chodak.destroyed, chodak.flags & SHIP_STATE.dying, chodak.logFrozen, chodak.activeBeams, deactivated]).toEqual([true, SHIP_STATE.dying, true, 0, [1]]);
    expect(b.cues.map(c => [c.cue, c.delay, c.interrupt])).toEqual([[0x70, 0, true], [0x6c, 2000, false], [0x6d, 3000, false], [0x6e, 4000, true], [0x6f, 5000, false]]);
    expect(chodak.log).toEqual(['SHIP DESTROYED']);
    destroy(ctx, b, chodak);
    expect(b.debris).toHaveLength(1);
  });

  it('holds a ship\'s end back 5 s when its destroyed hook leaves a conversation pending (damage.cpp:473-477)', () => {
    const { ctx, b, chodak } = battle(1, { eventScript: (): HookResult => ({ hailPending: true, answered: false }) });
    destroy(ctx, b, chodak);
    expect([chodak.destroyed, chodak.removeTime, b.random.draws]).toEqual([false, 15000, 0]);
    // (the hook has run: next time it breaks up)
    destroy(ctx, b, chodak);
    expect(chodak.destroyed).toBe(true);
  });

  it('breaks up at once when the hold has already started (`!ship->removeTime`, damage.cpp:474)', () => {
    const { ctx, b, chodak } = battle(1, { eventScript: (): HookResult => ({ hailPending: true, answered: false }) });
    chodak.removeTime = 12345;
    destroy(ctx, b, chodak);
    expect([chodak.destroyed, chodak.removeTime, b.debris.length]).toEqual([true, 12345, 1]);
  });

  it('takes the target with it on a self-destruct: three phaser hits of the blast\'s energy on the shield it faces', () => {
    const { ctx, b, e, chodak } = battle(1);
    chodak.pos = v3(0, 4000, 0);
    chodak.flags |= SHIP_FLAGS.blast;
    destroy(ctx, b, chodak);
    // (the chodak faces the Enterprise: shield 1, S1. Its units are all full: 100% * 64 = 6400;
    // half of 4000 is 2000: k = (int)(9250 / 714 + 6.75f) = 18, 18 * 18 * 6400 / 250 = 8294)
    expect(phaserEnergy(2000, 6400)).toBe(8294);
    expect(e.systems.units[1]).toMatchObject({ current: 0, target: 0 });
    expect(e.log[0]).toBe('Shield S1 penetrated.');
    expect(b.cues.filter(c => c.cue === 0x13).length).toBe(3);
  });

  it('measures the phasers\' energy by distance: k = (int)((int)(11250 - d) / 714 + 6.75f), none beyond the range', () => {
    // (11250: k = 6, 36 * 100 / 250 = 14; 0: (int)(11250 / 714) = 15, k = 21, 441 * 100 / 250 = 176)
    expect([phaserEnergy(11250, 100), phaserEnergy(0, 100), phaserEnergy(11251, 100), phaserEnergy(5000, 10)]).toEqual([14, 176, 0, 7]);
  });
});

describe('updateEffects (damage.cpp:435-460)', () => {
  it('turns the flashing shield to face its attacker, at the ship\'s radius, until the flash has played', () => {
    const { ctx, b, e, chodak } = battle(1);
    chodak.pos = v3(0, 0, 0);
    e.pos = v3(0, 5000, 0);
    flashShield(ctx, b, chodak, e, e.pos, 1);
    // (the Enterprise straight ahead: angles 0, 0; the impact 200 out, miniCombat's radius)
    const done: boolean[] = [];
    for (let i = 1; i <= 5; i++) {
      b.now = 10000 + 248 * i;
      updateEffects(ctx, b, chodak);
      done.push(chodak.shieldFlash.frames === null);
    }
    expect([chodak.shieldAngles, chodak.shieldImpact]).toEqual([[0, 0], v3(0, 200, 0)]);
    // (five frames, 247 ms each: the fifth advance wraps and stops it)
    expect(done).toEqual([false, false, false, false, true]);
    expect(chodak.flags & SHIP_STATE.shielding).toBe(0);
  });

  it('plays the explosion out, damaging a texture as it reaches its last frame', () => {
    const { ctx, b, chodak, sites } = battle(1);
    explode(ctx, b, chodak);
    sites.length = 0;
    // (2_boom.spr: 8 frames of 103 ms)
    for (let i = 1; i <= 7; i++) {
      b.now = 10000 + 104 * i;
      updateEffects(ctx, b, chodak);
    }
    expect([chodak.explosion.frame, sites]).toEqual([7, ['damage.cpp:175']]);
    b.now += 104;
    updateEffects(ctx, b, chodak);
    expect([chodak.explosion.frames, chodak.flags & SHIP_STATE.flashing]).toEqual([null, 0]);
  });
});

describe('updateDebris and removeShip (damage.cpp:565-618)', () => {
  it('spins and flies the pieces, booms them, fades them, then removes the ship and moves the target on', () => {
    const destroyed: number[] = [];
    const { ctx, b, chodak, sites } = battle(1, { destroyedScript: (_c, _b, ship) => { destroyed.push(ship.index); return NO_HOOK; } });
    ctx.combat.kinds[0]!.destroyedCue = 0x50;
    chodak.velocity = v3(0, 100, 0);
    destroy(ctx, b, chodak);
    const piece = b.debris[0]!.pieces[0]!;
    sites.length = 0;
    b.cues.length = 0;
    b.now = 10066;
    updateDebris(ctx, b);
    // ((int)(8192 + 699 * 0.066f) = 8238; (int)(-57 * 0.066f) = -3, & 0x3fff = 16381; -25: 16383. Then pos + velocity * 0.066f)
    expect(piece.angles).toEqual([8238, 16381, 16383]);
    expect(piece.pos.x).toBeCloseTo(1000 - 41 * 0.066, 3);
    expect(piece.pos.z).toBeCloseTo(5000 + 240 * 0.066, 3);
    expect([piece.boomStarted, sites]).toEqual([false, []]);
    // (piece 0 booms after 11766)
    b.now = 11767;
    updateDebris(ctx, b);
    expect(piece.boomStarted).toBe(true);
    expect(sites).toContain('damage.cpp:576');
    expect(b.cues.find(c => c.cue === 0x6e)).toEqual({ cue: 0x6e, delay: 247, interrupt: true });
    // (they fade from 12000, 0x222 a step, to 0x4000)
    b.now = 12001;
    updateDebris(ctx, b);
    expect(b.debris[0]!.alpha).toBe(0x222);
    for (let i = 0; i < 29; i++) updateDebris(ctx, b);
    expect(b.debris[0]!.alpha).toBe(0x4000);
    // (gone after 20000: removed, Worf's cue, the destroyed script, and no target left)
    b.now = 20001;
    updateDebris(ctx, b);
    expect([b.debris.length, chodak.removed, b.target, b.ships[0]!.target, destroyed]).toEqual([0, true, null, null, [1]]);
    expect(b.cues.at(-1)).toEqual({ cue: 0x50, delay: 0, interrupt: true });
    expect(b.exitCode).toBe(NO_EXIT);
  });

  it('ends the game when the Enterprise\'s debris goes (kShipGameEnd | 0x100)', () => {
    const { ctx, b, e } = battle(1);
    destroy(ctx, b, e);
    expect(b.silenced).toBe(true);
    b.now = 20001;
    updateDebris(ctx, b);
    expect(b.exitCode).toBe(GAME_OVER_EXIT);
  });

  it('tags each cue asked for once the Enterprise is lost as silenced (CuePlayer::blocked, cues.cpp:62-63), not its own 0x70', () => {
    const { ctx, b, e, chodak } = battle(1);
    chodak.pos = v3(0, 4000, 0);
    e.flags |= SHIP_FLAGS.blast;
    e.target = 1;
    destroy(ctx, b, e);
    // (the Enterprise's 0x70 and its four later cues are asked for before _silenced is set (damage.cpp:522-534); its
    // blast's three phaser hits then take the target's shields offline (0x37) and destroy it (its own five cues):
    // ScummVM drops those at play() time, and Plan 22 drops the tagged ones)
    expect(b.cues.map(c => [c.cue, c.silenced ?? false])).toEqual([
      [0x70, false], [0x6c, false], [0x6d, false], [0x6e, false], [0x6f, false],
      [0x37, true], [0x70, true], [0x6c, true], [0x6d, true], [0x6e, true], [0x6f, true],
    ]);
    expect('silenced' in b.cues[0]!).toBe(false);
    expect(chodak.log).toContain('Shields temporarily offline');
  });
});

describe('collide (damage.cpp:620-638)', () => {
  it('hits both ships\' shields, the first\'s rolls first, then explodes both when they only touch', () => {
    const { ctx, b, e, chodak, sites } = battle(1);
    chodak.pos = v3(0, 150, 0);
    for (const ship of [e, chodak]) for (let i = 0; i < 6; i++) ship.systems.units[i]!.current = 1000;
    collide(ctx, b, e, chodak);
    // (the Enterprise: byte 198, shield rnd(5) = 4; byte 126, rnd(200) + 200 = 298: 1000 - 298 = 702, 702 / 1.334 = 526.24; byte 129: rnd(100) = 50, no concussion.
    // The chodak: byte 107, shield 2; byte 75, 59 + 200 = 259: 741, 555.47; byte 251: 98.
    // 200 is not over twice 150: both explode: bytes 226, 251 (rnd(3) = 3, rnd(4) = 4) and 84, 246 (1, 4))
    expect(e.log).toEqual(['Collision Imminent', 'Shield S4 holding at 526.24']);
    expect(chodak.log).toEqual(['Shield -Unit 2- holding at 555.47']);
    expect([e.systems.units[4]!.current, chodak.systems.units[2]!.current]).toEqual([702, 741]);
    expect(sites.map(s => s.slice(11))).toEqual(['630', '630', '207', '630', '630', '207', '417', '418', '417', '418']);
    // (rnd(4) runs 0 to 4: a quirk, kept; there is no 4_explo.mac)
    expect([e.explosion.frames, chodak.explosion.frames, b.sounds.map(s => s.sound)]).toEqual(['3_boom.spr', '1_boom.spr', ['4_explo.mac', '4_explo.mac']]);
  });

  it('hits a cloaked ship harder, and may destroy either when they overlap by more than half', () => {
    const { ctx, b, e, chodak } = battle(2);
    chodak.pos = v3(0, 50, 0);
    chodak.decloakTime = 99999;
    for (const ship of [e, chodak]) for (let i = 0; i < 6; i++) ship.systems.units[i]!.current = 5000;
    collide(ctx, b, e, chodak);
    // (seed 2: the Enterprise's shield, byte 140: rnd(5) = 3; byte 33: rnd(200) = 26, 226; it holds, byte 255 for the concussion.
    // The chodak's shield, byte 114: 2; cloaked, byte 237: rnd(2000) = 1852, 3852; byte 215 for the concussion.
    // Then 200 > 2 * 50: byte 24, rnd(5) = 0, so the Enterprise explodes (bytes 217, 78); byte 19, rnd(5) = 0, the chodak too)
    expect([e.systems.units[3]!.current, chodak.systems.units[2]!.current]).toEqual([5000 - 226, 5000 - 3852]);
    expect(b.random.draws).toBe(12);
    expect([e.destroyed, chodak.destroyed]).toEqual([false, false]);
  });

  it('destroys a ship whose roll of rnd(5) is 2 when they overlap by more than half', () => {
    const { ctx, b, e, chodak } = battle(3);
    chodak.pos = v3(0, 50, 0);
    for (const ship of [e, chodak]) for (let i = 0; i < 6; i++) ship.systems.units[i]!.current = 1000;
    collide(ctx, b, e, chodak);
    // (seed 3: bytes 83, 195 (shield 2, 352), 125; 120, 142 (shield 2, 311), 180; then byte 77: rnd(5) = 2, and the Enterprise is destroyed)
    expect([e.systems.units[2]!.current, chodak.systems.units[2]!.current]).toEqual([648, 689]);
    expect(e.destroyed).toBe(true);
  });
});

describe('updateEffects, updateDebris, removeShip and collide: each branch', () => {
  it('turns the shield after its attacker as it moves, and to where the hit came from without one (damage.cpp:438)', () => {
    const { ctx, b, e, chodak } = battle(1);
    chodak.pos = v3(0, 0, 0);
    e.pos = v3(0, 5000, 0);
    flashShield(ctx, b, chodak, e, e.pos, 1);
    // (the Enterprise moves straight overhead: atan2f(0, 0) = 0; atan2f(5000, 0) = pi / 2, 4096; the impact 200 up)
    e.pos = v3(0, 0, 5000);
    b.now = 10001;
    updateEffects(ctx, b, chodak);
    expect(chodak.shieldAngles).toEqual([0, 4096]);
    expect(chodak.shieldImpact.z).toBe(200);
    expect(chodak.shieldImpact.y).toBeCloseTo(0, 4);

    const other = battle(1);
    other.chodak.pos = v3(0, 0, 0);
    flashShield(other.ctx, other.b, other.chodak, null, v3(5000, 0, 0), 1);
    other.b.now = 10001;
    updateEffects(other.ctx, other.b, other.chodak);
    // (to starboard: atan2f(5000, 0) = 4096, atan2f(0, 5000) = 0)
    expect(other.chodak.shieldAngles).toEqual([4096, 0]);
    expect(other.chodak.shieldImpact.x).toBe(200);
    // (from (3000, 4000, 5000): atan2f(3000, 4000) = 0.6435 rad, 1677.99 truncated to 1677; atan2f(5000, sqrtf(3000 * 3000 + 4000 * 4000) = 5000) = pi / 4, 2048)
    other.chodak.shieldFrom = v3(3000, 4000, 5000);
    updateEffects(other.ctx, other.b, other.chodak);
    expect(other.chodak.shieldAngles).toEqual([1677, 2048]);
  });

  it('plays a piece\'s boom out and stops it; with no booms, no boom and no roll (damage.cpp:574-580)', () => {
    const { ctx, b, chodak, sites } = battle(1);
    destroy(ctx, b, chodak);
    const piece = b.debris[0]!.pieces[0]!;
    sites.length = 0;
    b.now = 11767;
    updateDebris(ctx, b);
    // (one rnd(3) a piece as its boom starts, and no other roll in the step)
    const started = b.debris[0]!.pieces.filter(p => p.boomStarted).length;
    expect(started).toBeGreaterThan(0);
    expect(sites).toEqual(Array(started).fill('damage.cpp:576'));
    // (8 frames of 103 ms: the eighth advance wraps, and the boom stops)
    const stopped: boolean[] = [];
    for (let i = 0; i < 8; i++) {
      b.now += 104;
      updateDebris(ctx, b);
      stopped.push(piece.boom.frames === null);
    }
    expect(stopped).toEqual([false, false, false, false, false, false, false, true]);

    const other = battle(1);
    destroy(other.ctx, other.b, other.chodak);
    const none: BattleContext = { ...other.ctx, combat: { ...other.ctx.combat, effects: { ...other.ctx.combat.effects, booms: [] } } };
    const draws = other.b.random.draws;
    other.b.now = 11767;
    updateDebris(none, other.b);
    expect([other.b.debris[0]!.pieces[0]!.boomStarted, other.b.random.draws]).toEqual([false, draws]);
  });

  it('stops at the Enterprise\'s removal, leaving the debris after it; and removes debris after debris in one step', () => {
    const first = battle(1);
    destroy(first.ctx, first.b, first.e);
    destroy(first.ctx, first.b, first.chodak);
    first.b.now = 19999;
    updateDebris(first.ctx, first.b);
    const pos = { ...first.b.debris[1]!.pieces[0]!.pos };
    first.b.now = 20001;
    updateDebris(first.ctx, first.b);
    // (the game is over: the chodak's pieces don't move, and its debris stays)
    expect([first.b.exitCode, first.b.debris.length, first.chodak.removed, first.b.debris[0]!.pieces[0]!.pos]).toEqual([GAME_OVER_EXIT, 1, false, pos]);

    const second = battle(1);
    destroy(second.ctx, second.b, second.chodak);
    destroy(second.ctx, second.b, second.e);
    second.b.now = 20001;
    updateDebris(second.ctx, second.b);
    // (remove_at(i--): the Enterprise's debris, now first, is still reached)
    expect([second.b.debris.length, second.chodak.removed, second.e.removed, second.b.exitCode]).toEqual([0, true, true, GAME_OVER_EXIT]);
  });

  it('moves the target to the next live ship, clears it with fewer than two left, and leaves another target be (damage.cpp:600-604)', () => {
    const remove = (prepare: (r: ReturnType<typeof battle>) => void) => {
      const r = battle(1);
      for (const index of [2, 3]) r.b.ships.push({ ...structuredClone(r.chodak), index });
      prepare(r);
      destroy(r.ctx, r.b, r.chodak);
      r.b.now = 20001;
      updateDebris(r.ctx, r.b);
      return [r.b.target, r.e.target];
    };
    // (four ships: the Enterprise, the chodak and two copies of it)
    expect(remove(r => setTarget(r.b, 1))).toEqual([2, 2]);
    // (nextTarget finds ship 2, but only it is left unremoved: the Enterprise and ship 3 are marked removed to get there)
    expect(remove(r => { setTarget(r.b, 1); r.e.removed = true; r.b.ships[3]!.removed = true; })).toEqual([null, null]);
    // (ship 3 stays the target: nextTarget from it would pick ship 2)
    expect(remove(r => setTarget(r.b, 3))).toEqual([3, 3]);
  });

  it('says nothing for a kind without a destroyed cue (kDestroyedCues -1, damage.cpp:610)', () => {
    const { ctx, b, chodak } = battle(1);
    destroy(ctx, b, chodak);
    b.now = 19999;
    updateDebris(ctx, b);
    b.cues.length = 0;
    b.now = 20001;
    updateDebris(ctx, b);
    expect([chodak.removed, b.cues]).toEqual([true, []]);
  });

  it('does nothing, and rolls nothing, for ships just touching (r <= d, damage.cpp:623)', () => {
    const { ctx, b, e, chodak } = battle(1);
    chodak.pos = v3(0, 200, 0);
    collide(ctx, b, e, chodak);
    expect([b.random.draws, e.log, e.explosion.frames]).toEqual([0, [], null]);
  });

  it('hits harder only a cloaked ship that can cloak and isn\'t the Enterprise (damage.cpp:628)', () => {
    const { ctx, b, e, chodak } = battle(2);
    chodak.pos = v3(0, 150, 0);
    e.flags |= SHIP_FLAGS.canCloak;
    e.decloakTime = 99999;
    chodak.flags &= ~SHIP_FLAGS.canCloak;
    chodak.decloakTime = 99999;
    for (const ship of [e, chodak]) for (let i = 0; i < 6; i++) ship.systems.units[i]!.current = 5000;
    collide(ctx, b, e, chodak);
    // (seed 2: the Enterprise's bytes 140, 33: shield 3, rnd(200) = 26, 226 (cloaked, rnd(2000) would be 258); byte 255.
    // The chodak's bytes 114, 237: shield 2, rnd(200) = 185, 385 (rnd(2000) would be 1852))
    expect([e.systems.units[3]!.current, chodak.systems.units[2]!.current]).toEqual([5000 - 226, 5000 - 385]);
  });
});

describe('DAMAGE_SEAMS', () => {
  it('fills the damage seams with these functions, frozen', () => {
    expect(DAMAGE_SEAMS).toEqual({ destroy, updateEffects, updateDebris });
    expect(Object.isFrozen(DAMAGE_SEAMS)).toBe(true);
  });
});
