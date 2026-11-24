// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { SHIP_FLAGS } from '../../content/types';
import { miniBattle, miniBattleContext, miniCombat } from '../../testing/combat';
import { DAMAGE_SEAMS } from './damage';
import { startAnimation } from './effects';
import { v3 } from './math';
import { newRandom } from './random';
import { KIND, NO_HOOK, SHIP_STATE, type BattleContext, type BattleState, type CombatSeams, type HookResult, type Torpedo } from './types';
import {
  armSelfDestruct, checkSensors, firedOn, firePhasers, fireTorpedoes, phaserHitChance, raiseShields, setPowerLevel, setSpread, setupWeapons,
  setWeaponsLock, torpedoTurn, updateBeams, updateLamps, updateSelfDestruct, updateTorpedoes, WEAPON_SEAMS,
} from './weapons';

/**
 * The expected values are worked by hand from weapons.cpp and AstroRandom (see damage.test.ts). The battle: the
 * Enterprise at the origin heading 0 (forward is +y), the chodak 5000 ahead at (0, 5000, 0), heading 180, facing it.
 */
function battle(seed: number, scripts: Partial<CombatSeams> = {}, place: (c: ReturnType<typeof miniCombat>) => void = () => {}) {
  const sites: string[] = [];
  const hooks: string[] = [];
  const combat = miniCombat();
  combat.battles[3]!.ships[1]!.position = [0, 5000, 0];
  place(combat);
  const base = miniBattleContext({
    ...WEAPON_SEAMS, ...DAMAGE_SEAMS,
    eventScript: (_c, _b, ship, hook): HookResult => { hooks.push(`${ship.index}:${hook}`); return NO_HOOK; },
    ...scripts,
  }, combat);
  const ctx: BattleContext = { ...base, onDraw: site => { sites.push(site); } };
  const { b } = miniBattle({ ctx });
  b.random = newRandom(seed);
  b.cues.length = 0;
  return { ctx, b, e: b.ships[0]!, chodak: b.ships[1]!, sites, hooks };
}

describe('setupWeapons (weapons.cpp:101-152)', () => {
  it('gives the Enterprise six banks on units 13-18 and others two on 8-9, each charged as its unit is', () => {
    const { e, chodak } = battle(1);
    expect(e.banks.map(bank => [bank.unit, bank.offset, bank.charge, bank.setting, bank.savedSetting])).toEqual([
      [13, v3(0, -20, 210), 100, 100, 100], [14, v3(0, -1, 200), 100, 100, 100], [15, v3(0, 40, 30), 100, 100, 100],
      [16, v3(0, 45, -230), 100, 100, 100], [17, v3(-100, 50, -230), 100, 100, 100], [18, v3(100, 50, -230), 100, 100, 100],
    ]);
    expect(chodak.banks.map(bank => bank.unit)).toEqual([8, 9]);
    const { ctx, b } = battle(1);
    // (a starbase has no phasers; half a unit's charge is 50)
    b.ships[1]!.type = KIND.starbase;
    b.ships[1]!.flags = ctx.combat.kinds[KIND.starbase]!.flags;
    setupWeapons(ctx, b, b.ships[1]!);
    expect(b.ships[1]!.banks).toEqual([]);
    b.ships[0]!.systems.units[13]!.current = 50;
    setupWeapons(ctx, b, b.ships[0]!);
    expect(b.ships[0]!.banks[0]!.charge).toBe(50);
  });

  it('refuses a battle the lifted data can\'t fight, saying why', () => {
    const combat = miniCombat();
    delete combat.animations;
    const ctx = miniBattleContext({ ...WEAPON_SEAMS }, combat);
    expect(() => miniBattle({ ctx })).toThrow("the combat data can't fight a battle: combat.yaml has no animations (lift with --images)");
  });
});

describe('phaserHitChance (weapons.cpp:214-221)', () => {
  it('is worse against a fast or small target, and a little worse far off', () => {
    const { b, e, chodak } = battle(1);
    // (d 5000, speed 0: |1 - 0| = 100)
    expect(phaserHitChance(b, e)).toBe(100);
    // (speed 1000: s = 1; fz = 200 / 2460 * 0.3 + 0.7 = 0.7244, fd = 6255 / 11255 * 0.1 + 0.9 = 0.9556; |1 - |1 - 0.6922|| = 0.6922: 69)
    chodak.speed = 1000;
    expect(phaserHitChance(b, e)).toBe(69);
    // (speed 300: |1 - 0.3 * 0.3078| = 0.9077: 90)
    chodak.speed = 300;
    expect(phaserHitChance(b, e)).toBe(90);
  });
});

describe('firePhasers (weapons.cpp:223-299)', () => {
  it('fires the Enterprise\'s banks whose lamps bear on the target, each a hit or a miss by the chance', () => {
    const { ctx, b, e, chodak, sites, hooks } = battle(1);
    chodak.speed = 1000;
    // (the chodak is ahead: facing 1, kBearing[1] lights banks 1 and 2 and the fore tube)
    expect(b.console.lamps).toEqual([2, 0, 0, 2, 2, 2, 0, 2]);
    firePhasers(ctx, b, e);
    // (bank 1: byte 198, rnd(100) = 77 >= 69, a miss: its offset forward(150, 0x564 - rnd(0xa80), 0x2b2 - rnd(0x564)), bytes 126 and 129:
    // 1380 - 1323 = 57 and 690 - 695 = -5, ending in 1 s. Bank 2: byte 107, 42 < 69, a hit)
    const [, b1, b2] = e.banks;
    expect([b1!.active, b1!.miss, b1!.endTime, b2!.active, b2!.miss]).toEqual([true, true, 11000, true, false]);
    expect(b1!.missOffset.x).toBeCloseTo(3.279, 3);
    expect(b1!.missOffset.y).toBeCloseTo(0.2876, 3);
    expect(b1!.missOffset.z).toBeCloseTo(149.96, 2);
    expect(b1!.beam).toEqual({ frames: '__phaser.spr', frame: 0, frameTime: 103, lastFrame: 10000 });
    expect([e.activeBeams, e.banks.filter(bank => bank.active).length, e.banks.map(bank => bank.lastUpdate)]).toEqual([2, 2, [10000, 10000, 10000, 10000, 10000, 10000]]);
    expect(sites).toEqual(['weapons.cpp:283', 'weapons.cpp:286', 'weapons.cpp:286', 'weapons.cpp:283']);
    // (a miss: Data's 0x1c in 498 ms; the first shot's hook 2 on both; Worf's 0x1e; the phaser sound)
    expect(b.cues.map(c => [c.cue, c.delay])).toEqual([[0x1c, 498], [0x1e, 0]]);
    expect(hooks).toEqual(['0:2', '1:2']);
    expect(b.sounds).toMatchObject([{ sound: '__phaser.mac', ship: 0 }]);
    expect([e.flags & SHIP_STATE.hasFired, chodak.flags & (SHIP_STATE.firedUpon | SHIP_STATE.firedUponNew), b.console.redAlert]).toEqual([SHIP_STATE.hasFired, 3, true]);
    // (not again while a beam is active)
    firePhasers(ctx, b, e);
    expect(sites).toHaveLength(4);
  });

  it('fires another ship\'s fore bank on a target ahead, for a time by the difficulty; Worf readies the Enterprise under Delegate', () => {
    const { ctx, b, e, chodak, hooks } = battle(1);
    b.console.delegate = true;
    firePhasers(ctx, b, chodak);
    // (Worf: the weapons lock, every bank at 100, the salvos at 10, battle stations)
    expect([b.console.weaponsLock, b.console.powerLevel, b.console.salvo.map(s => s.setting)]).toEqual([true, 4, [10, 10]]);
    // (the Enterprise is ahead of the chodak: bank 0. Byte 198: rnd(1 * 0x246) = 450: combatTicks(0x369 + 450) = 4546.
    // Byte 126: rnd(100) = 49 < 100, a hit)
    expect(chodak.banks.map(bank => [bank.active, bank.endTime, bank.miss])).toEqual([[true, 14546, false], [false, 0, false]]);
    expect(hooks).toEqual(['1:0', '1:3', '0:3']);
    expect(b.cues.at(-1)!.cue).toBe(0x1a);
    expect(e.banks.every(bank => bank.setting === 100)).toBe(true);
  });

  it('is unwise on the starbase, which blows the Enterprise up in time; and doesn\'t reach past 11250', () => {
    const { ctx, b, e, chodak, sites } = battle(1);
    chodak.type = KIND.starbase;
    firePhasers(ctx, b, e);
    // (byte 198: rnd(0x369) = 675: combatTicks(0x5af + 675) = 7319)
    expect([e.removeTime, sites[0]]).toEqual([17319, 'weapons.cpp:234']);
    const far = battle(1);
    far.chodak.pos = v3(0, 11251, 0);
    firePhasers(far.ctx, far.b, far.e);
    expect([far.b.cues.map(c => c.cue), far.b.random.draws, far.e.activeBeams]).toEqual([[0x28], 0, 0]);
  });
});

describe('updateBeams (weapons.cpp:301-383)', () => {
  it('drains the Enterprise\'s bank a tick\'s worth a step and, from the fourth frame, hits by distance and speed', () => {
    const { ctx, b, e, chodak, hooks, sites } = battle(3);
    chodak.speed = 1000;
    b.random = newRandom(1);
    firePhasers(ctx, b, e);
    b.random = newRandom(3);
    hooks.length = 0;
    const bank = e.banks[2]!;
    // (one frame short of the fourth, which this step reaches)
    Object.assign(bank.beam, { frame: 3, lastFrame: 9900 });
    b.now = 10066;
    updateBeams(ctx, b, e);
    // (66 ms is millisToTicks 19.206 ticks: (int)(19.206 * 0.057214f) = 1, at least 1: charge and setting 99, the unit (int)(0.99f * 100) = 99)
    expect([bank.charge, bank.setting, e.systems.units[15]!.current, bank.beam.frame]).toEqual([99, 99, 99, 4]);
    // (chance (int)((18000 - 5000) / 18000 * (6000 - 1000) / 6000 * 100) = 60; byte 83: rnd(100) = 32, a hit.
    // raw (int)min(10 * 19.206 * 0.057214f, 99) = 10; k = (int)(6250 / 714 + 6.75f) = 14: 14 * 14 * 10 / 250 = 7 on shield 1.
    // The flash's impact isn't placed until updateEffects: the tip runs to (0, 0, 0), from bank 2 at (0, 30, -40); in the model's axes (0, -40, -30))
    expect(chodak.systems.units[1]!.current).toBe(93);
    expect(chodak.log).toEqual(['Shield -Unit 1- holding at 69.72']);
    expect(chodak.shieldFlash.frames).toBe('__shield.spr');
    expect(bank.tip).toEqual({ x: 0, y: -40, z: -30 });
    expect([bank.lastUpdate, b.random.draws, hooks]).toEqual([10066, 2, ['1:5']]);
    // (the hit's roll, then the shield's shaking (byte 195: 76, not under (int)((80 - 93) * 0.3125 + 25) = 20))
    expect(sites.slice(4)).toEqual(['weapons.cpp:360', 'damage.cpp:207']);
    // (the miss ends at its time, its setting back as it was)
    const missed = e.banks[1]!;
    b.now = 11000;
    updateBeams(ctx, b, e);
    expect(missed.active).toBe(true);
    b.now = 11001;
    updateBeams(ctx, b, e);
    expect([missed.active, missed.setting, e.activeBeams]).toEqual([false, 100, 1]);
  });

  it('ends another ship\'s volley at its time, emptying the unit; and stops every beam when the target is gone', () => {
    const { ctx, b, e, chodak } = battle(1);
    firePhasers(ctx, b, chodak);
    b.now = 14546;
    updateBeams(ctx, b, chodak);
    expect(chodak.banks[0]!.active).toBe(true);
    b.now = 14547;
    updateBeams(ctx, b, chodak);
    expect([chodak.banks[0]!.active, chodak.systems.units[8]!.current, chodak.activeBeams]).toEqual([false, 0, 0]);
    firePhasers(ctx, b, e);
    chodak.destroyed = true;
    updateBeams(ctx, b, e);
    expect([e.activeBeams, e.banks.some(bank => bank.active)]).toEqual([0, false]);
  });
});

describe('fireTorpedoes (weapons.cpp:385-472)', () => {
  it('fires the fore tube\'s salvo at a target ahead, each torpedo from the pool with its own jitter, frame and launch delay', () => {
    const { ctx, b, e, sites, hooks } = battle(1);
    // (setup loaded each tube from its unit: 100 of 100 is 10)
    expect(b.console.salvo).toEqual([{ loaded: 10, setting: 10 }, { loaded: 10, setting: 10 }]);
    fireTorpedoes(ctx, b, e, 0);
    expect([b.console.salvo[0].loaded, e.systems.units[19]!.current, b.torpedoes.filter(t => t.active).length]).toEqual([0, 90, 10]);
    // (torpedo 0: bytes 198, 126, 129 place it at rnd(3) = 2, 1, 2; byte 107, rnd(3) = 1, so byte 75 picks the frame, 1;
    // byte 251, rnd(0x1e) = 29, but the first launches at once. Without the weapons lock, it homes after combatTicks(400) = 1374)
    expect(b.torpedoes[0]).toEqual({
      active: true, lock: false, speed: 525, frame: 1, homingDistance: 2500, launchTime: 10000, homingTime: 11374, expiry: 50030,
      pos: v3(2, 1, 2), angles: [0, 0, 0], shooter: 0, target: 1,
    });
    // (torpedo 1: bytes 226, 251, 84: 3, 3, 1; byte 246, 3, then 189: frame 2; byte 223: rnd(0x1e) = 26, combatTicks(66) = 226 after)
    expect(b.torpedoes[1]).toMatchObject({ pos: v3(3, 3, 1), frame: 2, launchTime: 10226 });
    expect(sites.slice(0, 12).map(s => s.slice(12))).toEqual(['453', '453', '453', '459', '460', '464', '453', '453', '453', '459', '460', '464']);
    expect(b.cues.map(c => [c.cue, c.delay])).toEqual([[0x22, 498]]);
    expect([hooks, b.sounds]).toMatchObject([['0:2', '1:2'], [{ sound: '__photon.mac', ship: 0 }]]);
  });

  it('spreads a salvo across the spread setting, locks with the weapons lock, and says so when there\'s nothing to fire or the target is too close', () => {
    const { ctx, b, e } = battle(1);
    b.console.weaponsLock = true;
    // (cell 9: 45 degrees, 2070: from -1035 by 2070 / 9 = 230)
    b.console.spread = 2070;
    fireTorpedoes(ctx, b, e, 0);
    expect(b.torpedoes.slice(0, 10).map(t => t.angles[0])).toEqual([-1035, -805, -575, -345, -115, 115, 345, 575, 805, 1035].map(a => a & 0x3fff));
    expect([b.torpedoes[0]!.lock, b.torpedoes[0]!.homingTime]).toEqual([true, 12000]);
    b.cues.length = 0;
    b.console.salvo[1].loaded = 0;
    fireTorpedoes(ctx, b, e, 0);
    expect(b.cues.map(c => c.cue)).toEqual([0x20]);
    const close = battle(1);
    close.chodak.pos = v3(0, 999, 0);
    fireTorpedoes(close.ctx, close.b, close.e, 0);
    expect(close.b.cues.map(c => c.cue)).toEqual([0x27]);
  });

  it('fires another ship\'s two to 2 + 2 * difficulty from its own store, from a loaded tube', () => {
    const { ctx, b, chodak } = battle(1);
    fireTorpedoes(ctx, b, chodak, 0);
    // (byte 198: rnd(2) = 2: 4 torpedoes from 275)
    expect([chodak.systems.torpedoes, b.torpedoes.filter(t => t.active).length, b.cues[0]!.cue]).toEqual([271, 4, 0x1a]);
    chodak.systems.units[10]!.current = 0;
    const draws = b.random.draws;
    fireTorpedoes(ctx, b, chodak, 0);
    expect(b.random.draws).toBe(draws);
  });
});

describe('updateTorpedoes (weapons.cpp:474-577)', () => {
  it('turns a torpedo at most 0x2b2 or 0x422 a step (torpedoTurn, weapons.cpp:474-481)', () => {
    expect([100, 0x16f, 0x170, 0x1000, 0x1001, 0x2000, 0x2001, 0x3000, 0x3fff].map(torpedoTurn)).toEqual([100, 0x16f, 0x2b2, 0x2b2, 0x422, 0x422, -0x422, -0x2b2, -1]);
  });

  it('flies a torpedo until it reaches its target, which repels it', () => {
    const { ctx, b, e, chodak, sites } = battle(1);
    chodak.pos = v3(0, 1000, 0);
    Object.assign(b.torpedoes[0]!, { active: true, lock: false, speed: 525, launchTime: 10000, expiry: 50030, pos: v3(), angles: [0, 0, 0], shooter: 0, target: 1 });
    // (34.65 a step: after 22 steps it's 237 off; after 23, (int)(1000 - 796.95) = 203, under 525 and within 34.65 + the radius of 200)
    let steps = 0;
    while (b.torpedoes[0]!.active && steps < 30) {
      b.now += 66;
      updateTorpedoes(ctx, b);
      steps++;
    }
    expect(steps).toBe(23);
    // (the chodak explodes (bytes 198, 126), Worf's 0x21; the Enterprise faces it on shield 1; repelled)
    expect(sites).toEqual(['damage.cpp:417', 'damage.cpp:418']);
    expect(chodak.log).toEqual(['Photon torpedo repelled by -Unit 1-']);
    expect(chodak.systems.units[1]!.current).toBe(75);
    expect(b.cues.map(c => c.cue)).toContain(0x21);
    expect(e.log).toEqual([]);
  });

  it('waits for its launch, expires, and homes a locked torpedo in, faster, by at most a turn a step', () => {
    const { ctx, b, chodak } = battle(1);
    chodak.pos = v3(500, 1000, 0);
    const t = b.torpedoes[0]!;
    Object.assign(t, { active: true, lock: true, speed: 525, launchTime: 10100, expiry: 10500, homingTime: 0, homingDistance: 0, pos: v3(), angles: [0, 0, 0], shooter: 0, target: 1 });
    b.now = 10066;
    updateTorpedoes(ctx, b);
    expect(t.pos).toEqual(v3());
    b.now = 10132;
    updateTorpedoes(ctx, b);
    // (525 + 15, then + 30; the chodak about 1246 to starboard, more than 0x170 off: a turn of 0x2b2; within 0x564, so it keeps its lock)
    expect([t.speed, t.angles, t.lock]).toEqual([570, [0x2b2, 0, 0], true]);
    expect(b.cues.map(c => c.cue)).toEqual([0x25]);
    b.now = 10501;
    updateTorpedoes(ctx, b);
    expect([t.active, b.cues.at(-1)!.cue]).toEqual([false, 0x1f]);
  });

  it('looks for another target when well off course under the weapons lock, and drops its lock when there is none', () => {
    const { ctx, b } = battle(1, {}, combat => {
      combat.battles[3]!.ships[1]!.position = [5000, 0, 0];
      combat.battles[3]!.ships.push({ ...combat.battles[3]!.ships[1]!, object: 'space.other', position: [0, 5000, 0] });
    });
    b.console.weaponsLock = true;
    const t = b.torpedoes[0]!;
    Object.assign(t, { active: true, lock: true, speed: 525, launchTime: 0, expiry: 99999, homingTime: 0, homingDistance: 0, pos: v3(), angles: [0, 0, 0], shooter: 0, target: 1 });
    b.now = 10066;
    updateTorpedoes(ctx, b);
    // (ship 1 is 0x1000 off to starboard; ship 2 dead ahead, within 0x564 either way)
    expect([t.target, t.lock, b.cues.at(-1)!.cue]).toEqual([2, true, 0x26]);
    const lone = battle(1, {}, combat => { combat.battles[3]!.ships[1]!.position = [5000, 0, 0]; });
    lone.b.console.weaponsLock = true;
    Object.assign(lone.b.torpedoes[0]!, { active: true, lock: true, speed: 525, launchTime: 0, expiry: 99999, homingTime: 0, homingDistance: 0, pos: v3(), angles: [0, 0, 0], shooter: 0, target: 1 });
    lone.b.now = 10066;
    updateTorpedoes(lone.ctx, lone.b);
    expect([lone.b.torpedoes[0]!.target, lone.b.torpedoes[0]!.lock]).toEqual([1, false]);
  });
});

describe('the console (weapons.cpp:579-750)', () => {
  it('locks the weapons on: every whole phaser and tube charges in full, and the target\'s hook 0 runs; not with nobody to fight', () => {
    const { ctx, b, e, hooks } = battle(1);
    e.systems.units[14]!.damage = 3;
    for (const i of [13, 14, 19]) e.systems.units[i]!.target = 0;
    setWeaponsLock(ctx, b, true);
    expect(b.console.weaponsLock).toBe(true);
    expect(e.systems.units[13]).toMatchObject({ target: 100, aiTarget: 100, aiCap: 100 });
    expect(e.systems.units[19]).toMatchObject({ target: 100, aiTarget: 100, aiCap: 100 });
    expect(e.systems.units[14]!.target).toBe(0);
    expect([b.cues, hooks]).toEqual([[{ cue: 0x1b, delay: 0, interrupt: false, after: true }], ['1:0']]);
    setWeaponsLock(ctx, b, false);
    expect(b.console.weaponsLock).toBe(false);
    b.ships[1]!.removed = true;
    setWeaponsLock(ctx, b, true);
    expect([b.console.weaponsLock, b.cues.at(-1)!.cue]).toEqual([false, 0x6b]);
  });

  it('raises the shields to full; lowering them only says so (weapons.cpp:632)', () => {
    const { ctx, b, e } = battle(1);
    for (let i = 0; i < 8; i++) e.systems.units[i]!.target = 10;
    e.systems.units[3]!.damage = 1;
    raiseShields(ctx, b, true);
    expect(e.systems.units.slice(0, 8).map(u => u.target)).toEqual([100, 100, 100, 10, 100, 100, 100, 100]);
    expect(e.log).toEqual(['Shields raised to 100%']);
    expect(b.cues.map(c => [c.cue, !!c.after])).toEqual([[0x18, false], [0x60, true]]);
    raiseShields(ctx, b, false);
    expect([b.console.shieldsRaised, e.systems.units[0]!.target, b.cues.at(-1)!.cue]).toEqual([false, 100, 0x61]);
  });

  it('sets Delegate\'s power from the level\'s preset, and at battle stations fills the shields at once the first time', () => {
    const { ctx, b, e } = battle(1);
    setPowerLevel(ctx, b, 2, false);
    // (miniCombat's made-up level 2 gives each unit 20)
    expect([e.systems.units[5]!.aiTarget, e.systems.units[5]!.aiCap, b.console.powerLevel, b.cues.at(-1)!.cue]).toEqual([20, 20, 2, 2]);
    setPowerLevel(ctx, b, 2, false);
    expect(b.cues).toHaveLength(1);
    e.systems.units[0]!.current = 10;
    setPowerLevel(ctx, b, 4, false);
    expect(e.systems.units[0]).toMatchObject({ current: 100, target: 100, aiTarget: 100, aiCap: 0 });
    // (Data: shields up in combatTicks(0x1b4) = 1498, raised in combatTicks(0x2d7) = 2498; then 4)
    expect(b.cues.slice(1).map(c => [c.cue, c.delay])).toEqual([[0x18, 1498], [0x60, 2498], [4, 0]]);
    expect([b.console.shieldsRaised, b.console.shieldsFilled]).toEqual([true, true]);
    e.systems.units[0]!.current = 10;
    setPowerLevel(ctx, b, 4, true);
    // (filled once already, and forced: no refill and no cues)
    expect([e.systems.units[0]!.current, b.cues.length]).toEqual([10, 4]);
  });

  it('spreads torpedoes 5 degrees a cell, 0x2e units a degree', () => {
    const { ctx, b } = battle(1);
    setSpread(ctx, b, 9);
    expect([b.console.spreadDegrees, b.console.spread, b.cues.at(-1)!.cue]).toEqual([45, 2070, 0x23]);
    setSpread(ctx, b, 4);
    expect([b.console.spread, b.cues.length]).toEqual([920, 1]);
    setSpread(ctx, b, 0);
    expect([b.console.spread, b.cues.map(c => c.cue)]).toEqual([0, [0x23, 0x24]]);
  });

  it('arms self-destruct for 20 s and disarms it; counts down; and at zero destroys the Enterprise, taking the target only from the CONN page', () => {
    const { ctx, b, e, chodak } = battle(1);
    armSelfDestruct(ctx, b);
    // (combatTicks(0x16bc) = 20000; the computer in combatTicks(0x246) = 2000)
    expect([b.console.selfDestructTime, b.cues.at(-1)]).toEqual([30000, { cue: 0x55, delay: 2000, interrupt: true }]);
    armSelfDestruct(ctx, b);
    expect([b.console.selfDestructTime, b.cues.at(-1)!.cue]).toEqual([0, 0x56]);
    armSelfDestruct(ctx, b);
    b.cues.length = 0;
    // (15 s left: 0x58 in combatTicks(0x123) = 1000; 12 s: nothing; 10.5 s: 0x57; 5 s: 0x59)
    for (const left of [15000, 12000, 10500, 5000]) {
      b.now = 30000 - left;
      updateSelfDestruct(ctx, b);
    }
    expect(b.cues.map(c => [c.cue, c.delay])).toEqual([[0x58, 1000], [0x57, 0], [0x59, 0]]);
    b.now = 30000;
    updateSelfDestruct(ctx, b);
    expect([e.destroyed, b.console.selfDestructTime, chodak.systems.units[1]!.current]).toEqual([true, 30000, 100]);
    const conn = battle(1);
    conn.chodak.pos = v3(0, 4000, 0);
    conn.b.console.connPage = true;
    armSelfDestruct(conn.ctx, conn.b);
    conn.b.now = 30000;
    updateSelfDestruct(conn.ctx, conn.b);
    // (the blast: half of 4000 is 2000, 8294 on the chodak's shield the Enterprise faces, 1)
    expect([conn.e.destroyed, conn.b.console.selfDestructTime, conn.chodak.systems.units[1]!.current]).toEqual([true, 0, 0]);
    expect(conn.chodak.log[0]).toBe('Shield -Unit 1- penetrated.');
  });

  it('lights the lamps of the weapons that bear on the target, and marks the damaged ones', () => {
    const { ctx, b, e, chodak } = battle(1);
    e.systems.units[13]!.damage = 1;
    e.systems.units[20]!.damage = 1;
    updateLamps(ctx, b);
    expect([b.console.targetFacing, b.console.lamps]).toEqual([1, [1, 0, 0, 2, 2, 2, 0, 1]]);
    // (behind: facing 6, kBearing[6] is banks 0 and 3 and the aft tube)
    chodak.pos = v3(0, -5000, 0);
    updateLamps(ctx, b);
    expect([b.console.targetFacing, b.console.lamps]).toEqual([6, [1, 2, 2, 0, 2, 2, 2, 1]]);
    b.target = null;
    updateLamps(ctx, b);
    expect(b.console.lamps).toEqual([2, 2, 2, 2, 2, 2, 2, 2]);
  });

  it('checks the sensors every 10 s; below 40% the radar shows the ships only on a roll, and below 30% the lock goes', () => {
    const { ctx, b, e } = battle(1);
    // (full sensors: reliable, no roll; next check in combatTicks(0xb5e) = 10000)
    expect([checkSensors(ctx, b), b.console.sensorQuality, b.console.sensorCheckTime, b.random.draws]).toEqual([true, 100, 20000, 0]);
    for (let i = 8; i <= 12; i++) e.systems.units[i]!.current = 35;
    expect(checkSensors(ctx, b)).toBe(true);
    b.now = 20000;
    // (35%: unreliable, damaged; byte 198: rnd(100) = 77, not under 35)
    expect([checkSensors(ctx, b), b.console.sensorQuality, b.console.sensorsDamaged, b.random.draws]).toEqual([false, 35, true, 1]);
    // (before the next check it rolls again: byte 126, 49, not under 35)
    expect(checkSensors(ctx, b)).toBe(false);
    b.console.weaponsLock = true;
    for (let i = 8; i <= 12; i++) e.systems.units[i]!.current = 10;
    b.now = 30000;
    // (10% is under 15: 0, blank, and the lock goes; byte 129, 50, not under 0)
    expect([checkSensors(ctx, b), b.console.sensorQuality, b.console.sensorsBlank, b.console.weaponsLock]).toEqual([false, 0, true, false]);
  });
});

describe('every branch of the phaser banks (weapons.cpp:101-383)', () => {
  it('charges a bank of a unit with no maximum at 0 (weapons.cpp:123)', () => {
    const { ctx, b, e } = battle(1);
    e.systems.units[13]!.max = 0;
    setupWeapons(ctx, b, e);
    expect([e.banks[0]!.charge, e.banks[0]!.setting, e.banks[0]!.savedSetting]).toEqual([0, 0, 0]);
  });

  it('runs the first-shot hooks once; a ship that fires is no longer friendly, and its target is newly fired on only the first time', () => {
    const { ctx, b, e, chodak, hooks } = battle(1);
    e.flags |= SHIP_FLAGS.friendly;
    firedOn(ctx, b, e, chodak);
    expect([hooks, e.flags & (SHIP_FLAGS.friendly | SHIP_STATE.hasFired), chodak.flags & 3, b.console.redAlert]).toEqual([['0:2', '1:2'], SHIP_STATE.hasFired, 3, true]);
    firedOn(ctx, b, e, chodak);
    expect([hooks, chodak.flags & 3]).toEqual([['0:2', '1:2'], SHIP_STATE.firedUpon]);
    // (a second target: no hook, the shooter's first shot is gone)
    const two = battle(1, {}, c => { c.battles[3]!.ships.push({ ...c.battles[3]!.ships[1]!, object: 'space.chodak2', position: [0, -5000, 0] }); });
    firedOn(two.ctx, two.b, two.e, two.chodak);
    firedOn(two.ctx, two.b, two.e, two.b.ships[2]!);
    expect([two.hooks, two.b.ships[2]!.flags & 3]).toEqual([['0:2', '1:2'], 3]);
  });

  it('doesn\'t fire from a dead, dying, unarmed or busy ship, on a dead target, or either cloaked; nor rolls', () => {
    const cases: [string, (t: ReturnType<typeof battle>) => void][] = [
      ['destroyed', t => { t.e.destroyed = true; }],
      ['dying', t => { t.e.flags |= SHIP_STATE.dying; }],
      ['unarmed', t => { t.e.flags &= ~SHIP_FLAGS.phasers; }],
      ['busy', t => { t.e.activeBeams = 1; }],
      ['no target', t => { t.e.target = null; }],
      ['target dead', t => { t.chodak.destroyed = true; }],
      ['target cloaked', t => { t.chodak.decloakTime = 20000; }],
      ['cloaked', t => { t.e.decloakTime = 20000; }],
    ];
    for (const [name, set] of cases) {
      const t = battle(1);
      set(t);
      firePhasers(t.ctx, t.b, t.e);
      expect([name, t.b.random.draws, t.e.banks.some(bank => bank.active), t.b.cues, t.b.console.redAlert]).toEqual([name, 0, false, [], false]);
    }
  });

  it('keeps the setting a bank fires at, to go back to', () => {
    const { ctx, b, e } = battle(1);
    e.banks[2]!.setting = 60;
    firePhasers(ctx, b, e);
    expect([e.banks[2]!.active, e.banks[2]!.savedSetting]).toEqual([true, 60]);
  });

  it('fires no bank that is empty, set to 0 or off its lamp, and then says nothing; an active bank is passed over', () => {
    const { ctx, b, e, hooks } = battle(1);
    e.banks[1]!.charge = 0;
    e.banks[2]!.setting = 0;
    firePhasers(ctx, b, e);
    // (banks 1 and 2 bear but can't fire; the others' lamps are 2. Red alert all the same)
    expect([b.random.draws, e.activeBeams, hooks, b.cues, b.sounds, b.console.redAlert]).toEqual([0, 0, [], [], [], true]);
    // (a bank still active, as a step's activeBeams of 0 can't leave one: passed over, its lastUpdate untouched)
    e.banks[1]!.charge = 100;
    Object.assign(e.banks[1]!, { active: true, lastUpdate: 5 });
    b.now = 10066;
    firePhasers(ctx, b, e);
    // (bank 1 passed over; bank 2 still set to 0, stamped though it doesn't fire)
    expect([e.banks[1]!.lastUpdate, e.banks[2]!.active, e.banks[2]!.lastUpdate, b.random.draws]).toEqual([5, false, 10066, 0]);
  });

  it('rolls rnd(0) for an Ensign\'s enemy\'s volley, which is 0 but a draw (weapons.cpp:277, a quirk kept); a weak bank doesn\'t fire', () => {
    const { ctx, b, chodak, sites } = battle(1);
    b.difficulty = 0;
    firePhasers(ctx, b, chodak);
    // (byte 198: rnd(0) = 0: combatTicks(0x369) = 3000. Byte 126: rnd(100) = 49 < 100, a hit)
    expect([sites, chodak.banks[0]!.endTime, chodak.banks[0]!.miss]).toEqual([['weapons.cpp:277', 'weapons.cpp:283'], 13000, false]);
    const weak = battle(1);
    weak.chodak.systems.units[8]!.current = 25;
    firePhasers(weak.ctx, weak.b, weak.chodak);
    // (bank 0 at 25 and bank 1 not fore: nothing fires, no hook, no cue)
    expect([weak.b.random.draws, weak.chodak.activeBeams, weak.hooks, weak.b.cues]).toEqual([0, 0, [], []]);
  });

  it('a miss by another ship has no cue from Data', () => {
    // (the chance is 69, as phaserHitChance's test works it: the Enterprise is as big. Seed 3: byte 83,
    // rnd(0x246) = (83 * 582 + 128) >> 8 = 189; byte 195, rnd(100) = 76 >= 69, a miss; bytes 125 and 120 for the offset,
    // ending in combatTicks(0x123) = 1000)
    const m = battle(3);
    m.e.speed = 1000;
    firePhasers(m.ctx, m.b, m.chodak);
    expect([m.sites, m.chodak.banks[0]!.miss, m.chodak.banks[0]!.endTime, m.b.cues.map(c => c.cue)]).toEqual([
      ['weapons.cpp:277', 'weapons.cpp:283', 'weapons.cpp:286', 'weapons.cpp:286'], true, 11000, [0x1a],
    ]);
  });

  it('pins the starbase\'s roll before the banks\', and rolls it once; the starbase engages beyond phaser range, others don\'t', () => {
    const { ctx, b, e, chodak, sites } = battle(1);
    chodak.type = KIND.starbase;
    firePhasers(ctx, b, e);
    // (byte 198 for the starbase; bytes 126 and 129: 49 and 50, both under 100, both hits)
    expect(sites).toEqual(['weapons.cpp:234', 'weapons.cpp:283', 'weapons.cpp:283']);
    // (rnd(100) is from 0 to 100, inclusive: byte 255 is 100, a miss at a chance of 100. Seed 2: 140 for the starbase,
    // then 33 (13, a hit) and 255 (a miss, with bytes 114 and 237 for its offset))
    const sure = battle(2);
    sure.chodak.type = KIND.starbase;
    firePhasers(sure.ctx, sure.b, sure.e);
    expect([sure.e.banks[1]!.miss, sure.e.banks[2]!.miss, sure.sites]).toEqual([
      false, true, ['weapons.cpp:234', 'weapons.cpp:283', 'weapons.cpp:283', 'weapons.cpp:286', 'weapons.cpp:286'],
    ]);
    const again = battle(1);
    again.chodak.type = KIND.starbase;
    again.e.removeTime = 99;
    firePhasers(again.ctx, again.b, again.e);
    expect([again.e.removeTime, again.sites]).toEqual([99, ['weapons.cpp:283', 'weapons.cpp:283']]);
    // (a starbase shooting: it says so, and fires though the Enterprise is 11251 off; the Enterprise isn't told 0x28)
    const base = battle(1);
    // (a made-up armed starbase: the lifted one has no phasers, so no starbase reaches this)
    base.ctx.combat.kinds[KIND.starbase]!.effects = { ...base.ctx.combat.kinds[KIND.chodak]!.effects };
    base.chodak.type = KIND.starbase;
    base.chodak.pos = v3(0, 11251, 0);
    firePhasers(base.ctx, base.b, base.chodak);
    expect([base.chodak.log, base.chodak.banks[0]!.active, base.b.cues.map(c => c.cue)]).toEqual([['Engaging auto-defenses.'], true, [0x1a]]);
    const far = battle(1);
    far.chodak.pos = v3(0, 11251, 0);
    firePhasers(far.ctx, far.b, far.chodak);
    expect([far.b.random.draws, far.b.cues, far.chodak.log]).toEqual([0, [], []]);
  });

  it('Worf readies only what isn\'t ready: the lock without the power at battle stations, and nothing once both are', () => {
    const { ctx, b, e, hooks } = battle(1);
    Object.assign(b.console, { delegate: true, powerLevel: 4 });
    e.banks[0]!.setting = 50;
    firePhasers(ctx, b, b.ships[1]!);
    // (the lock's 0x1b and hook 0; no setPowerLevel, so no shields cues; then the volley's 0x1a)
    expect([b.console.weaponsLock, e.banks[0]!.setting, b.console.salvo.map(s => s.setting), b.cues.map(c => c.cue), hooks]).toEqual([
      true, 100, [10, 10], [0x1b, 0x1a], ['1:0', '1:3', '0:3'],
    ]);
    const ready = battle(1);
    Object.assign(ready.b.console, { delegate: true, powerLevel: 4, weaponsLock: true });
    ready.e.banks[0]!.setting = 50;
    for (const salvo of ready.b.console.salvo) salvo.setting = 3;
    firePhasers(ready.ctx, ready.b, ready.chodak);
    expect([ready.e.banks[0]!.setting, ready.b.console.salvo.map(s => s.setting), ready.b.cues.map(c => c.cue), ready.hooks]).toEqual([
      50, [3, 3], [0x1a], ['1:3', '0:3'],
    ]);
  });

  it('stops every beam when either ship is dying or cloaked, restoring only the Enterprise\'s settings', () => {
    const cases: [string, (t: ReturnType<typeof battle>) => void][] = [
      ['target dying', t => { t.chodak.flags |= SHIP_STATE.dying; }],
      ['dying', t => { t.e.flags |= SHIP_STATE.dying; }],
      ['target cloaked', t => { t.chodak.decloakTime = 20000; }],
      ['cloaked', t => { t.e.decloakTime = 20000; }],
    ];
    for (const [name, set] of cases) {
      const t = battle(1);
      firePhasers(t.ctx, t.b, t.e);
      t.e.banks[2]!.setting = 40;
      set(t);
      updateBeams(t.ctx, t.b, t.e);
      expect([name, t.e.activeBeams, t.e.banks[2]!.active, t.e.banks[2]!.beam.frames, t.e.banks[2]!.setting, t.b.random.draws]).toEqual([name, 0, false, null, 100, 2]);
    }
    const { ctx, b, chodak } = battle(1);
    firePhasers(ctx, b, chodak);
    chodak.banks[0]!.setting = 7;
    chodak.flags |= SHIP_STATE.dying;
    updateBeams(ctx, b, chodak);
    expect([chodak.activeBeams, chodak.banks[0]!.active, chodak.banks[0]!.setting]).toEqual([0, false, 7]);
  });
});

/** The brief's volley (seed 1, the chodak at 1000: bank 1 a miss, bank 2 a hit), bank 2 one frame short of the fourth, 66 ms on. */
function volley(seed: number, frame = 3) {
  const t = battle(1);
  t.chodak.speed = 1000;
  firePhasers(t.ctx, t.b, t.e);
  t.b.random = newRandom(seed);
  t.sites.length = 0;
  Object.assign(t.e.banks[2]!.beam, { frame, lastFrame: 9900 });
  t.b.now = 10066;
  return { ...t, bank: t.e.banks[2]! };
}

describe('every branch of updateBeams (weapons.cpp:301-383)', () => {
  it('ends the Enterprise\'s volley when the bank or its setting runs out, its setting back as it was; an empty unit stays empty', () => {
    const empty = volley(3);
    empty.bank.charge = 1;
    updateBeams(empty.ctx, empty.b, empty.e);
    // (k = 1: the charge 0, the unit (int)(0 / 100.0f * 100) = 0)
    expect([empty.bank.active, empty.bank.beam.frames, empty.bank.charge, empty.bank.setting, empty.e.systems.units[15]!.current, empty.e.activeBeams, empty.b.random.draws])
      .toEqual([false, null, 0, 100, 0, 1, 0]);
    const set = volley(3);
    set.bank.setting = 1;
    updateBeams(set.ctx, set.b, set.e);
    expect([set.bank.active, set.bank.charge, set.bank.setting]).toEqual([false, 99, 100]);
    // (30 ms is 8.73 ticks: (int)(8.73 * 0.057214f) = 0, at least 1)
    const soon = volley(1);
    soon.b.now = 10030;
    updateBeams(soon.ctx, soon.b, soon.e);
    expect([soon.bank.charge, soon.bank.setting]).toEqual([99, 99]);
    const unit = volley(1);
    unit.e.systems.units[15]!.current = 0;
    updateBeams(unit.ctx, unit.b, unit.e);
    expect([unit.bank.active, unit.bank.charge, unit.e.systems.units[15]!.current]).toEqual([true, 99, 0]);
  });

  it('misses on the roll: no hit, and the tip runs to the target; a miss\'s tip runs past it', () => {
    const { ctx, b, e, chodak, bank, sites } = volley(1);
    // (the miss at its fourth frame too: it never rolls to hit)
    Object.assign(e.banks[1]!.beam, { frame: 3, lastFrame: 9900 });
    updateBeams(ctx, b, e);
    expect(e.banks[1]!.beam.frame).toBe(4);
    // (byte 198: rnd(100) = 77, not under 60. From bank 2 at (0, 30, -40) to (0, 5000, 0): (0, 4970, 40), in the model's axes (0, -40, 4970))
    expect([sites, chodak.systems.units[1]!.current, chodak.shieldFlash.frames, bank.tip]).toEqual([['weapons.cpp:360'], 100, null, { x: 0, y: -40, z: 4970 }]);
    // (bank 1, from (0, 200, 1), to the target and the offset (3.279, 0.2876, 149.96) as (3.279, 149.96, -0.2876): (3.279, 4949.96, -1.2876),
    // in the model's axes (3.279, 1.2876, 4949.96))
    const tip = e.banks[1]!.tip;
    expect([tip.x, tip.y, tip.z].map(n => Math.round(n * 100) / 100)).toEqual([3.28, 1.29, 4949.96]);
  });

  it('flashes the shield only on the fourth frame, and then the tip runs to the target', () => {
    const { ctx, b, e, chodak, bank, sites } = volley(3, 4);
    updateBeams(ctx, b, e);
    // (frame 5: the same hit as the fourth's, byte 83 and 195, without the flash)
    expect([bank.beam.frame, sites, chodak.systems.units[1]!.current, chodak.shieldFlash.frames, bank.tip]).toEqual([
      5, ['weapons.cpp:360', 'damage.cpp:207'], 93, null, { x: 0, y: -40, z: 4970 },
    ]);
  });

  it('stops at once when a hit ends the battle', () => {
    const { ctx, b, e, bank } = volley(3);
    b.exitCode = 0;
    updateBeams(ctx, b, e);
    // (the hit, as the fourth frame's above: its two rolls, then no tip and no stamp)
    expect([bank.lastUpdate, bank.tip, b.random.draws]).toEqual([10000, { x: 0, y: 0, z: 0 }, 2]);
  });

  it('moves no tip when the phaser model has no vertices in its first part, or there is no phaser model (weapons.cpp:379)', () => {
    const bare = volley(1);
    bare.ctx.combat.models['phaser.3dv']!.vertices = [0, 3];
    updateBeams(bare.ctx, bare.b, bare.e);
    expect([bare.bank.tip, bare.bank.lastUpdate]).toEqual([{ x: 0, y: 0, z: 0 }, 10066]);
    const none = volley(1);
    none.ctx.combat.effects.phaser = null;
    updateBeams(none.ctx, none.b, none.e);
    expect(none.bank.tip).toEqual({ x: 0, y: 0, z: 0 });
  });
});

describe('every branch of the console (weapons.cpp:579-750)', () => {
  it('keeps the lock from 30%, rolls the radar against the quality, and checks nothing for a lost Enterprise', () => {
    const { ctx, b, e, sites } = battle(1);
    for (let i = 8; i <= 12; i++) e.systems.units[i]!.current = 35;
    b.console.weaponsLock = true;
    b.random = newRandom(13);
    // (35%: damaged, the lock kept; byte 18: rnd(100) = 7, under 35)
    expect([checkSensors(ctx, b), b.console.sensorsDamaged, b.console.sensorsBlank, b.console.weaponsLock, sites]).toEqual([true, true, false, true, ['weapons.cpp:602']]);
    // (back to full: reliable again, the marks cleared)
    for (let i = 8; i <= 12; i++) e.systems.units[i]!.current = 100;
    b.now = 20000;
    expect([checkSensors(ctx, b), b.console.sensorsDamaged, b.console.sensorQuality, sites.length]).toEqual([true, false, 100, 1]);
    // (32%: seed 3's byte 83 is rnd(100) = 32, not under 32)
    const at = battle(3);
    for (let i = 8; i <= 12; i++) at.e.systems.units[i]!.current = 32;
    expect([checkSensors(at.ctx, at.b), at.b.console.sensorQuality]).toEqual([false, 32]);
    const lost = battle(1);
    lost.e.destroyed = true;
    Object.assign(lost.b.console, { sensorsReliable: false, sensorQuality: 50 });
    // (no check; byte 198: 77, not under 50)
    expect([checkSensors(lost.ctx, lost.b), lost.b.console.sensorCheckTime, lost.b.random.draws]).toEqual([false, 0, 1]);
  });

  it('rounds the sensors up from 76% and down below 15%, trusts them from 40% and drops the lock below 30%', () => {
    const rows = [76, 75, 40, 39, 30, 29, 15, 14].map(q => {
      const { ctx, b, e } = battle(1);
      for (let i = 8; i <= 12; i++) e.systems.units[i]!.current = q;
      b.console.weaponsLock = true;
      checkSensors(ctx, b);
      const c = b.console;
      return [q, c.sensorQuality, c.sensorsReliable, c.weaponsLock, c.sensorsDamaged, c.sensorsBlank];
    });
    expect(rows).toEqual([
      [76, 100, true, true, false, false], [75, 75, true, true, false, false], [40, 40, true, true, false, false],
      [39, 39, false, true, true, false], [30, 30, false, true, true, false], [29, 29, false, false, true, false],
      [15, 15, false, false, true, false], [14, 0, false, false, false, true],
    ]);
  });

  it('locks on without a hook when there is no target, and not at all for a lost Enterprise', () => {
    const { ctx, b, hooks } = battle(1);
    b.target = null;
    setWeaponsLock(ctx, b, true);
    expect([b.console.weaponsLock, b.cues.map(c => c.cue), hooks]).toEqual([true, [0x1b], []]);
    const lost = battle(1);
    lost.e.destroyed = true;
    setWeaponsLock(lost.ctx, lost.b, true);
    expect([lost.b.console.weaponsLock, lost.b.cues.map(c => c.cue)]).toEqual([false, [0x6b]]);
  });

  it('without an Enterprise, the shields and the power only say so', () => {
    const { ctx, b } = battle(1);
    b.ships.length = 0;
    raiseShields(ctx, b, true);
    setPowerLevel(ctx, b, 4, false);
    expect([b.console.shieldsRaised, b.console.powerLevel, b.cues.map(c => c.cue)]).toEqual([true, 4, [0x18, 0x60, 4]]);
  });

  it('forced to a level below 4, says nothing and lowers the shields; a level without a preset changes no unit; a damaged shield is left be', () => {
    const { ctx, b, e } = battle(1);
    b.console.shieldsRaised = true;
    setPowerLevel(ctx, b, 3, true);
    expect([b.console.powerLevel, b.console.shieldsRaised, b.cues, e.systems.units[5]!.aiTarget]).toEqual([3, false, [], 30]);
    setPowerLevel(ctx, b, 7, false);
    expect([b.console.powerLevel, e.systems.units[5]!.aiTarget, b.cues.map(c => c.cue)]).toEqual([7, 30, [7]]);
    // (level 4's preset gives each unit 40; the whole shields are then filled, at 100 with no cap)
    Object.assign(e.systems.units[2]!, { damage: 1, current: 10, target: 10 });
    e.systems.units[1]!.current = 10;
    setPowerLevel(ctx, b, 4, false);
    expect([e.systems.units[2], e.systems.units[1]]).toMatchObject([
      { current: 10, target: 10, aiTarget: 40, aiCap: 40 }, { current: 100, target: 100, aiTarget: 100, aiCap: 0 },
    ]);
  });

  it('says nothing at the countdown\'s edges: 16, 14, 11, 10, 6 and 4 s left', () => {
    const { ctx, b } = battle(1);
    armSelfDestruct(ctx, b);
    b.cues.length = 0;
    for (const left of [16000, 14000, 11000, 10000, 6000, 4000]) {
      b.now = 30000 - left;
      updateSelfDestruct(ctx, b);
    }
    expect(b.cues).toEqual([]);
  });

  it('does nothing unarmed', () => {
    const { ctx, b, e } = battle(1);
    updateSelfDestruct(ctx, b);
    expect([b.cues, e.destroyed]).toEqual([[], false]);
  });
});

describe('every branch of fireTorpedoes (weapons.cpp:385-472)', () => {
  it('fires nothing, and rolls nothing, from a dead, dying, tubeless or cloaked ship, or at no target or a dead one', () => {
    const cases: [string, (t: ReturnType<typeof battle>) => void][] = [
      ['destroyed', t => { t.e.destroyed = true; }],
      ['dying', t => { t.e.flags |= SHIP_STATE.dying; }],
      ['no tubes', t => { t.e.flags &= ~SHIP_FLAGS.torpedoes; }],
      ['no target', t => { t.e.target = null; }],
      ['a dead target', t => { t.chodak.destroyed = true; }],
      ['cloaked', t => { t.e.decloakTime = 1; }],
    ];
    for (const [name, set] of cases) {
      const t = battle(1);
      set(t);
      fireTorpedoes(t.ctx, t.b, t.e, 0);
      expect([name, t.b.console.redAlert, t.b.console.salvo[0].loaded, t.b.random.draws, t.b.torpedoes.filter(x => x.active).length, t.b.cues])
        .toEqual([name, false, 10, 0, 0, []]);
    }
  });

  it('sets the Enterprise\'s leaving time when it fires on a starbase, once (weapons.cpp:393-394)', () => {
    const { ctx, b, e, chodak, sites } = battle(1);
    chodak.type = KIND.starbase;
    fireTorpedoes(ctx, b, e, 0);
    // (byte 198: rnd(0x369) = (198 * 873 + 128) >> 8 = 675; combatTicks(0x5af + 675 = 2130) = 7319)
    expect([e.removeTime, sites.slice(0, 2)]).toEqual([17319, ['weapons.cpp:394', 'weapons.cpp:453']]);
    const set = battle(1);
    set.chodak.type = KIND.starbase;
    set.e.removeTime = 5;
    fireTorpedoes(set.ctx, set.b, set.e, 0);
    expect([set.e.removeTime, set.sites[0]]).toEqual([5, 'weapons.cpp:453']);
  });

  it('fires the aft tube at a target behind, pitched over, and each torpedo\'s speed is the ship\'s plus or minus 525 by its tube', () => {
    const { ctx, b, e, chodak } = battle(1);
    chodak.pos = v3(0, -5000, 0);
    fireTorpedoes(ctx, b, e, 0);
    expect([b.console.salvo, e.systems.units[19]!.current, e.systems.units[20]!.current]).toEqual([[{ loaded: 10, setting: 10 }, { loaded: 0, setting: 10 }], 100, 90]);
    expect([b.torpedoes[0]!.angles, b.torpedoes[0]!.speed]).toEqual([[0, 0x2000, 0], 525]);
    // ((int)speed: fore, s >= 0 adds 525, else |s| - 525 but at least 525; aft, the other way about)
    const speeds: [number, number, number][] = [
      [5000, 1000.7, 1525], [5000, 0, 525], [5000, -600, 525], [5000, -2000.5, 1475],
      [-5000, 1000.7, 525], [-5000, 2000, 1475], [-5000, 0, 525], [-5000, -1000, 1525],
    ];
    expect(speeds.map(([y, speed]) => {
      const t = battle(1);
      t.chodak.pos = v3(0, y, 0);
      t.e.speed = speed;
      fireTorpedoes(t.ctx, t.b, t.e, 0);
      return t.b.torpedoes[0]!.speed;
    })).toEqual(speeds.map(s => s[2]));
  });

  it('cues an empty magazine only when both tubes are empty and Delegate isn\'t firing, and too close only without Delegate', () => {
    const { ctx, b, e } = battle(1);
    fireTorpedoes(ctx, b, e, 0);
    // (the aft tube's still loaded: no 0x20)
    fireTorpedoes(ctx, b, e, 0);
    expect(b.cues.map(c => c.cue)).toEqual([0x22]);
    const delegate = battle(1);
    delegate.b.console.delegate = true;
    delegate.b.console.salvo[0].loaded = 0;
    delegate.b.console.salvo[1].loaded = 0;
    fireTorpedoes(delegate.ctx, delegate.b, delegate.e, 0);
    expect(delegate.b.cues).toEqual([]);
    const close = battle(1);
    close.b.console.delegate = true;
    close.chodak.pos = v3(0, 999, 0);
    fireTorpedoes(close.ctx, close.b, close.e, 0);
    // (the salvo's spent all the same)
    expect([close.b.cues, close.b.console.salvo[0].loaded, close.b.torpedoes.filter(t => t.active).length]).toEqual([[], 0, 0]);
    // (1000 is far enough)
    const edge = battle(1);
    edge.chodak.pos = v3(0, 1000, 0);
    fireTorpedoes(edge.ctx, edge.b, edge.e, 0);
    expect(edge.b.torpedoes.filter(t => t.active).length).toBe(10);
  });

  it('spreads by the Enterprise\'s setting over the caller\'s, by the caller\'s when it\'s 0, and not at all for one torpedo', () => {
    const own = battle(1);
    own.b.console.spread = 2070;
    fireTorpedoes(own.ctx, own.b, own.e, 900);
    expect(own.b.torpedoes[0]!.angles[0]).toBe(-1035 & 0x3fff);
    const caller = battle(1);
    fireTorpedoes(caller.ctx, caller.b, caller.e, 900);
    // (-450 by 900 / 9 = 100)
    expect(caller.b.torpedoes.slice(0, 10).map(t => t.angles[0])).toEqual([-450, -350, -250, -150, -50, 50, 150, 250, 350, 450].map(a => a & 0x3fff));
    const one = battle(1);
    one.b.console.spread = 2070;
    one.b.console.salvo[0].setting = 1;
    fireTorpedoes(one.ctx, one.b, one.e, 900);
    expect([one.b.torpedoes.filter(t => t.active).length, one.b.torpedoes[0]!.angles[0], one.b.console.salvo[0].loaded]).toEqual([1, 0, 9]);
  });

  it('has no lock on a cloaked target, says so, and homes later', () => {
    const { ctx, b, e, chodak } = battle(1);
    b.console.weaponsLock = true;
    chodak.decloakTime = 1;
    fireTorpedoes(ctx, b, e, 0);
    expect([b.torpedoes[0]!.lock, b.torpedoes[0]!.homingTime, e.log]).toEqual([false, 11374, ['Target cloaked - no weapons lock.']]);
  });

  it('fires another ship\'s from its own tube by its facing, locked whatever the Enterprise\'s lock, spread by the caller, with no Enterprise cues', () => {
    // (the chodak turned away: the Enterprise is behind it, so the aft tube, unit 11)
    const aft = battle(1);
    aft.chodak.angles = [0, 0, 0];
    aft.chodak.systems.units[11]!.current = 0;
    fireTorpedoes(aft.ctx, aft.b, aft.chodak, 0);
    expect([aft.b.random.draws, aft.b.torpedoes[0]!.active]).toEqual([0, false]);
    aft.chodak.angles = [0x2000, 0, 0];
    fireTorpedoes(aft.ctx, aft.b, aft.chodak, 0);
    expect(aft.b.torpedoes[0]!.active).toBe(true);

    const { ctx, b, chodak, sites } = battle(1);
    b.console.spread = 2070;
    fireTorpedoes(ctx, b, chodak, 900);
    // (byte 198: rnd(2) = 2, four; -450 by 900 / 3 = 300 about its heading 0x2000; homing after combatTicks(0x246) = 2000)
    expect(b.torpedoes.slice(0, 4).map(t => t.angles[0])).toEqual([0x2000 - 450, 0x2000 - 150, 0x2000 + 150, 0x2000 + 450]);
    expect([b.torpedoes[0]!.lock, b.torpedoes[0]!.homingTime, b.torpedoes[0]!.shooter, b.torpedoes[0]!.target, sites[0]]).toEqual([true, 12000, 1, 0, 'weapons.cpp:408']);
    expect([b.cues.map(c => c.cue), b.sounds]).toMatchObject([[0x1a], [{ sound: '__photon.mac', ship: 1 }]]);

    // (an empty store: rolled, but nothing to fire and nothing said, though the Enterprise's magazine is empty too)
    const empty = battle(1);
    empty.chodak.systems.torpedoes = 0;
    empty.b.console.salvo[0].loaded = 0;
    empty.b.console.salvo[1].loaded = 0;
    fireTorpedoes(empty.ctx, empty.b, empty.chodak, 0);
    expect([empty.sites, empty.b.cues, empty.b.console.redAlert, empty.b.torpedoes[0]!.active]).toEqual([['weapons.cpp:408'], [], true, false]);
    // (one left: one torpedo, no spread)
    const last = battle(1);
    last.chodak.systems.torpedoes = 1;
    fireTorpedoes(last.ctx, last.b, last.chodak, 900);
    expect([last.chodak.systems.torpedoes, last.b.torpedoes.filter(t => t.active).length, last.b.torpedoes[0]!.angles[0]]).toEqual([0, 1, 0x2000]);
    // (too close: spent, but nothing said)
    const close = battle(1);
    close.chodak.pos = v3(0, 999, 0);
    fireTorpedoes(close.ctx, close.b, close.chodak, 0);
    expect([close.chodak.systems.torpedoes, close.b.cues.map(c => c.cue), close.b.torpedoes[0]!.active]).toEqual([271, [0x1a], false]);
  });

  it('takes the pool\'s free slots from the first each time, and a full pool loses the rest of the salvo (weapons.cpp:439-443)', () => {
    const { ctx, b, e } = battle(1);
    expect(b.torpedoes.length).toBe(99);
    b.torpedoes[1]!.active = true;
    fireTorpedoes(ctx, b, e, 0);
    expect([b.torpedoes.flatMap((t, i) => (t.shooter === 0 ? [i] : [])), b.torpedoes[1]!.shooter]).toEqual([[0, 2, 3, 4, 5, 6, 7, 8, 9, 10], null]);
    const full = battle(1);
    for (let i = 0; i < 96; i++) full.b.torpedoes[i]!.active = true;
    fireTorpedoes(full.ctx, full.b, full.e, 0);
    expect([full.b.torpedoes.flatMap((t, i) => (t.shooter === 0 ? [i] : [])), full.b.console.salvo[0].loaded, full.e.systems.units[19]!.current])
      .toEqual([[96, 97, 98], 0, 90]);
    expect(full.sites.filter(s => s === 'weapons.cpp:464').length).toBe(3);
  });

  it('rolls a second time for the frame only when the first is at least 1; one frame or none rolls rnd(0)', () => {
    const { ctx, b, e, sites } = battle(1);
    ctx.combat.animations!['__photon.spr'] = 2;
    fireTorpedoes(ctx, b, e, 0);
    // (rnd(1) is (byte + 128) >> 8: bytes 107, 84, 28, 49, 71 for the first five's are 0; the sixth's 170 is 1, so byte 136 picks frame 1)
    expect(b.torpedoes.slice(0, 6).map(t => t.frame)).toEqual([0, 0, 0, 0, 0, 1]);
    expect(sites.slice(0, 5).map(s => s.slice(12))).toEqual(['453', '453', '453', '459', '464']);
    expect(sites.slice(25, 31).map(s => s.slice(12))).toEqual(['453', '453', '453', '459', '460', '464']);
    // (no photon sprite: one frame, rnd(0); never a second roll)
    const none = battle(1);
    delete none.ctx.combat.animations!['__photon.spr'];
    fireTorpedoes(none.ctx, none.b, none.e, 0);
    expect([none.sites.includes('weapons.cpp:460'), none.b.torpedoes[0]!.frame, none.b.random.draws]).toEqual([false, 0, 50]);
  });
});

describe('every branch of updateTorpedoes (weapons.cpp:474-577)', () => {
  const fly = (b: BattleState, o: Partial<Torpedo>, slot = 0) => Object.assign(b.torpedoes[slot]!, {
    active: true, lock: false, speed: 0, frame: 0, launchTime: 0, expiry: 99999, homingTime: 0, homingDistance: 0,
    pos: v3(), angles: [0, 0, 0], shooter: 0, target: 1, ...o,
  });
  const three = (...more: [number, number, number][]) => (combat: ReturnType<typeof miniCombat>) => {
    for (const position of more) combat.battles[3]!.ships.push({ ...combat.battles[3]!.ships[1]!, object: 'space.other', position });
  };

  it('flies one launched now; a torpedo at its expiry still flies', () => {
    const { ctx, b } = battle(1);
    b.now = 10066;
    const t = fly(b, { speed: 525, launchTime: 10066, expiry: 10066 });
    updateTorpedoes(ctx, b);
    // (525 * 0.066 = 34.65)
    expect([t.active, t.pos.y]).toEqual([true, Math.fround(Math.fround(525 * Math.fround(0.066)))]);
  });

  it('hits by the closing speed: the target\'s velocity counts', () => {
    // (at 500 from 1000: 465 off after the step, under 525, but 34.65 is not over 465 - 200)
    const near = battle(1);
    near.chodak.pos = v3(0, 1000, 0);
    const t = fly(near.b, { speed: 525, pos: v3(0, 500, 0) });
    updateTorpedoes(near.ctx, near.b);
    expect([t.active, near.chodak.log]).toEqual([true, []]);
    // (coming on at 250: |34.65 + 250| = 284.65 is)
    const closing = battle(1);
    closing.chodak.pos = v3(0, 1000, 0);
    closing.chodak.velocity = v3(0, -250, 0);
    const c = fly(closing.b, { speed: 525, pos: v3(0, 500, 0) });
    updateTorpedoes(closing.ctx, closing.b);
    expect([c.active, closing.chodak.log]).toEqual([false, ['Photon torpedo repelled by -Unit 1-']]);
    // (the shield the Enterprise faces flashes where the torpedo is)
    expect([closing.chodak.shieldFlash.frames, closing.chodak.shieldFrom]).toEqual(['__shield.spr', c.pos]);
    // (coming on at 1000 from 1000: closing fast enough, but 965 off is not under 525)
    const far = battle(1);
    far.chodak.pos = v3(0, 1000, 0);
    far.chodak.velocity = v3(0, -1000, 0);
    const f = fly(far.b, { speed: 525 });
    updateTorpedoes(far.ctx, far.b);
    expect([f.active, far.chodak.log]).toEqual([true, []]);
  });

  it('doesn\'t explode or flash a target already exploding and flashing, and another ship\'s hit has no cue', () => {
    const { ctx, b, chodak, sites } = battle(1);
    chodak.pos = v3(0, 1000, 0);
    startAnimation(ctx, chodak.explosion, '__boom.spr', 100, 5);
    startAnimation(ctx, chodak.shieldFlash, '__shield.spr', 100, 5);
    b.now = 10066;
    const t = fly(b, { speed: 525, pos: v3(0, 790, 0) });
    updateTorpedoes(ctx, b);
    expect([t.active, sites, chodak.shieldFlash.lastFrame, chodak.explosion.lastFrame, chodak.log]).toEqual([false, [], 5, 5, ['Photon torpedo repelled by -Unit 1-']]);
    expect(b.cues.map(c => c.cue)).toEqual([0x21]);
    const other = battle(1, {}, three([0, 1000, 0]));
    fly(other.b, { speed: 525, pos: v3(0, 790, 0), shooter: 1, target: 2 });
    updateTorpedoes(other.ctx, other.b);
    expect([other.b.torpedoes[0]!.active, other.sites, other.b.cues]).toEqual([false, ['damage.cpp:417', 'damage.cpp:418'], []]);
  });

  it('stops at once when a hit ends the battle', () => {
    const { ctx, b, chodak } = battle(1);
    chodak.pos = v3(0, 1000, 0);
    fly(b, { speed: 525, pos: v3(0, 790, 0) }, 0);
    const second = fly(b, { speed: 525, pos: v3(0, 790, 0) }, 1);
    b.exitCode = 0;
    updateTorpedoes(ctx, b);
    expect([b.torpedoes[0]!.active, second.active, second.pos]).toEqual([false, true, v3(0, 790, 0)]);
  });

  it('expires one whose target is gone, with Worf\'s cue only for the Enterprise\'s', () => {
    const { ctx, b, chodak } = battle(1);
    chodak.destroyed = true;
    const t = fly(b, { speed: 525, pos: v3(0, 4790, 0) });
    updateTorpedoes(ctx, b);
    expect([t.active, b.cues.map(c => c.cue), b.random.draws, chodak.log]).toEqual([false, [0x1f], 0, []]);
    const other = battle(1);
    other.e.destroyed = true;
    fly(other.b, { speed: 525, shooter: 1, target: 0 });
    other.b.now = 99999 + 1;
    updateTorpedoes(other.ctx, other.b);
    expect([other.b.torpedoes[0]!.active, other.b.cues]).toEqual([false, []]);
  });

  it('turns the frame over; an unlocked torpedo or one at a dying target flies straight on, no faster', () => {
    const { ctx, b } = battle(1);
    // (four frames: 3 goes to 0, 1 to 2)
    const a = fly(b, { speed: 525, frame: 3, angles: [0x1000, 0, 0] }, 0);
    const c = fly(b, { speed: 525, frame: 1 }, 1);
    updateTorpedoes(ctx, b);
    expect([a.frame, c.frame, a.speed, a.angles, b.cues]).toEqual([0, 2, 525, [0x1000, 0, 0], []]);
    // (no photon sprite: one frame)
    delete ctx.combat.animations!['__photon.spr'];
    updateTorpedoes(ctx, b);
    expect(a.frame).toBe(0);
    const dying = battle(1);
    dying.chodak.flags |= SHIP_STATE.dying;
    const d = fly(dying.b, { speed: 525, lock: true, angles: [0x1000, 0, 0] });
    updateTorpedoes(dying.ctx, dying.b);
    expect([d.speed, d.angles, dying.b.cues]).toEqual([525, [0x1000, 0, 0], []]);
  });

  it('speeds a locked torpedo up by 15 to 900 while it waits to home, and by 30 more to 1750 once it does', () => {
    const speeds = (homingTime: number) => [899, 900, 1749, 1750].map(speed => {
      const t = battle(1);
      t.b.now = 10066;
      const torpedo = fly(t.b, { speed, lock: true, homingTime, homingDistance: 0 });
      updateTorpedoes(t.ctx, t.b);
      return torpedo.speed;
    });
    expect(speeds(20000)).toEqual([914, 900, 1749, 1750]);
    expect(speeds(0)).toEqual([944, 930, 1779, 1750]);
  });

  it('homes once it is closer than its homing distance or its homing time is past', () => {
    const homes = (homingDistance: number, homingTime: number) => {
      const t = battle(1);
      t.b.now = 10066;
      const torpedo = fly(t.b, { lock: true, homingTime, homingDistance, angles: [0x1000, 0, 0] });
      updateTorpedoes(t.ctx, t.b);
      return [torpedo.angles[0], t.b.cues.map(c => c.cue)];
    };
    // (5000 off: 5000 is not closer than 5000; 10066 is not past 10066)
    expect(homes(5000, 20000)).toEqual([0x1000, []]);
    expect(homes(5001, 20000)).toEqual([0x1000 - 0x2b2, [0x25]]);
    expect(homes(0, 10066)).toEqual([0x1000, []]);
    expect(homes(0, 10065)).toEqual([0x1000 - 0x2b2, [0x25]]);
  });

  it('turns over the top first when pitched past straight up or down', () => {
    const turn = (pitch: number) => {
      const t = battle(1);
      const torpedo = fly(t.b, { lock: true, angles: [0, pitch, 0] });
      updateTorpedoes(t.ctx, t.b);
      return torpedo.angles;
    };
    // (0x1800: heading and roll 0x2000, pitch 0x800; then 0x2000 off in heading, a turn of 0x422, and 0x800 below in pitch, 0x2b2)
    expect(turn(0x1800)).toEqual([0x2422, 0x800 - 0x2b2, 0x2000]);
    // (0x2800: pitch 0x6000 - 0x2800 = 0x3800, 0x800 up to go)
    expect(turn(0x2800)).toEqual([0x2422, 0x3800 + 0x2b2, 0x2000]);
    // (0x1000 and 0x3000 aren't over: just turned back)
    expect(turn(0x1000)).toEqual([0, 0x1000 - 0x2b2, 0]);
    expect(turn(0x3000)).toEqual([0, 0x3000 + 0x2b2, 0]);
  });

  it('turns all the way inside 800, by a turn at 800, and not at all at a cloaked target', () => {
    const turn = (y: number, angles: [number, number, number], cloaked = false) => {
      const t = battle(1);
      t.chodak.pos = v3(0, y, 0);
      if (cloaked) t.chodak.decloakTime = 1;
      const torpedo = fly(t.b, { lock: true, angles });
      updateTorpedoes(t.ctx, t.b);
      return [torpedo.angles, torpedo.speed, t.b.cues.map(c => c.cue)];
    };
    expect(turn(700, [0x1000, 0x100, 0])).toEqual([[0, 0, 0], 45, [0x25]]);
    expect(turn(800, [0x1000, 0, 0])).toEqual([[0x1000 - 0x2b2, 0, 0], 45, [0x25]]);
    expect(turn(5000, [0x1000, 0, 0], true)).toEqual([[0x1000, 0, 0], 45, [0x25]]);
  });

  it('is off course beyond 0x564 one way and 0x4b4 the other, in heading or pitch, and then finds a ship within 0x564 either way', () => {
    // (the chodak dead ahead; under the weapons lock, one off course finds it again, Worf's 0x26)
    const retargets = (angles: [number, number, number]) => {
      const t = battle(1);
      t.b.console.weaponsLock = true;
      fly(t.b, { lock: true, angles });
      updateTorpedoes(t.ctx, t.b);
      return [t.b.torpedoes[0]!.lock, t.b.cues.map(c => c.cue)];
    };
    expect(retargets([0x3a9c, 0, 0])).toEqual([true, [0x25]]);
    expect(retargets([0x3a9b, 0, 0])).toEqual([true, [0x25, 0x26]]);
    expect(retargets([0x4b4, 0, 0])).toEqual([true, [0x25]]);
    expect(retargets([0x4b5, 0, 0])).toEqual([true, [0x25, 0x26]]);
    expect(retargets([0, 0x3a9c, 0])).toEqual([true, [0x25]]);
    expect(retargets([0, 0x3a9b, 0])).toEqual([true, [0x25, 0x26]]);
    // (0x816 off turns to 0x564: found; 0x817 to 0x565: not, so it loses its lock; the same the other way)
    expect(retargets([0x37ea, 0, 0])).toEqual([true, [0x25, 0x26]]);
    expect(retargets([0x37e9, 0, 0])).toEqual([false, [0x25]]);
    expect(retargets([0x816, 0, 0])).toEqual([true, [0x25, 0x26]]);
    expect(retargets([0x817, 0, 0])).toEqual([false, [0x25]]);
    expect(retargets([0, 0x816, 0])).toEqual([true, [0x25, 0x26]]);
    expect(retargets([0, 0x817, 0])).toEqual([false, [0x25]]);
    expect(retargets([0, 0x37ea, 0])).toEqual([true, [0x25, 0x26]]);
    expect(retargets([0, 0x37e9, 0])).toEqual([false, [0x25]]);
  });

  it('looks only further off than twice the target\'s radius, and only under the weapons lock', () => {
    const look = (y: number, lock: boolean) => {
      const t = battle(1);
      t.chodak.pos = v3(0, y, 0);
      t.b.console.weaponsLock = lock;
      fly(t.b, { lock: true, angles: [0x1000, 0, 0] });
      updateTorpedoes(t.ctx, t.b);
      return t.b.cues.map(c => c.cue);
    };
    // (inside 800 it turns straight at the chodak, which it then finds, but not at 400)
    expect(look(400, true)).toEqual([0x25]);
    expect(look(401, true)).toEqual([0x25, 0x26]);
    // (the distance is truncated: 400.5 is 400)
    expect(look(400.5, true)).toEqual([0x25]);
    expect(look(5000, false)).toEqual([0x25]);
  });

  it('passes over a destroyed ship, and finds its own shooter by the Enterprise\'s lock (a quirk, kept), but never the Enterprise', () => {
    // (ship 1 off to starboard, ship 2 ahead but destroyed, ship 3 further ahead)
    const dead = battle(1, {}, three([0, 5000, 0], [0, 6000, 0]));
    dead.chodak.pos = v3(5000, 0, 0);
    dead.b.ships[2]!.destroyed = true;
    dead.b.console.weaponsLock = true;
    fly(dead.b, { lock: true });
    updateTorpedoes(dead.ctx, dead.b);
    expect(dead.b.torpedoes[0]!.target).toBe(3);
    // (both ahead and alive: the first)
    const first = battle(1, {}, three([0, 5000, 0], [0, 6000, 0]));
    first.chodak.pos = v3(5000, 0, 0);
    first.b.console.weaponsLock = true;
    fly(first.b, { lock: true });
    updateTorpedoes(first.ctx, first.b);
    expect(first.b.torpedoes[0]!.target).toBe(2);

    // (the chodak's, at the Enterprise behind it: 0x2000 off, it turns 0x422 and finds the chodak ahead, 0x3bde off)
    const own = battle(1);
    own.b.console.weaponsLock = true;
    fly(own.b, { lock: true, shooter: 1, target: 0, pos: v3(0, 2000, 0) });
    updateTorpedoes(own.ctx, own.b);
    expect([own.b.torpedoes[0]!.target, own.b.torpedoes[0]!.angles[0], own.b.cues]).toEqual([1, 0x422, []]);
    const unlocked = battle(1);
    fly(unlocked.b, { lock: true, shooter: 1, target: 0, pos: v3(0, 2000, 0) });
    updateTorpedoes(unlocked.ctx, unlocked.b);
    expect([unlocked.b.torpedoes[0]!.target, unlocked.b.torpedoes[0]!.lock]).toEqual([0, true]);

    // (the chodak's at ship 2 to starboard; the Enterprise dead ahead, the chodak off to port: none found)
    const never = battle(1, {}, three([5000, 0, 0]));
    never.chodak.pos = v3(-5000, 0, 0);
    never.b.console.weaponsLock = true;
    fly(never.b, { lock: true, shooter: 1, target: 2, pos: v3(0, -2000, 0) });
    updateTorpedoes(never.ctx, never.b);
    expect([never.b.torpedoes[0]!.target, never.b.torpedoes[0]!.lock]).toEqual([2, false]);
  });
});

describe('WEAPON_SEAMS', () => {
  it('fills every weapons seam, frozen', () => {
    expect(Object.keys(WEAPON_SEAMS).sort()).toEqual([
      'armSelfDestruct', 'fireTorpedoes', 'firePhasers', 'raiseShields', 'setPowerLevel', 'setSpread', 'setWeaponsLock', 'setupWeapons',
      'updateBeams', 'updateLamps', 'updateSelfDestruct', 'updateTorpedoes',
    ].sort());
    expect([WEAPON_SEAMS.fireTorpedoes, WEAPON_SEAMS.updateTorpedoes, Object.isFrozen(WEAPON_SEAMS)]).toEqual([fireTorpedoes, updateTorpedoes, true]);
  });
});
