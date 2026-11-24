// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { spriteAnimation } from './enginespr';
import { again, block, comp, scom, sprite, u32 } from './spritefixture';

describe('spriteAnimation', () => {
  it('has the pictures of an animation up to its jump, a frame that refers back being the same picture', () => {
    const entries = [comp(), again(comp().length), block('JUMP', u32(0)), comp(), block('EXIT', [])];
    const bytes = sprite(entries, [0, null, 3]);
    const frames = spriteAnimation(bytes, 0);
    expect(frames).toHaveLength(2);
    expect([frames[0]!.width, frames[0]!.height, [...frames[0]!.indices]]).toEqual([2, 1, [5, 6]]);
    expect(frames[1]).toBe(frames[0]);
    expect(spriteAnimation(bytes, 1)).toEqual([]);
    expect(spriteAnimation(bytes, 2)).toHaveLength(1);
  });
  it('gives each picture its wait (a TIME block, in 291ths of a second by sixteens) and the animation\'s POSN, even one after the picture', () => {
    const entries = [comp(), block('TIME', u32(466)), block('PAUS', []), comp(), block('POSN', [...u32(42), ...u32(288)]), block('PAUS', []), comp(), block('EXIT', [])];
    const bytes = sprite(entries, [0, 3, 6]);
    const [first] = spriteAnimation(bytes, 0, true);
    expect(first!.waitMs).toBe(100);
    expect(first!.at).toBeUndefined();
    expect(spriteAnimation(bytes, 1, true)).toHaveLength(1);
    expect(spriteAnimation(bytes, 1, true)[0]!.at).toEqual([42, 288]);
    // (a pause ends the animation only when asked: the engine's own animations run on past one)
    expect(spriteAnimation(bytes, 0)).toHaveLength(3);
  });
  it('has a speech picture (SCOM) as a picture, as sprite.cpp reads it', () => {
    const bytes = sprite([comp(), block('PAUS', []), scom(), block('PAUS', []), block('EXIT', [])], [0, 2]);
    const [page] = spriteAnimation(bytes, 1, true);
    expect([page!.width, page!.height, [...page!.indices]]).toEqual([2, 1, [5, 6]]);
  });
  it('refuses what is not a sprite, or an animation it does not have', () => {
    expect(() => spriteAnimation(new Uint8Array(40), 0)).toThrow(/not a sprite/);
    expect(() => spriteAnimation(sprite([comp(), block('EXIT', [])], [0]), 3)).toThrow(/no animation 3/);
  });
});
