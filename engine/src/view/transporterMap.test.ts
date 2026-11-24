// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { advanceLock, BLIP_SIZE, LOCK_STEP_MS, lockRects, MAP_LEFT, MAP_TOP, startLock } from './transporterMap';

const target = { x: 213, y: 339 };

describe('the map\'s lock-on', () => {
  it('steps every 0x14 of 291 ticks a second', () => {
    expect(LOCK_STEP_MS).toBeCloseTo(68.73, 2);
    const lock = startLock();
    advanceLock(lock, LOCK_STEP_MS - 1, target, true);
    expect(lock.y).toBe(MAP_TOP);
    advanceLock(lock, 2, target, true);
    expect(lock.y).toBe(MAP_TOP + 2);
  });

  it('crosses the rows, then the columns, to the target and says so once', () => {
    const lock = startLock();
    // (297 to 339 is 21 steps of two rows; 51 to 213 is 54 steps of three columns)
    expect(advanceLock(lock, 21 * LOCK_STEP_MS + 1, target, true)).toBe(false);
    expect([lock.stage, lock.y, lock.x]).toEqual([1, 339, MAP_LEFT]);
    expect(advanceLock(lock, 53 * LOCK_STEP_MS, target, true)).toBe(false);
    expect(lock.stage).toBe(1);
    expect(advanceLock(lock, 2 * LOCK_STEP_MS, target, true)).toBe(true);
    expect([lock.stage, lock.x, lock.y]).toEqual([2, 213, 339]);
    expect(advanceLock(lock, 10_000, target, true)).toBe(false);
  });

  it('catches up over a long frame, in the same steps', () => {
    const a = startLock();
    const b = startLock();
    advanceLock(a, 3000, target, true);
    for (let i = 0; i < 30; i++) advanceLock(b, 100, target, true);
    expect([a.stage, a.x, a.y]).toEqual([b.stage, b.x, b.y]);
  });

  it('rounds a row that overshoots the target\'s down to it (an odd row from an even step)', () => {
    const lock = startLock();
    advanceLock(lock, 100 * LOCK_STEP_MS, { x: 60, y: 300 }, true);
    expect(lock.y).toBe(300);
  });

  it('keeps scanning with nothing to find: the row wraps at the first target\'s row', () => {
    const lock = startLock();
    advanceLock(lock, 59 * LOCK_STEP_MS + 1, { x: 418, y: 415 }, false);
    expect(lock.stage).toBe(0);
    expect(lock.y).toBe(MAP_TOP);
    advanceLock(lock, 5 * LOCK_STEP_MS, { x: 418, y: 415 }, false);
    expect(lock.y).toBe(MAP_TOP + 10);
  });

  it('puts the lines and the blip where the original anchors them', () => {
    const lock = startLock();
    // (the row line at (234, lockY + 2) from its bottom centre: 366 wide, 2 high)
    expect(lockRects(lock, target)).toEqual({ across: [51, 297, 366, 2], down: null, blip: null });
    advanceLock(lock, 21 * LOCK_STEP_MS + 1, target, true);
    // (the column line at (lockX + 1, 414): two wide, 118 high)
    expect(lockRects(lock, target)).toEqual({ across: [51, 339, 366, 2], down: [51, 296, 2, 118], blip: null });
    advanceLock(lock, 60 * LOCK_STEP_MS, target, true);
    const r = lockRects(lock, target);
    expect(r.down).toEqual([213, 296, 2, 118]);
    // (the blip at (target.x, target.y + 19): its 38 square centred on the target)
    expect(r.blip).toEqual([213 - BLIP_SIZE[0] / 2, 339 + 19 - BLIP_SIZE[1], 38, 38]);
  });
});
