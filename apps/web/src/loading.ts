// SPDX-License-Identifier: GPL-3.0-or-later
/** What the player chose at the loading screen: carry on from the autosave, begin again, or load one of the save slots. */
export type StartChoice = 'continue' | 'new' | { slot: number };

/** A save slot offered on the loading screen (the save menu's own slots, not the autosave). */
export interface SavedGame {
  readonly slot: number;
  readonly label: string;
}

/** A step of the start. The bar gives each step the same share, whatever it costs: step k of n fills the k-th n-th, and inside it moves by what is counted, or creeps. */
export interface LoadingStep {
  readonly label: string;
}

/** The steps before the game is up, in order; each starts when the one before has finished. */
export const LOADING_STEPS: readonly LoadingStep[] = [
  // (the script and library files, counted as they arrive)
  { label: 'Fetching the engine' },
  // (the game package: several files, and in dev a lot of data; counted and, in between, crept)
  { label: 'Loading game data' },
  { label: 'Starting the display' },
  { label: 'Opening saves' },
  { label: 'Building the world' },
  { label: 'Loading rooms' },
  // (the first room's art files, counted as they arrive)
  { label: 'Loading art' },
];

/** How long, in ms, the creep in a step with nothing to measure takes to cover about two thirds of its way. */
export const EASE_TAU = 3000;

/** The creep reaches at most this part of a step: only the step's real end gets it the rest of the way. */
export const EASE_LIMIT = 0.9;

/** The bar and percentage stay under this until loading is done. */
const MOST_BEFORE_DONE = 0.999;

/** How far, 0 to EASE_LIMIT, a step with no measure of itself has crept after `elapsed` ms. */
export function easeWithin(elapsed: number, tau = EASE_TAU): number {
  return EASE_LIMIT * (1 - Math.exp(-Math.max(elapsed, 0) / tau));
}

/** How far loading is: the steps finished, each an equal share of the bar, and the part of the current one reported from inside it (never past its own share). */
export class LoadingProgress {
  private index = -1;
  private within = 0;
  private began = 0;
  private shown = 0;
  private finished = false;
  private problem: string | null = null;
  private waiting = false;
  private starter: { onStart?: () => void; resolve: (choice: StartChoice) => void } | null = null;
  /** True when an autosave waits: Start becomes Continue, and a smaller button starts a new game instead. */
  resumable = false;
  /** The save slots to offer under a Load game button (set before `done`; none, no button). */
  saved: readonly SavedGame[] = [];
  /** False when a person must press Start once loaded: bindLoading sets it (true without a screen, in tests and dev starts). */
  autostart = true;

  constructor(
    private readonly steps: readonly LoadingStep[] = LOADING_STEPS,
    private readonly changed: (p: LoadingProgress) => void = () => {},
    private readonly now: () => number = () => (typeof performance === 'undefined' ? Date.now() : performance.now()),
    /** How slowly a step with nothing to measure creeps towards its end, in ms (it gets about two thirds of the way in this long). */
    private readonly tau = EASE_TAU,
  ) {}

  /** A step begins (the one named, or the next if the name is not one of the steps); one already begun is only kept. */
  begin(label: string): void {
    if (this.finished || this.problem !== null) return;
    const at = this.steps.findIndex(s => s.label === label);
    const next = at >= 0 ? at : this.index + 1;
    if (next < this.index || (next === this.index && at >= 0)) return;
    this.index = next;
    this.within = 0;
    this.began = this.now();
    this.changed(this);
  }

  /** Asks the screen to redraw: the creep inside a step moves with time, though nothing was reported. */
  refresh(): void {
    if (this.finished || this.problem !== null || this.index < 0) return;
    this.changed(this);
  }

  /** How far through the current step: 0 to 1 (never less than before). With `label`, only if that is the current step (a late report from an earlier one is dropped). */
  part(within: number, label?: string): void {
    if (this.finished || this.problem !== null || this.index < 0) return;
    if (label !== undefined && this.steps[this.index]?.label !== label) return;
    const w = Math.min(Math.max(Number.isFinite(within) ? within : 0, 0), 1);
    if (w <= this.within) return;
    this.within = w;
    this.changed(this);
  }

  /** Loading is over. The screen then waits for Start (unless `autostart`, or `wait` is false: an error in place of the game). */
  done(wait = true): void {
    this.finished = true;
    this.waiting = wait && !this.autostart && !this.failed;
    this.changed(this);
  }

  /** True while loaded and waiting for the player to press Start. */
  get isWaiting(): boolean {
    return this.waiting;
  }

  /**
   * Settles when the game may be shown: at once when no one need press Start, else when they do. `onStart` runs inside
   * the press itself, which is the user gesture that audio, fullscreen and orientation lock need. The answer is
   * which way the game starts: 'continue' unless an autosave was offered and the player chose to begin again.
   */
  waitForStart(onStart?: () => void): Promise<StartChoice> {
    if (!this.waiting) return Promise.resolve('continue');
    return new Promise<StartChoice>(resolve => {
      this.starter = { onStart, resolve };
    });
  }

  /** The player pressed Start (or Continue); with `choice` 'new', the smaller New game button, or a slot chosen under Load game. */
  start(choice: StartChoice = 'continue'): void {
    if (!this.waiting) return;
    this.waiting = false;
    const starter = this.starter;
    this.starter = null;
    try {
      starter?.onStart?.();
    } finally {
      this.changed(this);
      starter?.resolve(choice);
    }
  }

  /** Which step it is on (0-based; -1 before the first). */
  get step(): number {
    return this.index;
  }

  /** The whole number shown: 0 to 100, and 100 only once loading is really done (a step's end is never rounded up to it). */
  get percent(): number {
    if (this.finished) return 100;
    return Math.min(99, Math.floor(this.fraction * 100));
  }

  private note: string | null = null;

  fail(err: unknown): void {
    this.problem = err instanceof Error ? err.message : String(err);
    this.changed(this);
  }

  /**
   * 0 to 1, and never going back: step k of n fills the k-th n-th. Inside it the bar is as far as the step has reported,
   * or as far as the creep has got (towards 0.9 of the step, never its end), whichever is more; and before `done` it
   * stays under 1.
   */
  get fraction(): number {
    if (this.finished) return 1;
    const at = Math.min(Math.max(this.index, 0), this.steps.length - 1);
    const creep = this.index < 0 ? 0 : easeWithin(this.now() - this.began, this.tau);
    const within = this.index < 0 ? 0 : Math.max(this.within, creep);
    const raw = (at + within) / this.steps.length;
    this.shown = Math.max(this.shown, Math.min(raw, MOST_BEFORE_DONE));
    return this.shown;
  }

  /** A line shown in place of the step's name ("Updating…" while a new version takes over); null puts the step back. */
  setNote(note: string | null): void {
    this.note = note;
    this.changed(this);
  }

  get label(): string {
    if (this.problem !== null) return `Could not start: ${this.problem}`;
    if (this.finished) return 'Ready';
    if (this.note !== null) return this.note;
    return this.index < 0 ? 'Loading' : `${this.steps[Math.min(this.index, this.steps.length - 1)]!.label}…`;
  }

  get failed(): boolean {
    return this.problem !== null;
  }

  get isDone(): boolean {
    return this.finished;
  }
}

/** Generic status lines, a new one as each step begins and every few seconds in a long one; none quotes anything. */
export const FLAVOUR = [
  'Initialising the interface',
  'Opening hailing frequencies',
  'Calibrating inertial dampers',
  'Aligning the warp field',
  'Charging the transporter buffers',
  'Polarising the hull plating',
  'Synchronising the chronometers',
  'Routing power to the main deflector',
  'Running a level three diagnostic',
  'Recalibrating the long range sensors',
  'Stabilising the plasma conduits',
  'Cross-checking the star charts',
  'Warming up the replicators',
  'Balancing the antimatter flow',
  'Tuning the subspace transceiver',
  'Engaging the structural integrity field',
  'Compensating for gravimetric shear',
  'Pressurising the airlocks',
  'Scanning for navigational hazards',
  'Verifying the shield harmonics',
  'Mapping the surrounding sector',
  'Priming the phaser banks',
  'Standing by for the next order',
] as const;

/** Whether the game starts at once, without a Start button: a dev start, ?autostart, or an automated browser (so tests are never held up). */
export function autostartFor(search: string, webdriver: boolean): boolean {
  const params = new URLSearchParams(search);
  // (?autosave asks for the player's start, with its Continue: see autosaveEnabled)
  if (params.has('autosave')) return false;
  return webdriver || params.has('dev') || params.has('autostart');
}

/** How long each flavour line stays up, in ms (and the typing of it is slower than this by far). */
export const FLAVOUR_EVERY = 4800;

const bound = new WeakMap<Element, LoadingProgress>();

/**
 * The loading screen index.html ships (`#loading`, painted before any script runs): shows the progress, a message in
 * place of the steps' dry names, a Start button when loaded, and an error in place of a blank page. Without the element
 * it only counts. The same screen gives the same progress, so boot.ts and main.ts share it.
 */
export function bindLoading(doc: Document = document): LoadingProgress {
  const root = doc.getElementById('loading');
  const known = root ? bound.get(root) : undefined;
  if (known) return known;
  const view = doc.defaultView;
  const reduced = view?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const bar = root?.querySelector<HTMLElement>('.au-loading-bar');
  const fill = root?.querySelector<HTMLElement>('.au-loading-fill');
  const text = root?.querySelector<HTMLElement>('.au-loading-text') ?? root?.querySelector<HTMLElement>('.au-loading-status');
  const flavor = root?.querySelector<HTMLElement>('.lc-flavor');
  const startButton = root?.querySelector<HTMLButtonElement>('.lc-start');
  const newButton = root?.querySelector<HTMLButtonElement>('.lc-new');
  const loadButton = root?.querySelector<HTMLButtonElement>('.lc-load');
  const slotList = root?.querySelector<HTMLElement>('.lc-slots');
  const filesButton = root?.querySelector<HTMLButtonElement>('.lc-files');
  const pct = root?.querySelector<HTMLElement>('[data-read="pct"]');
  const typing = new Typewriter(flavor ?? null, reduced);
  let message = 0;
  let timers: ReturnType<typeof setInterval>[] = [];
  let faded = false;
  const nextMessage = () => typing.show(FLAVOUR[message++ % FLAVOUR.length]!);
  const progress = new LoadingProgress(LOADING_STEPS, p => {
    if (!root) return;
    const percent = p.percent;
    if (fill) fill.style.width = `${p.isDone ? 100 : Math.round(p.fraction * 1000) / 10}%`;
    bar?.setAttribute('aria-valuenow', String(percent));
    if (pct) pct.textContent = String(percent).padStart(3, '0');
    // (the whole number, then the step's name; a failure is only its own message)
    if (text) text.textContent = p.failed ? p.label : `${percent}% ${p.label}`;
    root.classList.toggle('au-loading-failed', p.failed);
    if (p.isDone || p.failed) {
      timers.forEach(clearInterval);
      timers = [];
      typing.stop();
    }
    if (p.isWaiting) {
      root.classList.add('au-loading-ready');
      // (an autosave waits: Start is Continue, and a smaller button begins again)
      root.classList.toggle('au-loading-resume', p.resumable);
      if (startButton) startButton.textContent = p.resumable ? 'Continue' : 'Start';
      if (flavor) flavor.textContent = p.resumable ? 'Your game is waiting' : 'All systems ready';
      // (saved games: a Load game button, and the slots it opens, one button each)
      root.classList.toggle('au-loading-saves', p.saved.length > 0);
      if (slotList && slotList.childElementCount === 0) {
        for (const g of p.saved) {
          const b = doc.createElement('button');
          b.type = 'button';
          b.className = 'lc-slot';
          b.textContent = `${g.slot}  ${g.label}`;
          b.setAttribute('aria-label', `Load slot ${g.slot}`);
          b.addEventListener('click', () => progress.start({ slot: g.slot }));
          slotList.appendChild(b);
        }
      }
      startButton?.focus();
    }
    if (p.isDone && !p.isWaiting && !faded) {
      faded = true;
      // (it stops catching the pointer at once: the fade must never sit between a click and the game)
      root.classList.remove('au-loading-ready');
      root.classList.add('au-loading-done');
      const remove = () => root.remove();
      root.addEventListener('transitionend', remove, { once: true });
      setTimeout(remove, 700);
    }
  });
  if (root) {
    progress.autostart = autostartFor(view?.location?.search ?? '', view?.navigator?.webdriver ?? false);
    bound.set(root, progress);
    nextMessage();
    // (a new line only every few seconds, whatever the steps do: each is read at leisure)
    timers.push(setInterval(nextMessage, FLAVOUR_EVERY));
    if (!reduced) timers.push(setInterval(() => tick(root), 420));
    // (a step with nothing to count creeps on with the clock)
    timers.push(setInterval(() => progress.refresh(), 200));
    startButton?.addEventListener('click', () => progress.start());
    newButton?.addEventListener('click', () => progress.start('new'));
    loadButton?.addEventListener('click', () => {
      const open = root.classList.toggle('au-loading-slots');
      loadButton.setAttribute('aria-expanded', String(open));
      if (open) slotList?.querySelector<HTMLElement>('.lc-slot')?.focus();
    });
    doc.addEventListener('keydown', e => {
      // (Enter or Space starts, wherever the focus is; on the button itself the click does it)
      // (Enter on Game files… is that button's own)
      if (!progress.isWaiting || (e.key !== 'Enter' && e.key !== ' ') || e.target === startButton || e.target === filesButton) return;
      e.preventDefault();
      progress.start();
    });
  }
  return progress;
}

/**
 * The start screen's "Game files…" (the deploy build's unity only: main.ts): the player's CD is asked for again. Shown with Start, and
 * with a failure; `choose` runs on its press. Without the screen, nothing.
 */
export function offerGameFiles(choose: () => void, doc: Document = document): void {
  const root = doc.getElementById('loading');
  const button = root?.querySelector<HTMLButtonElement>('.lc-files');
  if (!root || !button) return;
  root.classList.add('au-loading-files');
  button.addEventListener('click', () => choose());
}

/** Types a line out a letter at a time (all at once with reduced motion). */
export class Typewriter {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly el: HTMLElement | null, private readonly reduced: boolean, private readonly every = 55) {}

  show(line: string): void {
    this.stop();
    if (!this.el) return;
    const text = `${line}…`;
    if (this.reduced) {
      this.el.textContent = text;
      return;
    }
    let n = 0;
    this.el.textContent = '';
    this.timer = setInterval(() => {
      this.el!.textContent = text.slice(0, ++n);
      if (n >= text.length) this.stop();
    }, this.every);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

let seed = 1138;
/** The small numeric readouts: each `[data-tick=N]` shows N fresh digits (decoration, and so not the real figures). */
function tick(root: Element): void {
  root.querySelectorAll<HTMLElement>('[data-tick]').forEach(el => {
    const digits = Number(el.dataset.tick) || 4;
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    el.textContent = String(seed % 10 ** digits).padStart(digits, '0');
  });
}

/** The size in bytes of each script and style file of the build, as the build wrote it into index.html (none in dev). */
export function bundleSizes(doc: Document = document): Record<string, number> | null {
  try {
    const raw = doc.getElementById('au-bundle')?.textContent;
    return raw ? (JSON.parse(raw) as Record<string, number>) : null;
  } catch {
    return null;
  }
}

/** The first step, whose files trackDownloads counts. */
const FETCH = LOADING_STEPS[0]!.label;

/** In dev there is no list of the files: this many files fetched is taken as about half way. */
const DEV_HALF = 120;

/**
 * Reports the first step, fetching the engine, from the files the browser has finished: by bytes of the build's own
 * list (so a big library counts for more than a small chunk), or in dev, where the module count is unknown, by how
 * many have come. Files report when they finish, so it moves a file at a time. Returns what stops it.
 */
export function trackDownloads(progress: LoadingProgress, sizes: Record<string, number> | null = bundleSizes(), observe: (cb: (entry: { name: string; responseEnd?: number }) => void) => () => void = observeResources): () => void {
  const total = sizes ? Object.values(sizes).reduce((a, b) => a + b, 0) : 0;
  const seen = new Set<string>();
  let bytes = 0;
  return observe(entry => {
    const file = new URL(entry.name, 'http://x/').pathname.replace(/^\//, '');
    if (seen.has(file)) return;
    if (sizes) {
      const size = sizes[file];
      if (size === undefined) return;
      seen.add(file);
      bytes += size;
      progress.part(bytes / total, FETCH);
    } else {
      if (!/\.(m?[jt]sx?|css|json|yaml)($|\?)|node_modules|@vite|@fs/.test(file)) return;
      seen.add(file);
      progress.part(seen.size / (seen.size + DEV_HALF), FETCH);
    }
  });
}

/** Resource Timing's finished files, those before it started too. */
function observeResources(cb: (entry: { name: string; responseEnd?: number }) => void): () => void {
  if (typeof PerformanceObserver === 'undefined') return () => {};
  try {
    const observer = new PerformanceObserver(list => list.getEntries().forEach(cb));
    observer.observe({ type: 'resource', buffered: true });
    return () => observer.disconnect();
  } catch {
    return () => {};
  }
}

/**
 * Gives a step with no way to know its size some real progress: each file the browser finishes while it runs counts
 * (a file of `half` is taken as about half way), and between files the bar creeps slowly towards the end of the step
 * (never reaching it: the step's real end does that). Returns what stops it.
 */
export function trackStep(
  progress: LoadingProgress,
  label: string,
  half = 40,
  observe: (cb: (entry: { name: string; responseEnd?: number }) => void) => () => void = observeResources,
  now: () => number = () => (typeof performance === 'undefined' ? Date.now() : performance.now()),
  tau = 4000,
  every = 250,
): () => void {
  const began = now();
  const seen = new Set<string>();
  // (a step's files only: those the browser finished before it began belong to the steps before)
  const stopObserving = observe(entry => {
    if (entry.responseEnd !== undefined && entry.responseEnd < began) return;
    if (seen.has(entry.name) || !/\.(m?[jt]sx?|css|json|ya?ml)($|\?)|node_modules|@vite|@fs/.test(entry.name)) return;
    seen.add(entry.name);
    progress.part(0.9 * (seen.size / (seen.size + half)), label);
  });
  const timer = setInterval(() => progress.part(0.9 * (1 - Math.exp(-(now() - began) / tau)), label), every);
  return () => {
    stopObserving();
    clearInterval(timer);
  };
}
