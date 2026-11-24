// SPDX-License-Identifier: GPL-3.0-or-later
/** Lets the world stop something part way: a walk, when the walker is halted or moved. */
export class StopSignal {
  private done = false;
  private readonly listeners: (() => void)[] = [];

  get stopped(): boolean {
    return this.done;
  }

  /** Called once when stopped; at once if it already is. */
  onStop(listener: () => void): void {
    if (this.done) listener();
    else this.listeners.push(listener);
  }

  stop(): void {
    if (this.done) return;
    this.done = true;
    for (const listener of this.listeners.splice(0)) listener();
  }
}
