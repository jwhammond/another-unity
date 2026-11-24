// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { Raycaster, Texture, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { ACTOR_HEIGHT, ActorView, CardPlayer, animFor, clockDirection } from './actors';
import type { CardAnim } from './art';

const card = (frames = 1) => ({
  texture: new Texture({ width: 100 * frames, height: 200 } as unknown as HTMLImageElement),
  frames,
  anchor: [0.5, 1] as [number, number],
});

describe('ActorView.setCard', () => {
  it("anchors the sprite's bottom centre on the floor and keeps the capsule pickable; null restores it", () => {
    const a = new ActorView('picard', 0xffffff, null);
    a.place({ x: 2, z: 3 });
    a.setCard(card(2));
    const sprite = a.card!;
    expect(sprite.center.toArray()).toEqual([0.5, 0]);
    expect(sprite.position.toArray()).toEqual([0, 0, 0]);
    expect(sprite.scale.y).toBe(ACTOR_HEIGHT);
    // (a frame is a half of the image: 100 x 200, so half as wide as tall)
    expect(sprite.scale.x).toBeCloseTo(ACTOR_HEIGHT / 2);
    expect(sprite.material.map!.repeat.toArray()).toEqual([0.5, 1]);
    // (the capsule draws nothing, but a ray still hits it)
    expect(a.body.material.visible).toBe(false);
    a.group.updateMatrixWorld(true);
    const ray = new Raycaster(new Vector3(2, 0.9, 10), new Vector3(0, 0, -1));
    expect(ray.intersectObject(a.body).length).toBeGreaterThan(0);
    a.setCard(null);
    expect(a.card).toBeNull();
    expect(a.group.children).toEqual([a.body]);
    expect(a.body.material.visible).toBe(true);
  });

  it('follows the capsule: opacity and highlight, and lying down about its middle', () => {
    const a = new ActorView('picard', 0xffffff, null);
    a.setCard(card());
    a.setOpacity(0.4);
    expect(a.card!.material.opacity).toBe(0.4);
    a.setHighlight(true);
    expect(a.card!.material.color.getHex()).not.toBe(0xffffff);
    a.setDown(true);
    expect(a.card!.material.rotation).toBeCloseTo(Math.PI / 2);
    expect(a.card!.center.toArray()).toEqual([0.5, 0.5]);
    a.setDown(false);
    expect(a.card!.material.rotation).toBe(0);
    expect(a.card!.center.toArray()).toEqual([0.5, 0]);
    expect(a.card!.position.y).toBe(0);
  });
});

const anim = (frames: number, over: Partial<CardAnim> = {}): CardAnim => ({
  url: 'a.webp', frames, cell: [200, 600], anchor: [0.5, 0.9], delays: Array.from({ length: frames }, () => 100), loop: true, ...over,
});

describe('clockDirection', () => {
  it('maps up to 0, right to 3, down to 6, left to 9', () => {
    expect(clockDirection(0, 1)).toBe(0);
    expect(clockDirection(1, 0)).toBe(3);
    expect(clockDirection(0, -1)).toBe(6);
    expect(clockDirection(-1, 0)).toBe(9);
    // (the diagonals, and 30 degree steps in pixels: NDC is 640 by 480)
    expect(clockDirection(0.5, 1)).toBe(1);
    expect(clockDirection(-0.5, -1)).toBe(7);
    expect(clockDirection(-0.001, 1)).toBe(0);
    expect(clockDirection(-0.5, 1)).toBe(11);
  });
});

describe('CardPlayer', () => {
  /** Walks 0-11 (each its own 4 frames of 100 ms), stands 24-29 (2 frames, falling into 40), and 40 (a loop). */
  const walks: Record<number, CardAnim> = {};
  for (let d = 0; d < 12; d++) walks[d] = anim(4, { url: `w${d}.webp` });
  const make = (extra: Record<number, CardAnim> = {}) => {
    let now = 0;
    const anims: Record<number, CardAnim> = { ...walks, 24: anim(1, { loop: false, next: 40 }), 25: anim(1, { loop: false, next: 40 }), 26: anim(1, { loop: false, next: 40 }), 27: anim(2, { loop: false, next: 40 }), 28: anim(1, { loop: false, next: 40 }), 29: anim(1, { loop: false, next: 40 }), 40: anim(3), ...extra };
    const player = new CardPlayer({ anims }, () => now);
    return { player, at: (t: number) => { now = t; } };
  };

  it("walks through the walk anim's frames on its delays, and stops on the matching stand", () => {
    const { player, at } = make();
    player.set({ kind: 'walk', dir: 3 });
    expect(player.frame()).toMatchObject({ anim: 3, index: 0, uv: [0, 0, 0.25, 1], anchor: [0.5, 0.9], cell: [200, 600] });
    at(150);
    expect(player.frame()).toMatchObject({ anim: 3, index: 1, uv: [0.25, 0, 0.5, 1] });
    at(399);
    expect(player.frame()!.index).toBe(3);
    // (a walk loops)
    at(450);
    expect(player.frame()).toMatchObject({ anim: 3, index: 0 });
    // (stopping: the stand for that direction, from its start)
    player.set({ kind: 'stand', dir: 3 });
    expect(player.frame()).toMatchObject({ anim: 25, index: 0 });
    at(560);
    // (the stand ends and falls into the animation the original jumps to)
    expect(player.frame()).toMatchObject({ anim: 40, index: 0 });
    at(700);
    expect(player.frame()).toMatchObject({ anim: 40, index: 1 });
    // (setting the same state again doesn't restart it)
    player.set({ kind: 'stand', dir: 3 });
    expect(player.frame()).toMatchObject({ anim: 40, index: 1 });
  });

  it('holds an animation on a frame, as the original pauses its sprite while a phaser beam is drawn, and goes on from that frame when it lets go', () => {
    // (a firing animation: six frames of 100 ms that fall into the idle loop 40)
    const { player, at } = make({ 15: anim(6, { loop: false, next: 40 }) });
    expect(player.has(15)).toBe(true);
    expect(player.has(16)).toBe(false);
    expect(player.startOf(15, 3)).toBe(300);
    player.set({ kind: 'anim', index: 15 });
    at(300);
    player.hold(3);
    expect(player.frame()).toMatchObject({ anim: 15, index: 3 });
    // (a second of beam later it is on the same frame)
    at(1300);
    expect(player.frame()).toMatchObject({ anim: 15, index: 3 });
    player.release();
    expect(player.frame()).toMatchObject({ anim: 15, index: 3 });
    at(1450);
    expect(player.frame()).toMatchObject({ anim: 15, index: 4 });
    // (and it ends as it would have, into the animation it jumps to)
    at(1650);
    expect(player.frame()).toMatchObject({ anim: 40, index: 0 });
  });

  it('a strip that wraps into rows gives each cell its place: the first row is the top of the image', () => {
    let now = 0;
    const player = new CardPlayer({ anims: { 5: anim(5, { columns: 2 }) } }, () => now);
    player.set({ kind: 'anim', index: 5 });
    const near = (got: number[], want: number[]) => want.forEach((w, i) => expect(got[i]).toBeCloseTo(w, 9));
    near(player.frame()!.uv, [0, 2 / 3, 0.5, 1]);
    now = 100;
    near(player.frame()!.uv, [0.5, 2 / 3, 1, 1]);
    now = 200;
    near(player.frame()!.uv, [0, 1 / 3, 0.5, 2 / 3]);
    now = 400;
    near(player.frame()!.uv, [0, 0, 0.5, 1 / 3]);
  });

  it('a non-looping animation with nothing after it holds its last frame', () => {
    const { player, at } = make({ 30: anim(3, { loop: false }) });
    player.set({ kind: 'anim', index: 30 });
    at(5000);
    expect(player.frame()).toMatchObject({ anim: 30, index: 2 });
  });

  it('talk and turn pick the side\'s anims; a missing anim falls back to the nearest stand', () => {
    const talk = { front: 0x1e, right: 0x25, left: 0x2f };
    const { player } = make({ [talk.right]: anim(2), [talk.left]: anim(2), [0x29]: anim(2, { loop: false }), [0x2a]: anim(2, { loop: false }), [0x4d]: anim(2, { loop: false }), [0x24]: anim(1) });
    expect(animFor({ kind: 'talk', side: 'front' })).toBe(0x1e);
    expect(animFor({ kind: 'talk', side: 'right' })).toBe(0x25);
    expect(animFor({ kind: 'talk', side: 'left' })).toBe(0x2f);
    expect(animFor({ kind: 'idle', side: 'left' })).toBe(0x2e);
    expect(animFor({ kind: 'end', side: 'left' })).toBe(0x1b);
    expect(animFor({ kind: 'turn', side: 'right' })).toBe(0x29);
    expect(animFor({ kind: 'turn', side: 'left' })).toBe(0x2a);
    expect(animFor({ kind: 'walk', dir: 5 })).toBe(5);
    expect(animFor({ kind: 'stand', dir: 11 })).toBe(29);
    player.set({ kind: 'talk', side: 'right' });
    expect(player.frame()!.anim).toBe(0x25);
    player.set({ kind: 'turn', side: 'left' });
    expect(player.frame()!.anim).toBe(0x2a);
    player.set({ kind: 'end', side: 'front' });
    expect(player.frame()!.anim).toBe(0x4d);
    // (no front talk in this card: the front stand, 27)
    player.set({ kind: 'talk', side: 'front' });
    expect(player.frame()!.anim).toBe(27);
    // (a walk that is missing falls to the stand nearest its direction)
    const walkless = new CardPlayer({ anims: { 24: anim(1), 29: anim(1) } }, () => 0);
    walkless.set({ kind: 'walk', dir: 11 });
    expect(walkless.frame()!.anim).toBe(29);
    walkless.set({ kind: 'walk', dir: 1 });
    expect(walkless.frame()!.anim).toBe(24);
    // (a card without animations has no frame)
    const none = new CardPlayer({}, () => 0);
    none.set({ kind: 'talk', side: 'front' });
    expect(none.frame()).toBeNull();
  });
});

describe('ActorView with an animated card', () => {
  it('sizes the card from its cell at the room\'s pixel size, puts the feet at the animation\'s anchor, and the name tag over its head', () => {
    const a = new ActorView('picard', 0xffffff, null);
    const strips = new Map<number, Texture>();
    const strip = (n: number) => strips.get(n);
    const player = new CardPlayer({ anims: { 27: anim(2, { cell: [200, 680], anchor: [0.5, 0.9] }) } }, () => 0);
    player.set({ kind: 'stand', dir: 6 });
    a.setCard({ ...card(1), pixelHeight: 168, player, strip });
    a.setPixelMetres(0.01);
    // (until the strip loads, the still: pixelHeight tall)
    expect(a.card!.scale.y).toBeCloseTo(1.68);
    strips.set(27, new Texture({ width: 400, height: 680 } as unknown as HTMLImageElement));
    a.updateCard();
    // (a 200x680 cell at 4x is 50x170 original pixels, 0.01 m each)
    expect(a.card!.scale.x).toBeCloseTo(0.5);
    expect(a.card!.scale.y).toBeCloseTo(1.7);
    expect(a.card!.center.x).toBeCloseTo(0.5);
    expect(a.card!.center.y).toBeCloseTo(0.1);
    expect(a.card!.material.map).toBe(strips.get(27));
    expect(strips.get(27)!.repeat.x).toBeCloseTo(0.5);
    // (the top of the card is 0.9 of the cell above the feet)
    expect(a.headHeight()).toBeCloseTo(1.7 * 0.9);
    // (a different pixel size rescales it)
    a.setPixelMetres(0.02);
    expect(a.card!.scale.y).toBeCloseTo(3.4);
  });
});
