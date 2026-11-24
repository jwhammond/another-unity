// SPDX-License-Identifier: GPL-3.0-or-later
/** What the autosave needs of the game: when it may write, where the player is, and the write itself. */
export interface AutosaveTarget {
  readonly canAutosave: boolean;
  /** Changes with a screen or a ship station. */
  readonly whereabouts: string;
  autosave(): Promise<boolean>;
}

/** The page's events the autosave listens to (the real document and window; a test gives its own). */
export interface AutosaveEnv {
  document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

export interface AutosaveOptions {
  /** How often the game is written when nothing else asked (default a minute). */
  every?: number;
  /** How often it looks for a screen change, and for a moment it may write at (default a second). */
  poll?: number;
  env?: AutosaveEnv;
  onError?: (err: unknown) => void;
}

/**
 * Keeps the game written down for a phone that kills the tab: when the page is hidden or going away, at each screen
 * (or ship station) change, and every minute. A write is only made while the game is idle; one that was due in the
 * middle of a scene is made at the first idle moment after it (and a page hidden mid-scene resumes from the last
 * write, from before the scene).
 */
export class Autosave {
  private due = true;
  private busy = false;
  private last: string;
  private timer: unknown = null;
  private lastWrite = 0;
  /** How many writes have been made. */
  writes = 0;
  private readonly env: AutosaveEnv;
  private readonly every: number;
  private readonly poll: number;

  constructor(private readonly target: AutosaveTarget, private readonly opts: AutosaveOptions = {}) {
    this.env = opts.env ?? { document, window, setInterval: (f, ms) => setInterval(f, ms), clearInterval: id => clearInterval(id as ReturnType<typeof setInterval>) };
    this.every = opts.every ?? 60_000;
    this.poll = opts.poll ?? 1000;
    this.last = target.whereabouts;
  }

  private readonly onVisibility = (): void => {
    if (this.env.document.visibilityState === 'hidden') this.flush();
  };
  private readonly onPageHide = (): void => this.flush();

  start(): void {
    if (this.timer !== null) return;
    this.env.document.addEventListener('visibilitychange', this.onVisibility);
    this.env.window.addEventListener('pagehide', this.onPageHide);
    this.lastWrite = Date.now();
    this.timer = this.env.setInterval(() => this.step(), this.poll);
  }

  stop(): void {
    if (this.timer === null) return;
    this.env.document.removeEventListener('visibilitychange', this.onVisibility);
    this.env.window.removeEventListener('pagehide', this.onPageHide);
    this.env.clearInterval(this.timer);
    this.timer = null;
  }

  /** The page is going (or may go): writes now if the game is idle, else at its next idle moment. */
  flush(): void {
    this.due = true;
    this.write();
  }

  /** One look: a screen change or the minute makes a write due, and a due write is made once the game is idle. */
  step(now = Date.now()): void {
    const where = this.target.whereabouts;
    if (where !== this.last) {
      this.last = where;
      this.due = true;
    }
    if (now - this.lastWrite >= this.every) this.due = true;
    if (this.due) this.write(now);
  }

  private write(now = Date.now()): void {
    if (!this.due || this.busy || !this.target.canAutosave) return;
    this.busy = true;
    this.target.autosave().then(done => {
      if (done) {
        this.due = false;
        this.lastWrite = now;
        this.writes++;
      }
    }, err => this.opts.onError?.(err)).finally(() => { this.busy = false; });
  }
}

/**
 * Whether the autosave writes and resumes: for a player, including one on the dev server (a dev build), but not with the dev
 * tools (`?dev`, `?missions`), `?autostart` or an automated browser, which would find an old game in place of the new one they
 * asked for. `?autosave` asks for it anyway.
 */
export function autosaveEnabled(search: string, webdriver: boolean): boolean {
  const params = new URLSearchParams(search);
  if (params.has('autosave')) return true;
  return !(webdriver || params.has('dev') || params.has('autostart') || params.has('missions'));
}
