// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { flush } from '../sim/settle';
import { PresentationClock } from './timeline';

describe('PresentationClock', () => {
  it('resolves waits as frames move time on', async () => {
    const clock = new PresentationClock();
    const done: string[] = [];
    void clock.after(1).then(() => done.push('one'));
    void clock.after(0.5).then(() => done.push('half'));
    clock.update(0.4);
    await flush();
    expect(done).toEqual([]);
    clock.update(0.2);
    await flush();
    expect(done).toEqual(['half']);
    clock.update(0.5);
    await flush();
    expect(done).toEqual(['half', 'one']);
    expect(clock.now).toBeCloseTo(1.1, 9);
  });

  it('ends a zero wait on the next frame, and tagged waits early on finish', async () => {
    const clock = new PresentationClock();
    const done: string[] = [];
    void clock.after(0).then(() => done.push('zero'));
    void clock.after(Infinity, 'say').then(() => done.push('say'));
    void clock.after(5).then(() => done.push('five'));
    await flush();
    expect(done).toEqual([]);
    clock.update(0);
    clock.finish('say');
    await flush();
    expect(done).toEqual(['zero', 'say']);
    expect(clock.pending).toBe(1);
  });
});
