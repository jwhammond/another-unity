// SPDX-License-Identifier: GPL-3.0-or-later
/** What a ring holds: a decoded frame that must be closed when it leaves. */
export interface Closable {
  close(): void;
}

/**
 * A few decoded frames of an animation, ahead of the one being drawn: the current one and the next `ahead` (two by default). The caller says each time what it
 * wants now and what follows; frames that are no longer wanted are closed at once, wanted ones that are not decoded yet are decoded one at a time, in order,
 * and until a frame is there `want` says nothing: the caller holds what it has drawn (a frame that is late is never a blank one, and nothing waits for it).
 * A decode that finishes after its frame was dropped, or after the ring was disposed, is closed on arrival. A frame that fails to decode is not asked for again
 * until it has been out of the wanted set (it comes round again), so a bad file costs one try a lap, not one a frame.
 */
export class FrameRing<K, B extends Closable> {
  private readonly ready = new Map<K, B>();
  private readonly pending = new Set<K>();
  private readonly failed = new Set<K>();
  private wanted: K[] = [];
  private busy = 0;
  private done = false;
  private readonly ahead: number;
  private readonly concurrency: number;
  /** How many decodes have failed, for a log. */
  failures = 0;

  constructor(private readonly decode: (key: K) => Promise<B>, opts: { ahead?: number; concurrency?: number } = {}) {
    this.ahead = opts.ahead ?? 2;
    this.concurrency = opts.concurrency ?? 1;
  }

  /** Decoded frames held now. */
  get size(): number {
    return this.ready.size;
  }

  /** The current frame's decode if it is ready (the ring keeps it until it is no longer wanted); starts decoding what is missing, current first. */
  want(current: K, upcoming: readonly K[] = []): B | undefined {
    if (this.done) return undefined;
    const wanted: K[] = [];
    for (const k of [current, ...upcoming]) if (!wanted.includes(k) && wanted.length < 1 + this.ahead) wanted.push(k);
    this.wanted = wanted;
    this.trim();
    this.pump();
    return this.ready.get(current);
  }

  /** Nothing is wanted (the layer is hidden, or stopped): frees the decoded frames, asks for none. */
  idle(): void {
    this.wanted = [];
    this.trim();
  }

  /** Frees everything; what is still being decoded is closed when it arrives. */
  dispose(): void {
    this.done = true;
    this.wanted = [];
    this.trim();
    this.failed.clear();
  }

  private trim(): void {
    for (const [k, b] of [...this.ready]) {
      if (this.wanted.includes(k)) continue;
      this.ready.delete(k);
      b.close();
    }
    for (const k of [...this.failed]) if (!this.wanted.includes(k)) this.failed.delete(k);
  }

  private pump(): void {
    for (const k of this.wanted) {
      if (this.busy >= this.concurrency) return;
      if (this.ready.has(k) || this.pending.has(k) || this.failed.has(k)) continue;
      this.pending.add(k);
      this.busy++;
      // (a decoder that throws as it is called is a failed decode too)
      new Promise<B>(resolve => resolve(this.decode(k))).then(
        b => {
          this.busy--;
          this.pending.delete(k);
          if (this.done || !this.wanted.includes(k) || this.ready.has(k)) b.close();
          else this.ready.set(k, b);
          this.pump();
        },
        () => {
          this.busy--;
          this.pending.delete(k);
          this.failures++;
          if (!this.done && this.wanted.includes(k)) this.failed.add(k);
          this.pump();
        },
      );
    }
  }
}
