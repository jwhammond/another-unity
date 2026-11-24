// SPDX-License-Identifier: GPL-3.0-or-later
/** The parts of the Screen Wake Lock API the game uses (a test gives its own). */
export interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}
export interface WakeLockEnv {
  nav: { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } };
  document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
}

/**
 * Keeps the screen on while the game is being played, where the browser can: the lock is taken on `acquire`, lost
 * when the page is hidden, and taken again when it is shown. A refusal (low battery, no support) is not an error.
 */
export class WakeLockKeeper {
  private sentinel: WakeLockSentinelLike | null = null;
  private wanted = false;
  private asking = false;
  /** How many times the browser granted the lock. */
  granted = 0;
  private readonly env: WakeLockEnv;

  constructor(env?: WakeLockEnv) {
    this.env = env ?? { nav: navigator as unknown as WakeLockEnv['nav'], document };
  }

  private readonly onVisibility = (): void => {
    if (this.env.document.visibilityState === 'visible') void this.request();
  };

  acquire(): void {
    if (this.wanted) return;
    this.wanted = true;
    this.env.document.addEventListener('visibilitychange', this.onVisibility);
    void this.request();
  }

  release(): void {
    this.wanted = false;
    this.env.document.removeEventListener('visibilitychange', this.onVisibility);
    const s = this.sentinel;
    this.sentinel = null;
    void s?.release().catch(() => {});
  }

  private async request(): Promise<void> {
    const lock = this.env.nav.wakeLock;
    if (!this.wanted || !lock || this.asking || (this.sentinel && !this.sentinel.released)) return;
    if (this.env.document.visibilityState !== 'visible') return;
    this.asking = true;
    try {
      const s = await lock.request('screen');
      this.granted++;
      s.addEventListener('release', () => {
        if (this.sentinel === s) this.sentinel = null;
      });
      // (released while it was being granted)
      if (!this.wanted) void s.release().catch(() => {});
      else this.sentinel = s;
    } catch {
      // (refused: the screen may dim, which is all)
    } finally {
      this.asking = false;
    }
  }
}
