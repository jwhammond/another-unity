// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Sound's channels for the tests (Plan 28): audio/channels.ts' SoundChannels, which it matches by shape (engine/src/audio
 * is the DOM project's, this folder isn't). A sound plays until the test ends it (`end`). `log` lists each play as
 * [channel, url, bus, volume], and its pan after them when it has one; `cut` each channel whose sound was cut short, by stop
 * or by another play on it.
 */
export class FakeChannels {
  readonly log: ([number, string, string, number] | [number, string, string, number, number])[] = [];
  readonly cut: number[] = [];
  private readonly busy = new Set<number>();

  /** playOnChannel: the channel stopped, then `url` played there (255, the mixer's whole volume, by default). */
  play(channel: number, url: string | undefined, bus: string, volume = 255, pan?: number): boolean {
    this.stop(channel);
    if (url === undefined) return false;
    this.busy.add(channel);
    this.log.push(pan === undefined ? [channel, url, bus, volume] : [channel, url, bus, volume, pan]);
    return true;
  }

  playing(channel: number): boolean {
    return this.busy.has(channel);
  }

  stop(channel: number): void {
    if (this.busy.delete(channel)) this.cut.push(channel);
  }

  /** The sound on `channel` comes to its end. */
  end(channel: number): void {
    this.busy.delete(channel);
  }
}
