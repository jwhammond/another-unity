// SPDX-License-Identifier: GPL-3.0-or-later
interface Wait {
  at: number;
  tag: string | undefined;
  resolve: () => void;
}

/**
 * Presentation time, in seconds, moved on by the frames. Subtitles, walks and visual effects end on it,
 * not on sim ticks, so the sim waits for the presentation (spec §7.1) and a click can cut a line short.
 */
export class PresentationClock {
  private time = 0;
  private waits: Wait[] = [];
  /**
   * How many presentation seconds pass per real second: the loop's game speed, set by whoever drives `update`.
   * Pausing is done by not calling `update`, not by a zero speed. Things that take real time (a voice) scale their waits by it.
   */
  speed = 1;

  get now(): number {
    return this.time;
  }

  get pending(): number {
    return this.waits.length;
  }

  update(dt: number): void {
    this.time += Math.max(0, dt);
    const due = this.waits.filter(w => w.at <= this.time);
    this.waits = this.waits.filter(w => w.at > this.time);
    for (const w of due) w.resolve();
  }

  /** Resolves once `seconds` have passed (on the next frame for 0; for Infinity, only when finished by tag). */
  after(seconds: number, tag?: string): Promise<void> {
    return new Promise(resolve => this.waits.push({ at: this.time + Math.max(0, seconds), tag, resolve }));
  }

  /** Ends every wait with this tag now: a click skipping a line. */
  finish(tag: string): void {
    const done = this.waits.filter(w => w.tag === tag);
    this.waits = this.waits.filter(w => w.tag !== tag);
    for (const w of done) w.resolve();
  }
}
