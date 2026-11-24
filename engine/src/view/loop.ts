// SPDX-License-Identifier: GPL-3.0-or-later
export interface LoopOptions {
  /** Sim ticks per second (the sim's TICKS_PER_SECOND). */
  hz?: number;
  /** At most this many ticks a frame; after a stall (a hidden tab), the rest of the time is dropped. */
  maxTicksPerFrame?: number;
  /** Game speed: 1 is real time; tests run faster. */
  speed?: number;
}

/** The fixed-step loop: the sim ticks at a steady rate whatever the frame rate, and the view draws once a frame. */
export class FixedLoop {
  private gameSpeed = 1;
  private readonly stepMs: number;
  private readonly maxTicks: number;
  private last: number | null = null;
  private acc = 0;
  private handle: number | null = null;

  constructor(
    private readonly tick: () => void,
    private readonly frame: (dt: number, alpha: number) => void,
    opts: LoopOptions = {},
  ) {
    this.stepMs = 1000 / (opts.hz ?? 60);
    this.maxTicks = opts.maxTicksPerFrame ?? 10;
    this.speed = opts.speed ?? 1;
  }

  /** Game speed; a speed that would stop the game or break its timing (zero, negative, NaN, infinite) is 1. */
  get speed(): number {
    return this.gameSpeed;
  }

  set speed(speed: number) {
    this.gameSpeed = Number.isFinite(speed) && speed > 0 ? speed : 1;
  }

  /** One animation frame at `now` (milliseconds); returns how many ticks ran. */
  advance(now: number): number {
    const limit = this.stepMs * this.maxTicks;
    const elapsed = Math.min(this.last === null ? 0 : Math.max(0, now - this.last) * this.speed, limit);
    this.last = now;
    this.acc = Math.min(this.acc + elapsed, limit);
    let ticks = 0;
    // (the tolerance keeps 50 ms from coming out as 2.9999 ticks)
    while (this.acc + 1e-6 >= this.stepMs) {
      this.acc -= this.stepMs;
      this.tick();
      ticks++;
    }
    this.frame(elapsed / 1000, Math.max(0, this.acc) / this.stepMs);
    return ticks;
  }

  /** Whether the loop is driving the game (between start and stop). */
  get running(): boolean {
    return this.handle !== null;
  }

  start(): void {
    if (this.handle !== null) return;
    const loop = (now: number) => {
      this.handle = requestAnimationFrame(loop);
      this.advance(now);
    };
    this.handle = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.handle !== null) cancelAnimationFrame(this.handle);
    this.handle = null;
    this.last = null;
  }
}
