// SPDX-License-Identifier: GPL-3.0-or-later
/** What a timed run reports (Plan 31 R4): the frame times after the warm-up, and the busiest frame's draw cost. */
export interface PerfReport {
  frames: number;
  /** The time the sampled frames took, in seconds. */
  seconds: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  worstMs: number;
  /** Frames over seconds: the rate the player sees, not the inverse of a percentile. */
  fps: number;
  maxCalls: number;
  maxTriangles: number;
  /** The run ended (the battle was over) before its duration: what it has is reported as it is. */
  short: boolean;
}

/** The first second of a run is not sampled: shaders compile and textures upload while it plays. */
export const WARM_UP_MS = 1000;

/** How long each stage before the timing (the wait for the game to be idle, then the wait for the battle to draw) may take. */
export const START_BUDGET_MS = 60_000;

/**
 * Whether a run that has not begun timing should stop and report short: its stage has run past `START_BUDGET_MS`, or the battle
 * it had seen is gone or resolved before it was drawn. Without it a battle that never starts leaves `perf()` null for ever.
 */
export function startGaveUp(o: { stageMs: number; seen: boolean; battle: 'live' | 'gone' | 'resolved' }): boolean {
  return o.stageMs > START_BUDGET_MS || (o.seen && o.battle !== 'live');
}

/** The value at the nearest rank `p` (0 to 1) of an ascending list. */
function nearestRank(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

/**
 * Times animation frames for a fixed duration after a warm-up. Each frame is given its timestamp (`now`, in ms) and the renderer's
 * draw calls and triangles for it; a frame's time is the gap since the one before.
 */
export class FrameSampler {
  private first: number | null = null;
  private previous = 0;
  private readonly times: number[] = [];
  private calls = 0;
  private triangles = 0;
  private started = false;
  private finished = false;
  private cut = false;

  constructor(private readonly durationMs: number) {}

  /** Whether the run has its duration (or was ended): frames after it are not kept. */
  get done(): boolean {
    return this.finished;
  }

  frame(now: number, info: { calls: number; triangles: number }): void {
    if (this.finished) return;
    this.first ??= now;
    const previous = this.previous;
    this.previous = now;
    if (now - this.first < WARM_UP_MS) return;
    // (the first frame past the warm-up only starts the clock: its gap from the frame before belongs to the warm-up)
    if (!this.started) {
      this.started = true;
      return;
    }
    this.times.push(now - previous);
    this.calls = Math.max(this.calls, info.calls);
    this.triangles = Math.max(this.triangles, info.triangles);
    if (now - this.first - WARM_UP_MS >= this.durationMs) this.finished = true;
  }

  /** The battle is over before the duration: the sampler is done, and its report short. */
  end(): void {
    if (this.finished) return;
    this.finished = true;
    this.cut = true;
  }

  report(): PerfReport {
    const sorted = [...this.times].sort((a, b) => a - b);
    const total = this.times.reduce((a, b) => a + b, 0);
    const frames = this.times.length;
    return {
      frames,
      seconds: total / 1000,
      meanMs: frames === 0 ? 0 : total / frames,
      p50Ms: nearestRank(sorted, 0.5),
      p95Ms: nearestRank(sorted, 0.95),
      p99Ms: nearestRank(sorted, 0.99),
      worstMs: sorted[sorted.length - 1] ?? 0,
      fps: total === 0 ? 0 : (frames * 1000) / total,
      maxCalls: this.calls,
      maxTriangles: this.triangles,
      short: this.cut,
    };
  }
}
