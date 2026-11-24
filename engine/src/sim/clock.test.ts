// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { Clock } from './clock';

describe('Clock', () => {
  it('resolves waits in due order, then in the order they were made', async () => {
    const clock = new Clock({ tick: 0 });
    const order: string[] = [];
    void clock.wait(2).then(() => order.push('a'));
    void clock.wait(1).then(() => order.push('b'));
    void clock.wait(2).then(() => order.push('c'));
    expect(clock.nextDue()).toBe(1);
    clock.advanceTo(2);
    await Promise.resolve();
    expect(order).toEqual(['b', 'a', 'c']);
    expect(clock.nextDue()).toBeUndefined();
  });

  it('waits at least one tick, and never moves backwards', () => {
    const store = { tick: 5 };
    const clock = new Clock(store);
    void clock.wait(0);
    expect(clock.nextDue()).toBe(6);
    clock.advanceTo(3);
    expect(clock.now).toBe(5);
    clock.advance();
    expect(store.tick).toBe(6);
  });
});
