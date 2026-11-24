// SPDX-License-Identifier: GPL-3.0-or-later
import type { StopSignal } from './stop';

export const TICKS_PER_SECOND = 60;

interface Waiter {
  due: number;
  seq: number;
  resolve: () => void;
}

/** Simulation time in ticks. The tick lives in the store (the world state). */
export class Clock {
  private waiters: Waiter[] = [];
  private seq = 0;

  constructor(private readonly store: { tick: number }) {}

  get now(): number {
    return this.store.tick;
  }

  /** Resolves after `ticks` ticks (at least one), or as soon as `stop` is stopped. */
  wait(ticks: number, stop?: StopSignal): Promise<void> {
    // (NaN would never come due, and the action waiting on it would hang the queue for good)
    if (!Number.isFinite(ticks)) throw new RangeError(`cannot wait ${ticks} ticks`);
    const due = this.store.tick + Math.max(1, Math.ceil(ticks));
    return new Promise(resolve => {
      const waiter: Waiter = { due, seq: this.seq++, resolve };
      this.waiters.push(waiter);
      // (a stopped wait ends now, and leaves nothing behind for nextDue to jump to)
      stop?.onStop(() => {
        this.waiters = this.waiters.filter(w => w !== waiter);
        resolve();
      });
    });
  }

  nextDue(): number | undefined {
    return this.waiters.length > 0 ? Math.min(...this.waiters.map(w => w.due)) : undefined;
  }

  advance(): void {
    this.advanceTo(this.store.tick + 1);
  }

  advanceTo(tick: number): void {
    if (tick <= this.store.tick) return;
    this.store.tick = tick;
    const due = this.waiters.filter(w => w.due <= tick).sort((a, b) => a.due - b.due || a.seq - b.seq);
    this.waiters = this.waiters.filter(w => w.due > tick);
    for (const w of due) w.resolve();
  }
}
