// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { canonicalAnim, playAnim, replyAnims, spriteFlags, usedBodies, waitMillis, type SpriteJson } from './sprites';

const spr = (n: number, w = 20, h = 60) => ({ type: 'sprite' as const, width: w, height: h, png: `f${n}.png` });
const wait = (w: number) => ({ type: 'wait' as const, wait: w });

describe('sprite animations', () => {
  it('turns waits into milliseconds at the original\'s 291.3 ticks a second', () => {
    // 272 sixteenths of a tick is 17 ticks
    expect(waitMillis(272)).toBe(58);
    expect(waitMillis(0)).toBe(0);
  });

  it('plays an animation as the sprite player does: frames with the relative move in force, waits, and a jump to itself is a loop', () => {
    const s: SpriteJson = {
      anims: [0],
      entries: [
        spr(1), { type: 'relPos', x: -3, y: 8 }, wait(272),
        spr(2), wait(544),
        { type: 'jump', target: 0 },
      ],
    };
    const bodies = playAnim(s, 0);
    expect([...bodies.keys()]).toEqual([0]);
    const b = bodies.get(0)!;
    expect(b.loop).toBe(true);
    expect(b.next).toBeUndefined();
    expect(b.frames.map(f => [f.png, f.dx, f.dy, f.wait])).toEqual([['f1.png', -3, 8, 58], ['f2.png', -3, 8, 117]]);
  });

  it('an animation that only jumps is another name for its target; one that jumps elsewhere after frames falls into it', () => {
    const s: SpriteJson = {
      anims: [0, 3, 6],
      entries: [
        { type: 'jump', target: 1 }, wait(16), wait(16),
        spr(1), wait(160), { type: 'jump', target: 2 },
        spr(2), wait(160), { type: 'jump', target: 2 },
      ],
    };
    expect(canonicalAnim(s, 0)).toBe(1);
    const { bodies, alias } = usedBodies(s, [0]);
    expect(alias.get(0)).toBe(1);
    expect([...bodies.keys()].sort()).toEqual([1, 2]);
    expect(bodies.get(1)).toMatchObject({ loop: false, next: 2 });
    expect(bodies.get(2)).toMatchObject({ loop: true });
  });

  it('a talk animation marks its frame and falls into the speech animation, whose mouths draw over the marked frame', () => {
    const mouth = (n: number) => ({ type: 'speechSprite' as const, width: 6, height: 4, png: `m${n}.png` });
    const s: SpriteJson = {
      anims: [0, 5],
      entries: [
        spr(1, 20, 60), { type: 'relPos', x: -2, y: 4 }, { type: 'mark' }, wait(160), { type: 'jump', target: 1 },
        mouth(1), { type: 'relPos', x: 1, y: -50 }, wait(160), mouth(2), wait(160), { type: 'jump', target: 1 },
      ],
    };
    const { bodies } = usedBodies(s, [0]);
    const talk = bodies.get(0)!;
    expect(talk.next).toBe(1);
    expect(talk.frames).toHaveLength(1);
    expect(talk.frames[0]).toMatchObject({ png: 'f1.png', dx: -2, dy: 4 });
    const speak = bodies.get(1)!;
    expect(speak.loop).toBe(true);
    expect(speak.frames.map(f => f.png)).toEqual(['f1.png', 'f1.png']);
    // (the mouth's bottom-centre is 50 px up and 1 across from the origin, the marked frame at (-2, 4): the frame's top-left is (-12, -56); the mouth's is (-2, -54))
    expect(speak.frames[0]!.overlay).toEqual({ png: 'm1.png', width: 6, height: 4, x: 10, y: 2 });
    expect(speak.frames[1]!.overlay).toMatchObject({ png: 'm2.png', x: 10, y: 2 });
  });

  it('skips speech frames until a frame has been marked, and stops at a pause', () => {
    const s: SpriteJson = {
      anims: [0],
      entries: [{ type: 'speechSprite', width: 6, height: 4, png: 'm.png' }, spr(1), wait(160), { type: 'pause' }, spr(2)],
    };
    const b = playAnim(s, 0).get(0)!;
    expect(b.frames.map(f => f.png)).toEqual(['f1.png']);
    expect(b.loop).toBe(false);
  });

  describe('a character that talks (replyAnims)', () => {
    const mouth = (n: number) => ({ type: 'speechSprite' as const, width: 6, height: 4, png: `m${n}.png` });
    // (animation 0 marks its frame and stops; animation 2 is mouths only, and jumps back to its first entry: the speech sprites need the mark animation 0 made)
    const body = (flag: number): SpriteJson => ({
      anims: [0, 5, 6, 10],
      entries: [
        { type: 'setFlag', flagId: flag } as never, spr(1, 20, 60), { type: 'mark' }, { type: 'pause' }, spr(9), { type: 'pause' },
        mouth(1), wait(160), mouth(2), wait(160), { type: 'jump', target: 2 }, spr(3), { type: 'pause' },
      ],
    });

    it('plays the talk animation from the starting one, so its mouths draw over the frame that one marked', () => {
      const s = body(0);
      expect(playAnim(s, 2).get(2)!.frames).toHaveLength(0);
      const talk = playAnim({ ...s, primed: { 2: 0 } }, 2).get(2)!;
      expect(talk.loop).toBe(true);
      expect(talk.frames.map(f => [f.png, f.overlay?.png])).toEqual([['f1.png', 'm1.png'], ['f1.png', 'm2.png']]);
    });

    it('puts a speech frame where the sprite\'s positions say: its own position replaces the object\'s, and the marked frame stays at the normal one (graphics.cpp drawSprite)', () => {
      const s: SpriteJson = {
        anims: [0, 4],
        entries: [
          spr(1, 20, 60), { type: 'position', x: 100, y: 200 }, { type: 'mark' }, { type: 'pause' },
          mouth(1), { type: 'position', x: 104, y: 150 }, wait(160), { type: 'jump', target: 1 },
        ],
      };
      const talk = playAnim({ ...s, primed: { 1: 0 } }, 1).get(1)!;
      // the body's top left is (100 - 10, 200 - 60); the mouth's (104 - 3, 150 - 4): 11 across and 6 down from the body's top
      expect(talk.frames[0]!.overlay).toMatchObject({ png: 'm1.png', x: 11, y: 6 });
    });

    it('reads the flags the script sets before it first stops, and picks the animation to go back to by them (kSpriteTalks 2, kSpriteIdle1 4, kSpriteCrew 0x10)', () => {
      expect(spriteFlags(body(0))).toBe(1);
      expect(replyAnims(body(0))).toEqual({ talk: 2, idle: 0 });
      expect(replyAnims(body(1))).toEqual({ talk: 2, idle: 3 });
      expect(replyAnims(body(2))).toEqual({ talk: 2, idle: 1 });
      expect(replyAnims(body(4))).toBeNull();
      // (a sprite without the idle animation it would go back to stays on the talk one; one without a talk animation does not talk)
      expect(replyAnims({ ...body(1), anims: [0, 5, 6] })).toEqual({ talk: 2, idle: -1 });
      expect(replyAnims({ ...body(1), anims: [0, 5] })).toBeNull();
    });
  });
});
