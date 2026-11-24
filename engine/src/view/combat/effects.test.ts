// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { miniBattle, miniBattleContext, miniCombat } from '../../testing/combat';
import { fromInternal, orientation, toInternal } from '../../sim/combat/aim';
import { add, apply, fromAngles, sub, v3, type V3 } from '../../sim/combat/math';
import type { BattleState } from '../../sim/combat/types';
import { WEAPON_SEAMS } from '../../sim/combat/weapons';
import { shipPose } from './draw';
import { effectScale, effectsOf, flashColour, frameUv, materialOpacity, modelRadius, SHIELD_SCALE, StepMemory } from './effects';

/** miniCombat's battle 3 with the weapons set up (each ship's banks), its two ships still and unturned at the origin and 5000 ahead. */
function battle(): BattleState {
  const { b } = miniBattle({ ctx: miniBattleContext({ ...WEAPON_SEAMS }) });
  b.ships.forEach((s, i) => {
    s.pos = { x: 0, y: i * 5000, z: 0 };
    s.angles = [0, 0, 0];
    s.trail = [];
  });
  return b;
}

describe('the effects\' sizes, fades and frames', () => {
  it('scales a shield or an explosion by the ship\'s mean size over 412.667, the Enterprise\'s not at all (weapons.cpp:132-136)', () => {
    const combat = miniCombat();
    const b = battle();
    expect(SHIELD_SCALE).toBe(Math.fround(412.667));
    expect(effectScale(combat, b.ships[0]!)).toBe(1);
    // (mini.3dv is 100 x 50 x 200: 350 / 3 / 412.667)
    expect(effectScale(combat, b.ships[1]!)).toBeCloseTo(0.282714, 6);
    expect(effectScale(combat, { ...b.ships[1]!, models: { detail: null, reduced: null, damaged: null } })).toBe(1);
  });

  it('fades by alpha in sixty-fourths from 0x100 and draws nothing from 0x4000 (space3d.cpp:390-395, 440-442)', () => {
    expect([0, 0xff, 0x100, 0x1000, 0x3ddd, 0x4000, 0x5000].map(materialOpacity)).toEqual([1, 1, 63 / 64, 0.75, 3 / 64, 0, 0]);
  });

  it('bounds a model by its box\'s centre and half diagonal, which a debris piece far from its origin needs', () => {
    // (the phaser: 20 x 20 x 256 about (0, 0, 128): 128 + sqrt(66336) / 2)
    expect(modelRadius({ size: [20, 20, 256], centre: [0, 0, 128] })).toBeCloseTo(128 + Math.sqrt(66336) / 2, 9);
    // (a piece 10 across, 500 out: past its largest extent, which drawModel's cull takes)
    expect(modelRadius({ size: [10, 10, 10], centre: [0, 0, 500] }, 2)).toBeCloseTo((500 + Math.sqrt(300) / 2) * 2, 9);
  });

  it('maps a frame of a sheet to its cell, edge texels\' middles at 0 and 1, v up the flipped sheet', () => {
    // (30 frames of 520 x 248, 7 to a row: 3640 x 1240; frame 8 is column 1 of row 1)
    const sheet = { frames: 30, columns: 7, cell: [520, 248] as [number, number] };
    expect(frameUv(sheet, 8)).toEqual({ offset: [520.5 / 3640, 1 - 248.5 / 1240], repeat: [519 / 3640, -247 / 1240] });
    // (a sheet with no columns is one column, not NaN)
    expect(frameUv({ frames: 1, columns: 0, cell: [4, 4] }, 0)).toEqual(frameUv({ frames: 1, columns: 1, cell: [4, 4] }, 0));
    // (a frame past the last is the last's)
    expect(frameUv(sheet, 40)).toEqual(frameUv(sheet, 29));
  });

  it('tints space to the original\'s (0x80, 0x40, 0x40) in a red flash, or less of it', () => {
    expect(flashColour(1)).toEqual([128 / 255, 64 / 255, 64 / 255]);
    expect(flashColour(0.4)[0]).toBeCloseTo(0.4 * 128 / 255, 12);
  });
});

describe('effectsOf (Combat::render and drawEffects, combat.cpp:964-1003, 1058-1077)', () => {
  it('draws an active bank\'s beam from its offset on the ship, its tip on what it hits, in the beam\'s frame', () => {
    const b = battle();
    const combat = miniCombat();
    const bank = b.ships[0]!.banks[0]!;
    bank.active = true;
    bank.beam = { frames: '__phaser.spr', frame: 3, frameTime: 0, lastFrame: 0 };
    bank.tip = v3(0, 0, 4790);
    const [beam] = effectsOf(b, combat, 1, new StepMemory());
    // (kEnterprisePhasers[0] (0, -20, 210) on an unturned ship at the origin)
    expect(beam).toMatchObject({ kind: 'beam', key: 'beam:0:0', model: 'phaser.3dv', pos: { x: 0, y: -20, z: 210 }, sprite: '__phaser.spr', frame: 3, texture: 'phaser1.lbm', tip: { x: 0, y: 0, z: 4790 } });
    expect(beam!.m).toEqual(fromAngles(0, 0, 0));
    // (the ship turned a quarter to starboard: the offset turns with it, x = 210)
    b.ships[0]!.angles = [0x1000, 0, 0];
    expect(effectsOf(b, combat, 1, new StepMemory())[0]!.pos).toMatchObject({ x: 210, y: -20 });
    // (a bank that hasn't reached anything keeps the model's own first vertex)
    bank.tip = v3();
    expect(effectsOf(b, combat, 1, new StepMemory())[0]!.tip).toBeNull();
    // (what it fires at, for the tests' check that it reaches it: none without a tip or a target)
    expect(effectsOf(b, combat, 1, new StepMemory())[0]!.aim).toBeNull();
  });

  it('keeps a beam\'s far end where the sim put it on its target while the ships are drawn between steps, and says how it was aimed (weapons.cpp:349-380)', () => {
    const b = battle();
    const combat = miniCombat();
    const [e, chodak] = [b.ships[0]!, b.ships[1]!];
    // (both moving this step: the Enterprise 20 forward, the chodak 15 to the side; their trails hold where they were)
    e.trail = [{ pos: { x: 0, y: -20, z: 0 }, angles: [0, 0, 0] }, { pos: { x: 0, y: -20, z: 0 }, angles: [0, 0, 0] }];
    chodak.trail = [{ pos: { x: -15, y: 5000, z: 0 }, angles: [0, 0, 0] }, { pos: { x: -15, y: 5000, z: 0 }, angles: [0, 0, 0] }];
    e.target = 1;
    const bank = e.banks[0]!;
    bank.active = true;
    bank.beam = { frames: '__phaser.spr', frame: 5, frameTime: 0, lastFrame: 0 };
    // (updateBeams' tip: from the bank, where the step left the ship, to the end on the target, weapons.cpp:350-380)
    const start = add(e.pos, fromInternal(apply(orientation(e), bank.offset)));
    const aimAt = (end: V3) => { bank.tip = toInternal(sub(end, start)); };
    const drawn = (t: number) => {
      const beam = effectsOf(b, combat, t, new StepMemory())[0]!;
      const target = shipPose(chodak, t).pos;
      return { beam, off: [beam.pos.x + beam.tip!.x - target.x, beam.pos.y + beam.tip!.y - target.y, beam.pos.z + beam.tip!.z - target.z] };
    };
    // (a hit: the end on the target's centre, wherever the two are drawn)
    aimAt(chodak.pos);
    expect(shipPose(e, 0.5).pos.z).not.toBe(toInternal(e.pos).z);
    for (const t of [0, 0.5]) for (const n of drawn(t).off) expect(n).toBeCloseTo(0, 3);
    // (at the step itself, as the parity mode and ScummVM draw it: the sim's tip as it is)
    expect(drawn(1).beam.tip).toEqual(bank.tip);
    // (the chodak is later in the list than the Enterprise: its travel this step, which the end lags by, below)
    expect(drawn(0.5).beam.aim).toEqual({ to: 1, kind: 'hit', stale: false, lag: toInternal(v3(15, 0, 0)), at: shipPose(chodak, 0.5).pos, radius: chodak.radius });
    // (a miss: 0.75 R beside it (weapons.cpp:286), kept beside it)
    bank.miss = true;
    bank.missOffset = v3(9, 0, 0);
    aimAt(add(chodak.pos, fromInternal(bank.missOffset)));
    drawn(0.5).off.forEach((n, i) => expect(n).toBeCloseTo([9, 0, 0][i]!, 3));
    expect(drawn(0.5).beam.aim!.kind).toBe('miss');
    // (a hit while the target's shield flashes: on the impact; on the flash's first step, the impact the last flash left)
    bank.miss = false;
    chodak.shieldFlash = { frames: '__shield.spr', frame: 1, frameTime: 100, lastFrame: b.lastStep - 66 };
    expect(drawn(0.5).beam.aim).toMatchObject({ kind: 'shield', stale: false });
    chodak.shieldFlash = { frames: '__shield.spr', frame: 0, frameTime: 100, lastFrame: b.lastStep };
    expect(drawn(0.5).beam.aim).toMatchObject({ kind: 'shield', stale: true });
    // (a ship later in the list moves after the shooter in a step: the end lags it by its travel, as ScummVM's does)
    chodak.shieldFlash = { frames: null, frame: 0, frameTime: 0, lastFrame: 0 };
    b.ships[1]!.target = 0;
    const bank1 = chodak.banks[0]!;
    bank1.active = true;
    bank1.beam = { frames: '__phaser.spr', frame: 5, frameTime: 0, lastFrame: 0 };
    bank1.tip = v3(1, 1, 1);
    const back = effectsOf(b, combat, 0.5, new StepMemory()).find(d => d.key === 'beam:1:0')!;
    expect(back.aim).toMatchObject({ to: 0, kind: 'hit', stale: false, lag: null });
  });

  it('draws the shield turned to its attacker, scaled to the ship, and the explosion as a billboard, for each ship not removed', () => {
    const b = battle();
    const chodak = b.ships[1]!;
    chodak.shieldFlash = { frames: '__shield.spr', frame: 2, frameTime: 0, lastFrame: 0 };
    chodak.shieldAngles = [0x2000, 0x100];
    chodak.explosion = { frames: '1_boom.spr', frame: 5, frameTime: 0, lastFrame: 0 };
    const out = effectsOf(b, miniCombat(), 1, new StepMemory());
    expect(out.map(e => [e.kind, e.model, e.sprite, e.frame, e.texture])).toEqual([['shield', 'shield_2.3dv', '__shield.spr', 2, 'shield.lbm'], ['explosion', 'bboard.3dv', '1_boom.spr', 5, 'boom.lbm']]);
    expect(out[0]!.m).toEqual(fromAngles(0x2000, 0x100, 0));
    // (internal (0, 0, 5000): battle y forward is internal z)
    expect(out[0]!.pos).toEqual({ x: 0, y: -0, z: 5000 });
    expect(out[0]!.scale).toBeCloseTo(0.282714, 6);
    // (a destroyed ship's trail stopped with its last flight step: its explosion stays where it is across t)
    chodak.pos = { x: 0, y: 5100, z: 0 };
    chodak.trail = [{ pos: { x: 0, y: 5090, z: 0 }, angles: [0, 0, 0] }, { pos: { x: 0, y: 5090, z: 0 }, angles: [0, 0, 0] }];
    chodak.destroyed = true;
    expect([0.25, 0.5, 1].map(t => effectsOf(b, miniCombat(), t, new StepMemory()).find(e => e.kind === 'explosion')!.pos.z)).toEqual([5100, 5100, 5100]);
    chodak.removed = true;
    expect(effectsOf(b, miniCombat(), 1, new StepMemory())).toEqual([]);
  });

  it('draws a launched torpedo in its shooter\'s photon frame, the frame wrapped by the sprite\'s count; none before launch', () => {
    const b = battle();
    const t = b.torpedoes[4]!;
    Object.assign(t, { active: true, launchTime: b.now, shooter: 1, frame: 6, pos: { x: 10, y: 20, z: 30 } });
    const [torpedo] = effectsOf(b, miniCombat(), 1, new StepMemory());
    // (miniCombat's __photon.spr has 4 frames: 6 % 4)
    expect(torpedo).toMatchObject({ kind: 'torpedo', key: `torpedo:4:${b.now}`, model: 'photon.3dv', pos: { x: 10, y: -30, z: 20 }, sprite: '__photon.spr', frame: 2, texture: 'photon.lbm' });
    // (no shooter: no photon sprite, the model's own texture)
    t.shooter = null;
    expect(effectsOf(b, miniCombat(), 1, new StepMemory())[0]).toMatchObject({ kind: 'torpedo', sprite: null, frame: 0 });
    t.launchTime = b.now + 1;
    expect(effectsOf(b, miniCombat(), 1, new StepMemory())).toEqual([]);
  });

  it('draws each debris piece faded by its debris\'s alpha, and its boom as a billboard scaled to the dying ship', () => {
    const b = battle();
    b.debris.push({
      ship: 1, scale: 0.5, alpha: 0x1000, fadeTime: 0, removeTime: 0,
      pieces: [{ model: 'generic.pc1', pos: { x: 1, y: 2, z: 3 }, velocity: v3(), angles: [0x100, 0x200, 0x300], rates: [0, 0, 0], boom: { frames: '__boom.spr', frame: 7, frameTime: 0, lastFrame: 0 }, boomTime: 0, boomStarted: true }],
    });
    const out = effectsOf(b, miniCombat(), 1, new StepMemory());
    // (generic.pc1 has no materials of its own: the dying ship's detailed model's, damage.cpp:486)
    expect(out.map(e => [e.kind, e.model, e.scale, e.alpha, e.ship, e.borrow])).toEqual([['debris', 'generic.pc1', 0.5, 0x1000, 1, 'mini.3dv'], ['boom', 'bboard.3dv', effectScale(miniCombat(), b.ships[1]!), -1, 1, null]]);
    expect(out[0]!.m).toEqual(fromAngles(0x100, 0x200, 0x300));
    // (a dying ship without a detailed model has no materials for its pieces: the boom is drawn, the piece not)
    b.ships[1]!.models = { detail: null, reduced: null, damaged: null };
    expect(effectsOf(b, miniCombat(), 1, new StepMemory()).map(e => e.kind)).toEqual(['boom']);
  });

  it('draws torpedoes and pieces between their last two steps, as it does the ships (Decision 7)', () => {
    const b = battle();
    const memory = new StepMemory();
    const t = b.torpedoes[0]!;
    Object.assign(t, { active: true, launchTime: b.now, shooter: 0, pos: { x: 0, y: 100, z: 0 } });
    expect(effectsOf(b, miniCombat(), 0.5, memory)[0]!.pos).toEqual({ x: 0, y: -0, z: 100 });
    b.steps++;
    t.pos = { x: 0, y: 300, z: 0 };
    // (half way from internal z 100 to 300)
    expect(effectsOf(b, miniCombat(), 0.5, memory)[0]!.pos.z).toBe(200);
    expect(effectsOf(b, miniCombat(), 1, memory)[0]!.pos.z).toBe(300);
    // (two steps in one frame: no step before to go from)
    b.steps += 2;
    t.pos = { x: 0, y: 900, z: 0 };
    expect(effectsOf(b, miniCombat(), 0.5, memory)[0]!.pos.z).toBe(900);
  });
});
