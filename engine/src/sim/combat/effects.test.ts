// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { miniBattle, miniBattleContext } from '../../testing/combat';
import { VIEW } from './battle';
import { advanceAnimation, animationActive, cameraEvent, EVENT_VIEW_TIME, nextRoll, playEffect, roll, startAnimation, stopAnimation } from './effects';
import { fromAngles, v3 } from './math';
import { newRandom } from './random';
import { anim, isEnterprise, NO_HOOK, NO_SEAMS, playCueAfter } from './types';

describe('the effects weapons and damage share', () => {
  it('starts an animation over its lifted frames, and leaves a missing one stopped (TextureAnimation::start, combat.cpp:81-86)', () => {
    const { ctx } = miniBattle();
    const a = anim();
    // (miniCombat's __shield.spr has 5 frames)
    startAnimation(ctx, a, '__shield.spr', 30, 1000, 7);
    expect(a).toEqual({ frames: '__shield.spr', frame: 2, frameTime: 30, lastFrame: 1000 });
    expect(animationActive(a)).toBe(true);
    startAnimation(ctx, a, 'gone.spr', 30, 2000);
    expect(a).toEqual({ frames: null, frame: 0, frameTime: 30, lastFrame: 2000 });
    startAnimation(ctx, a, null, 30, 2000);
    expect(animationActive(a)).toBe(false);
  });

  it('moves a frame on once its time is past, and says when it wraps (TextureAnimation::advance, combat.cpp:88-97)', () => {
    const { ctx } = miniBattle();
    const a = anim();
    startAnimation(ctx, a, '__shield.spr', 30, 1000);
    expect(advanceAnimation(ctx, a, 1030)).toBe(false);
    expect(a.frame).toBe(0);
    const wraps: boolean[] = [];
    for (let t = 1031; wraps.length < 5; t += 31) wraps.push(advanceAnimation(ctx, a, t));
    expect(wraps).toEqual([false, false, false, false, true]);
    expect(a.frame).toBe(0);
    stopAnimation(a);
    expect(advanceAnimation(ctx, a, 9999)).toBe(false);
  });

  it('rolls through the battle\'s generator, telling the trace hook each site; next() is heard with n -1', () => {
    const heard: [string, number, number][] = [];
    const ctx = { ...miniBattleContext(), onDraw: (site: string, n: number, value: number) => { heard.push([site, n, value]); } };
    const { b } = miniBattle({ ctx });
    b.random = newRandom(1);
    heard.length = 0;
    // (seed 1 draws 16838, then 5758: rnd(100) is (16838 & 0xff = 198) * 100 + 0x80 = 19928, >> 8 = 77)
    expect(roll(ctx, b, 100, 'damage.cpp:207')).toBe(77);
    expect(nextRoll(ctx, b, 'damage.cpp:431')).toBe(5758);
    expect(heard).toEqual([['damage.cpp:207', 100, 77], ['damage.cpp:431', -1, 5758]]);
    // (both draws went through the battle's generator: 1 * 0x41c64e6d + 0x3039, twice, over uint32)
    expect(b.random).toEqual({ state: 2524885223, draws: 2 });
  });

  it('gives a sound from a ship its bearing from the camera\'s forward, positive to the right (Plan 34 Task 6); none at the camera', () => {
    const { b } = miniBattle();
    b.view.camera.pos = v3(0, 0, 0);
    b.view.camera.axes = fromAngles(0, 0, 0);
    // (internal (x, y, z) is battle (x, z, -y): right, down, forward. Ahead, to the right, to the left, behind and to the right)
    const at = (x: number, y: number, z: number) => {
      b.ships[1]!.pos = v3(x, z, -y);
      playEffect(b, b.ships[1]!, 'boom.mac');
      return b.sounds.at(-1)!.bearing!;
    };
    expect(at(0, 0, 1000)).toBeCloseTo(0, 12);
    expect(at(1000, 0, 0)).toBeCloseTo(Math.PI / 2, 6);
    expect(at(-1000, 0, 1000)).toBeCloseTo(-Math.PI / 4, 6);
    expect(at(1000, 0, -1000)).toBeCloseTo((3 * Math.PI) / 4, 6);
    // (above or below counts for nothing: the bearing is on the camera's right and forward)
    expect(at(1000, 5000, 1000)).toBeCloseTo(Math.PI / 4, 6);
    // (turned to look along its right, what was at its right is ahead)
    b.view.camera.axes = fromAngles(0x1000, 0, 0);
    expect(Math.abs(at(1000, 0, 0))).toBeLessThan(0.01);
    playEffect(b, null, 'beep7.mac');
    expect('bearing' in b.sounds.at(-1)!).toBe(false);
  });

  it('asks for sounds and after-cues as requests, each sound with its distance from the camera, and the world scripts do nothing by default', () => {
    const { b } = miniBattle();
    // (the camera at internal (100, -200, 300); the chodak at battle (400, 1500, -200), internal (400, 200, 1500), combat.cpp:107-109:
    // 300, 400 and 1200 from the camera, sqrt(90000 + 160000 + 1440000) = 1300. No ship: 0, weapons.cpp:156)
    b.view.camera.pos = v3(100, -200, 300);
    b.ships[1]!.pos = v3(400, 1500, -200);
    playEffect(b, b.ships[1]!, '1_explo.mac');
    playEffect(b, null, 'beep7.mac');
    expect(b.sounds).toEqual([{ sound: '1_explo.mac', ship: 1, distance: 1300, bearing: Math.atan2(300, 1200) }, { sound: 'beep7.mac', ship: null, distance: 0 }]);
    // (the distance is the camera's as the request is made: one moved after it changes nothing, Plan 28 R4)
    b.view.camera.pos = v3(0, 0, 0);
    expect(b.sounds[0]!.distance).toBe(1300);
    playCueAfter(b, 0x1b);
    expect(b.cues.at(-1)).toEqual({ cue: 0x1b, delay: 0, interrupt: false, after: true });
    const { ctx } = miniBattle();
    expect(NO_SEAMS.eventScript(ctx, b, b.ships[1]!, 2)).toBe(NO_HOOK);
    expect(NO_HOOK).toEqual({ hailPending: false, answered: false });
    const chodak = b.ships[1]!;
    expect([NO_SEAMS.hailScript(ctx, b, chodak, 1), NO_SEAMS.hullLowScript(ctx, b, chodak), NO_SEAMS.destroyedScript(ctx, b, chodak)]).toEqual([NO_HOOK, NO_HOOK, NO_HOOK]);
    expect(Object.isFrozen(NO_SEAMS)).toBe(true);
  });

  it('shares one empty animation and one Enterprise test (TextureAnimation(), combat.h:91; kCombatEnterprise, combat.h:47)', () => {
    const { b } = miniBattle();
    expect(anim()).toEqual({ frames: null, frame: 0, frameTime: 0, lastFrame: 0 });
    expect(anim()).not.toBe(anim());
    expect(b.ships.map(isEnterprise)).toEqual([true, ...b.ships.slice(1).map(() => false)]);
  });

  it('cuts to the action only under Delegate, at most every 6 s (Combat::cameraEvent, ai.cpp:504-512)', () => {
    const { b } = miniBattle();
    cameraEvent(b, b.ships[1]!, 0);
    expect(b.view.view).toBe(VIEW.chase);
    b.console.delegate = true;
    cameraEvent(b, b.ships[1]!, 0);
    expect([b.view.view, b.view.viewShip, b.view.viewExpiry, b.console.eventViewTime]).toEqual([VIEW.target, 1, 10000 + EVENT_VIEW_TIME, 16000]);
    b.now += 5999;
    cameraEvent(b, b.ships[0]!, 5);
    expect(b.view.view).toBe(VIEW.target);
    b.now += 1;
    cameraEvent(b, b.ships[0]!, 5);
    expect([b.view.view, b.view.viewShip]).toEqual([VIEW.chase, 0]);
    b.now += 6000;
    cameraEvent(b, b.ships[0]!, 7);
    expect(b.view.viewExpiry).toBe(22000);
  });
});
