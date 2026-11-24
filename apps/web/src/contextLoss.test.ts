// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindContextLoss } from './contextLoss';

describe('bindContextLoss', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    const canvas = new EventTarget() as unknown as HTMLCanvasElement;
    const calls: string[] = [];
    const off = bindContextLoss(canvas, { lost: () => calls.push('lost'), restored: () => calls.push('restored'), giveUp: () => calls.push('giveUp') }, 1000);
    const lose = () => {
      const e = new Event('webglcontextlost', { cancelable: true });
      canvas.dispatchEvent(e);
      return e;
    };
    return { canvas, calls, off, lose };
  };

  it('prevents the default (so the browser may restore it), saves, and carries on when the context returns', () => {
    const { canvas, calls, lose } = setup();
    expect(lose().defaultPrevented).toBe(true);
    expect(calls).toEqual(['lost']);
    vi.advanceTimersByTime(400);
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    vi.advanceTimersByTime(5000);
    expect(calls).toEqual(['lost', 'restored']);
  });

  it('gives up, to reload into the autosave, when the context never returns', () => {
    const { calls, lose } = setup();
    lose();
    vi.advanceTimersByTime(999);
    expect(calls).toEqual(['lost']);
    vi.advanceTimersByTime(2);
    expect(calls).toEqual(['lost', 'giveUp']);
  });

  it('takes its handlers off', () => {
    const { calls, off, lose } = setup();
    off();
    lose();
    expect(calls).toEqual([]);
  });
});
