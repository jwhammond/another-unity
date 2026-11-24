// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { FrameRing } from './frameStream';

/** A decoder the test finishes by hand: what was asked for, in order, and which bitmaps are still open. */
function harness() {
  const asked: number[] = [];
  const open = new Set<number>();
  const waiting = new Map<number, { resolve(): void; reject(): void }>();
  let made = 0;
  const decode = (k: number) =>
    new Promise<{ id: number; key: number; close(): void }>((resolve, reject) => {
      asked.push(k);
      const bitmap = { id: ++made, key: k, close: () => { if (!open.delete(bitmap.id)) throw new Error('closed twice'); } };
      waiting.set(k, { resolve: () => { open.add(bitmap.id); resolve(bitmap); }, reject: () => reject(new Error('bad webp')) });
    });
  const finish = async (k: number) => { waiting.get(k)!.resolve(); waiting.delete(k); await Promise.resolve(); await Promise.resolve(); };
  const fail = async (k: number) => { waiting.get(k)!.reject(); waiting.delete(k); await Promise.resolve(); await Promise.resolve(); };
  return { asked, open, decode, finish, fail };
}

describe('FrameRing', () => {
  it('decodes the current frame first and then the next ones, in order, one at a time', async () => {
    const h = harness();
    const ring = new FrameRing(h.decode);
    expect(ring.want(5, [6, 7])).toBeUndefined();
    expect(h.asked).toEqual([5]);
    await h.finish(5);
    expect(h.asked).toEqual([5, 6]);
    await h.finish(6);
    await h.finish(7);
    expect(h.asked).toEqual([5, 6, 7]);
    expect(ring.want(5, [6, 7])!.key).toBe(5);
    expect(ring.size).toBe(3);
  });

  it('holds (returns nothing) while a frame is not decoded, and never asks for it twice', async () => {
    const h = harness();
    const ring = new FrameRing(h.decode);
    ring.want(1, [2]);
    expect(ring.want(1, [2])).toBeUndefined();
    expect(ring.want(1, [2])).toBeUndefined();
    expect(h.asked).toEqual([1]);
    await h.finish(1);
    expect(ring.want(1, [2])!.key).toBe(1);
  });

  it('closes a bitmap when it leaves the ring, and keeps at most the current frame and the two after it', async () => {
    const h = harness();
    const ring = new FrameRing(h.decode);
    ring.want(0, [1, 2]);
    for (const k of [0, 1, 2]) await h.finish(k);
    expect([...h.open].length).toBe(3);
    // (the next frame becomes current: 0 leaves, 3 is asked for)
    expect(ring.want(1, [2, 3])!.key).toBe(1);
    expect(h.asked).toEqual([0, 1, 2, 3]);
    expect([...h.open].length).toBe(2);
    await h.finish(3);
    expect(ring.size).toBe(3);
    expect([...h.open].length).toBe(3);
  });

  it('goes round a loop: a frame that left is decoded again when it comes back', async () => {
    const h = harness();
    const ring = new FrameRing(h.decode);
    ring.want(0, [1, 0]);
    await h.finish(0);
    await h.finish(1);
    ring.want(1, [0, 1]);
    ring.want(0, [1, 0]);
    // (0 and 1 are all the loop has: nothing is asked for twice)
    expect(h.asked).toEqual([0, 1]);
    ring.want(2, [3]);
    expect([...h.open].length).toBe(0);
    ring.want(0, [1]);
    expect(h.asked.slice(-1)).toEqual([2]);
  });

  it('follows a jump: what it no longer wants is closed, including a decode that finishes late', async () => {
    const h = harness();
    const ring = new FrameRing(h.decode);
    ring.want(0, [1, 2]);
    await h.finish(0);
    // (a script plays another animation while 1 is being decoded)
    expect(ring.want(10, [11])).toBeUndefined();
    expect([...h.open].length).toBe(0);
    await h.finish(1);
    expect([...h.open].length).toBe(0);
    // (10 waited for the decoder, which was busy with 1)
    expect(h.asked).toEqual([0, 1, 10]);
    await h.finish(10);
    expect(ring.want(10, [11])!.key).toBe(10);
  });

  it('closes everything when it stops, and asks again when it plays again', async () => {
    const h = harness();
    const ring = new FrameRing(h.decode);
    ring.want(0, [1]);
    await h.finish(0);
    await h.finish(1);
    ring.idle();
    expect(ring.size).toBe(0);
    expect(h.open.size).toBe(0);
    ring.want(0, [1]);
    expect(h.asked).toEqual([0, 1, 0]);
  });

  it('frees every bitmap on disposal, closes a decode that finishes after it, and asks for nothing more', async () => {
    const h = harness();
    const ring = new FrameRing(h.decode);
    ring.want(0, [1, 2]);
    await h.finish(0);
    ring.dispose();
    expect(h.open.size).toBe(0);
    await h.finish(1);
    expect(h.open.size).toBe(0);
    expect(ring.want(0, [1])).toBeUndefined();
    expect(h.asked).toEqual([0, 1]);
  });

  it('holds on a frame that fails to decode, and does not hammer it', async () => {
    const h = harness();
    const ring = new FrameRing(h.decode);
    ring.want(0, [1]);
    await h.fail(0);
    expect(ring.want(0, [1])).toBeUndefined();
    await h.finish(1);
    expect(h.asked).toEqual([0, 1]);
    expect(ring.failures).toBe(1);
    // (it is tried again when the frame comes round after leaving the ring)
    ring.want(5, []);
    await h.finish(5);
    ring.want(0, []);
    expect(h.asked.filter(k => k === 0)).toHaveLength(2);
  });
});
