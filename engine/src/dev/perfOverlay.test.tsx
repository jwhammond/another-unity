// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { PerfMeter, startPerfOverlay, type PerfInfo } from './perfOverlay';

describe('PerfMeter (Plan 34 Task 8)', () => {
  it('gives the last second\'s fps, longest frame and busiest frame, and keeps the worst since a reset', () => {
    const m = new PerfMeter();
    // (a 600 ms stall, then 16 ms frames for over a second)
    m.frame(0, 0);
    m.frame(600, 40);
    let t = 600;
    for (let i = 0; i < 70; i++) m.frame((t += 16), i === 2 ? 95 : 30);
    const r = m.read();
    expect(r.longestMs).toBe(16);
    expect(r.fps).toBeCloseTo(62.5, 6);
    expect([r.worstMs, r.maxCalls]).toEqual([600, 95]);
    // (the busiest frame has left the last second)
    expect(r.calls).toBe(30);
    m.reset();
    expect(m.read()).toMatchObject({ worstMs: 0, maxCalls: 0, longestMs: 16 });
    expect(new PerfMeter().read()).toEqual({ fps: 0, longestMs: 0, calls: 0, worstMs: 0, maxCalls: 0 });
  });
});

describe('startPerfOverlay (Plan 34 Task 8)', () => {
  it('reports the draw calls of the busiest frame from renderer.info, counted over the whole frame', () => {
    const resets: number[] = [];
    const renderer: PerfInfo = { info: { autoReset: true, reset() { resets.push(this.render.calls); this.render.calls = 0; }, render: { calls: 0 } } };
    const frames: ((now: number) => void)[] = [];
    const close = startPerfOverlay(renderer, document.body, cb => frames.push(cb));
    // (counted across a frame's renders, not reset at each)
    expect(renderer.info.autoReset).toBe(false);
    const step = (now: number, calls: number) => {
      renderer.info.render.calls = calls;
      frames.shift()!(now);
    };
    step(0, 3);
    step(16, 42);
    step(300, 77);
    step(316, 12);
    step(600, 5);
    const text = document.querySelector('.au-perf')!.textContent!;
    expect(text).toContain('77 calls');
    expect(text).toContain('longest 284 ms');
    expect(resets).toEqual([0, 3, 42, 77, 12, 5]);
    // (a tap forgets the worst)
    (document.querySelector('.au-perf') as HTMLElement).click();
    expect(document.querySelector('.au-perf')!.textContent).toContain('worst 0 ms');
    close();
    expect([renderer.info.autoReset, document.querySelector('.au-perf')]).toEqual([true, null]);
    // (as it found it: a renderer that wasn't resetting by itself stays so)
    renderer.info.autoReset = false;
    startPerfOverlay(renderer, document.body, () => 0)();
    expect(renderer.info.autoReset).toBe(false);
  });
});
