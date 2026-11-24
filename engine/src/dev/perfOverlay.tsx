// SPDX-License-Identifier: GPL-3.0-or-later
import { render } from 'preact';

/**
 * The frame-rate overlay (Plan 34 Task 8): `?perf`, bare, for a look at a phone's frame rate where the perf runner can't go.
 * A chunk of its own, loaded only then (apps/web's main.ts), so a player never downloads it. `?perf=<scenario>` is the
 * perf runner's timed battle, not this.
 */

/** What the overlay reads of the renderer: its draw calls, counted over a whole frame (autoReset off, reset each frame). */
export interface PerfInfo {
  info: { autoReset: boolean; reset(): void; render: { calls: number } };
}

/** The overlay's figures: over the last second, and since it opened or was last tapped. */
export interface PerfReading {
  /** Frames a second, over the last second. */
  fps: number;
  /** The longest frame of the last second, in ms. */
  longestMs: number;
  /** The draw calls of the last second's busiest frame. */
  calls: number;
  /** The longest frame, and the busiest frame's draw calls, since the overlay opened or was tapped (a battle's first-frame stall stays shown). */
  worstMs: number;
  maxCalls: number;
}

/** How far back the overlay's figures look, in ms. */
export const WINDOW_MS = 1000;

/** Times frames (each animation frame's timestamp, and the draw calls the frame made) and sums them up. */
export class PerfMeter {
  private frames: { at: number; ms: number; calls: number }[] = [];
  private last: number | null = null;
  private worstMs = 0;
  private maxCalls = 0;

  frame(now: number, calls: number): void {
    if (this.last !== null) {
      const ms = now - this.last;
      this.frames.push({ at: now, ms, calls });
      this.worstMs = Math.max(this.worstMs, ms);
      this.maxCalls = Math.max(this.maxCalls, calls);
    }
    this.last = now;
    while (this.frames.length > 0 && this.frames[0]!.at <= now - WINDOW_MS) this.frames.shift();
  }

  read(): PerfReading {
    const span = this.frames.reduce((sum, f) => sum + f.ms, 0);
    return {
      fps: span > 0 ? (this.frames.length * 1000) / span : 0,
      longestMs: this.frames.reduce((m, f) => Math.max(m, f.ms), 0),
      calls: this.frames.reduce((m, f) => Math.max(m, f.calls), 0),
      worstMs: this.worstMs,
      maxCalls: this.maxCalls,
    };
  }

  /** Forgets the worst frame and the most calls (a tap on the overlay). */
  reset(): void {
    this.worstMs = 0;
    this.maxCalls = 0;
  }
}

/** The overlay's text, as it shows. */
export function PerfPanel({ reading, onReset }: { reading: PerfReading; onReset: () => void }) {
  const r = reading;
  return (
    <div
      class="au-perf"
      role="status"
      title="Tap to reset the worst frame"
      onClick={onReset}
      style="position:fixed;top:calc(env(safe-area-inset-top) + 4px);left:calc(env(safe-area-inset-left) + 4px);z-index:100000;padding:4px 6px;font:12px/1.3 ui-monospace,monospace;color:#9f9;background:rgba(0,0,0,.7);border-radius:4px;white-space:pre;cursor:pointer;user-select:none"
    >
      {`${r.fps.toFixed(0)} fps  longest ${r.longestMs.toFixed(0)} ms  ${r.calls} calls\nworst ${r.worstMs.toFixed(0)} ms  most ${r.maxCalls} calls`}
    </div>
  );
}

/** How often the text is redrawn, in ms (each frame is timed; the text needn't change as often). */
const SHOW_EVERY_MS = 250;

/**
 * Opens the overlay in `parent`: each animation frame is timed, with the draw calls the renderer made since the last
 * (renderer.info, kept from resetting at each render and reset here once a frame instead). Returns its close, which puts
 * the renderer's autoReset back as it found it.
 */
export function startPerfOverlay(renderer: PerfInfo, parent: HTMLElement, raf: (cb: (now: number) => void) => number = requestAnimationFrame): () => void {
  const meter = new PerfMeter();
  const host = parent.appendChild(document.createElement('div'));
  const autoReset = renderer.info.autoReset;
  renderer.info.autoReset = false;
  renderer.info.reset();
  let shown = -Infinity;
  let open = true;
  const show = () => render(<PerfPanel reading={meter.read()} onReset={() => { meter.reset(); show(); }} />, host);
  const frame = (now: number) => {
    if (!open) return;
    meter.frame(now, renderer.info.render.calls);
    renderer.info.reset();
    if (now - shown >= SHOW_EVERY_MS) {
      shown = now;
      show();
    }
    raf(frame);
  };
  show();
  raf(frame);
  return () => {
    open = false;
    renderer.info.autoReset = autoReset;
    render(null, host);
    host.remove();
  };
}
