// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { autostartFor, bindLoading, bundleSizes, FLAVOUR, FLAVOUR_EVERY, easeWithin, LOADING_STEPS, LoadingProgress, offerGameFiles, trackDownloads, trackStep, Typewriter } from './loading';

const steps = [{ label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' }];

describe('LoadingProgress', () => {
  it('gives each step an equal share, whatever it costs, and is full when done', () => {
    const p = new LoadingProgress(steps, undefined, () => 0);
    expect(p.fraction).toBe(0);
    expect(p.label).toBe('Loading');
    p.begin('a');
    expect(p.fraction).toBe(0);
    expect(p.label).toBe('a…');
    p.begin('b');
    expect(p.fraction).toBeCloseTo(0.25);
    p.begin('c');
    expect(p.fraction).toBeCloseTo(0.5);
    p.begin('d');
    expect(p.fraction).toBeCloseTo(0.75);
    p.done();
    expect(p.fraction).toBe(1);
    expect(p.label).toBe('Ready');
  });

  it('keeps step k of 7 inside the k-th seventh, whatever is reported', () => {
    for (let k = 1; k <= LOADING_STEPS.length; k++) {
      const p = new LoadingProgress(LOADING_STEPS, undefined, () => 0);
      p.begin(LOADING_STEPS[k - 1]!.label);
      for (const within of [0, 0.3, 1, 5]) {
        p.part(within);
        expect(p.fraction).toBeGreaterThanOrEqual((k - 1) / 7 - 1e-9);
        expect(p.fraction).toBeLessThanOrEqual(k / 7 + 1e-9);
      }
    }
  });

  it('moves inside a step by what it reports, and never goes backwards', () => {
    const p = new LoadingProgress(steps, undefined, () => 0);
    p.begin('a');
    p.part(0.5);
    expect(p.fraction).toBeCloseTo(0.125);
    p.part(0.25);
    expect(p.fraction).toBeCloseTo(0.125);
    p.part(7);
    expect(p.fraction).toBeCloseTo(0.25);
    p.begin('b');
    p.begin('a');
    p.begin('b');
    expect(p.fraction).toBeCloseTo(0.25);
    p.part(0.5);
    expect(p.fraction).toBeCloseTo(0.375);
  });

  it('drops a report meant for another step', () => {
    const p = new LoadingProgress(steps, undefined, () => 0);
    p.begin('b');
    p.part(0.9, 'a');
    expect(p.fraction).toBeCloseTo(0.25);
    p.part(0.4, 'b');
    expect(p.fraction).toBeCloseTo(0.25 + 0.1);
  });

  it('ignores steps after the end or a failure', () => {
    const p = new LoadingProgress(steps, undefined, () => 0);
    p.begin('b');
    p.fail(new Error('no data'));
    expect(p.failed).toBe(true);
    expect(p.label).toBe('Could not start: no data');
    const at = p.fraction;
    p.begin('c');
    p.part(1);
    expect(p.fraction).toBe(at);
  });

  it('tells its listener each change', () => {
    const seen: number[] = [];
    const p = new LoadingProgress([{ label: 'a' }, { label: 'b' }], q => seen.push(q.fraction), () => 0);
    p.begin('a');
    p.part(0.5);
    p.begin('b');
    p.done();
    expect(seen).toEqual([0, 0.25, 0.5, 1]);
  });
});

describe('the percentage', () => {
  const make = () => {
    let clock = 0;
    const p = new LoadingProgress(LOADING_STEPS, () => {}, () => clock, 1000);
    return { p, at: (ms: number) => { clock = ms; } };
  };

  it('is a whole number that never goes back, and 100 only when done', () => {
    const { p, at } = make();
    const seen: number[] = [];
    let t = 0;
    for (const step of LOADING_STEPS) {
      p.begin(step.label);
      for (const within of [0, 0.2, 0.1, 0.6, 1, 1]) {
        t += 700;
        at(t);
        p.part(within);
        seen.push(p.percent);
      }
    }
    for (let i = 0; i < 20; i++) { t += 5000; at(t); seen.push(p.percent); }
    expect(seen.every(n => Number.isInteger(n))).toBe(true);
    expect(seen.every((n, i) => i === 0 || n >= seen[i - 1]!)).toBe(true);
    expect(Math.max(...seen)).toBe(99);
    expect(p.isDone).toBe(false);
    p.done();
    expect(p.percent).toBe(100);
  });

  it('keeps step k inside its band, whatever is reported or however long it takes', () => {
    for (let k = 1; k <= LOADING_STEPS.length; k++) {
      const { p, at } = make();
      for (let i = 0; i < k; i++) p.begin(LOADING_STEPS[i]!.label);
      for (const [ms, within] of [[0, 0], [500, 0.3], [90_000, 0.5], [90_000, 1], [200_000, 9]] as const) {
        at(ms);
        p.part(within);
        expect(p.fraction).toBeGreaterThanOrEqual((k - 1) / 7 - 1e-9);
        expect(p.fraction).toBeLessThanOrEqual(k / 7 + 1e-9);
        expect(p.percent).toBeLessThanOrEqual(99);
      }
    }
  });

  it('creeps in a step that reports nothing, but never to its end', () => {
    const { p, at } = make();
    p.begin(LOADING_STEPS[3]!.label);
    const base = p.fraction;
    at(1000);
    const early = p.fraction;
    at(60_000);
    const late = p.fraction;
    expect(early).toBeGreaterThan(base);
    expect(late).toBeGreaterThan(early);
    expect(late).toBeLessThan(4 / 7);
    expect(easeWithin(1e9)).toBeLessThan(1);
    expect(easeWithin(-5)).toBe(0);
  });

  it('is not held back by the creep when the step reports more', () => {
    const { p, at } = make();
    p.begin(LOADING_STEPS[6]!.label);
    at(100);
    p.part(0.95);
    expect(p.fraction).toBeCloseTo((6 + 0.95) / 7);
  });
});

describe('trackStep', () => {
  it('counts the files that finish while the step runs, and creeps between them without reaching the end', () => {
    vi.useFakeTimers();
    let clock = 0;
    let deliver: (e: { name: string; responseEnd?: number }) => void = () => {};
    const p = new LoadingProgress([{ label: 'a' }, { label: 'b' }], undefined, () => 0);
    p.begin('a');
    const stop = trackStep(p, 'a', 4, cb => { deliver = cb; return () => {}; }, () => clock, 1000, 100);
    deliver({ name: 'http://h/src/old.ts', responseEnd: -5 });
    expect(p.fraction).toBe(0);
    deliver({ name: 'http://h/src/x.yaml', responseEnd: 10 });
    expect(p.fraction).toBeCloseTo(0.5 * 0.9 * (1 / 5));
    clock = 100000;
    vi.advanceTimersByTime(100);
    expect(p.fraction).toBeGreaterThan(0.4);
    expect(p.fraction).toBeLessThan(0.5);
    stop();
    vi.useRealTimers();
  });
});

describe('trackDownloads', () => {
  const feed = (names: string[], sizes: Record<string, number> | null) => {
    const p = new LoadingProgress([{ label: 'Fetching the engine' }], undefined, () => 0);
    p.begin('Fetching the engine');
    trackDownloads(p, sizes, cb => { names.forEach(name => cb({ name })); return () => {}; });
    return p.fraction;
  };

  it('counts bytes of the build\'s own files, each once, and not other requests', () => {
    const sizes = { 'assets/a.js': 100, 'assets/b.js': 300 };
    expect(feed(['http://h/assets/a.js', 'http://h/assets/a.js', 'http://h/other.png'], sizes)).toBeCloseTo(0.25);
    expect(feed(['http://h/assets/a.js', 'http://h/assets/b.js'], sizes)).toBeGreaterThan(0.99);
  });

  it('counts modules in dev, where there is no list', () => {
    const f = feed(['http://h/src/a.ts', 'http://h/node_modules/.vite/deps/three.js', 'http://h/logo.png'], null);
    expect(f).toBeGreaterThan(0);
    expect(f).toBeLessThan(0.1);
  });

  it('reads the build\'s list from index.html', () => {
    document.head.innerHTML = '<script id="au-bundle" type="application/json">{"assets/a.js": 5}</script>';
    expect(bundleSizes()).toEqual({ 'assets/a.js': 5 });
    document.head.innerHTML = '';
    expect(bundleSizes()).toBeNull();
  });
});

describe('bindLoading', () => {
  const page = () => {
    document.body.innerHTML = '<div id="loading"><div class="au-loading-bar" role="progressbar"><div class="au-loading-fill"></div></div><p class="au-loading-status"></p></div>';
  };

  it('draws the bar and the status, shows a failure, and is gone when done', () => {
    page();
    const p = bindLoading();
    p.begin('Opening saves');
    p.part(0.5);
    const percent = p.fraction * 100;
    expect(percent).toBeGreaterThan(0);
    expect(document.querySelector<HTMLElement>('.au-loading-fill')!.style.width).toBe(`${Math.round(percent * 10) / 10}%`);
    expect(document.querySelector('.au-loading-bar')!.getAttribute('aria-valuenow')).toBe(String(p.percent));
    expect(document.querySelector('.au-loading-status')!.textContent).toBe(`${p.percent}% Opening saves…`);
    // (step 4 of 7: the bar is in the fourth seventh)
    expect(percent).toBeGreaterThanOrEqual(300 / 7 - 0.1);
    expect(percent).toBeLessThanOrEqual(400 / 7 + 0.1);
    p.fail('broken');
    expect(document.querySelector('#loading')!.classList.contains('au-loading-failed')).toBe(true);
    expect(document.querySelector('.au-loading-status')!.textContent).toContain('broken');
  });

  it('fades out on done', () => {
    page();
    const p = bindLoading();
    p.autostart = true;
    p.done();
    expect(document.querySelector('#loading')!.classList.contains('au-loading-done')).toBe(true);
  });

  it('waits for Start when loaded, runs the press\'s own hook, and only then fades', async () => {
    page();
    document.querySelector('#loading')!.insertAdjacentHTML('beforeend', '<button class="lc-start"></button>');
    const p = bindLoading();
    p.autostart = false;
    const calls: string[] = [];
    p.done();
    const started = p.waitForStart(() => calls.push('gesture')).then(() => calls.push('shown'));
    const root = document.querySelector('#loading')!;
    expect(root.classList.contains('au-loading-ready')).toBe(true);
    expect(root.classList.contains('au-loading-done')).toBe(false);
    document.querySelector<HTMLElement>('.lc-start')!.click();
    await started;
    expect(calls).toEqual(['gesture', 'shown']);
    expect(root.classList.contains('au-loading-done')).toBe(true);
  });

  it('offers Continue and a smaller New game when an autosave waits; each answers waitForStart as it was chosen', async () => {
    for (const [selector, answer] of [['.lc-start', 'continue'], ['.lc-new', 'new']] as const) {
      page();
      document.querySelector('#loading')!.insertAdjacentHTML('beforeend', '<button class="lc-start">Start</button><button class="lc-new">New game</button>');
      const p = bindLoading();
      p.autostart = false;
      p.resumable = true;
      p.done();
      const root = document.querySelector('#loading')!;
      expect(document.querySelector('.lc-start')!.textContent).toBe('Continue');
      expect(root.classList.contains('au-loading-resume')).toBe(true);
      const started = p.waitForStart();
      document.querySelector<HTMLElement>(selector)!.click();
      expect(await started).toBe(answer);
    }
  });

  it('offers Load game with the save slots, and a slot chosen answers waitForStart', async () => {
    page();
    document.querySelector('#loading')!.insertAdjacentHTML('beforeend', '<button class="lc-start">Start</button><button class="lc-load">Load game</button><div class="lc-slots"></div>');
    const p = bindLoading();
    p.autostart = false;
    p.saved = [{ slot: 2, label: 'lab, today' }, { slot: 4, label: 'ship' }];
    p.done();
    const root = document.querySelector('#loading')!;
    expect(root.classList.contains('au-loading-saves')).toBe(true);
    expect(root.classList.contains('au-loading-slots')).toBe(false);
    document.querySelector<HTMLElement>('.lc-load')!.click();
    expect(root.classList.contains('au-loading-slots')).toBe(true);
    const slots = document.querySelectorAll<HTMLElement>('.lc-slot');
    expect(slots).toHaveLength(2);
    const started = p.waitForStart();
    slots[1]!.click();
    expect(await started).toEqual({ slot: 4 });
  });

  it('offers no Load game with no saves', () => {
    page();
    document.querySelector('#loading')!.insertAdjacentHTML('beforeend', '<button class="lc-load">Load game</button><div class="lc-slots"></div>');
    const p = bindLoading();
    p.autostart = false;
    p.done();
    expect(document.querySelector('#loading')!.classList.contains('au-loading-saves')).toBe(false);
  });

  it('offers plain Start with no autosave, and Enter continues', async () => {
    page();
    document.querySelector('#loading')!.insertAdjacentHTML('beforeend', '<button class="lc-start">Start</button><button class="lc-new">New game</button>');
    const p = bindLoading();
    p.autostart = false;
    p.done();
    expect(document.querySelector('.lc-start')!.textContent).toBe('Start');
    expect(document.querySelector('#loading')!.classList.contains('au-loading-resume')).toBe(false);
    const started = p.waitForStart();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(await started).toBe('continue');
  });

  it('starts on Enter or Space, wherever the focus is', async () => {
    page();
    const p = bindLoading();
    p.autostart = false;
    p.done();
    const started = p.waitForStart();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(p.isWaiting).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    await started;
    expect(p.isWaiting).toBe(false);
  });

  it('shows an error at once, with no Start', () => {
    page();
    const p = bindLoading();
    p.autostart = false;
    p.done(false);
    expect(p.isWaiting).toBe(false);
    expect(document.querySelector('#loading')!.classList.contains('au-loading-done')).toBe(true);
  });

  it('only counts without the element', () => {
    document.body.innerHTML = '';
    expect(() => bindLoading().begin('Loading rooms')).not.toThrow();
  });

  it('offers Game files… only when asked, and its press is not a Start', () => {
    page();
    document.querySelector('#loading')!.insertAdjacentHTML('beforeend', '<button class="lc-start">Start</button><button class="lc-files">Game files…</button>');
    const p = bindLoading();
    p.autostart = false;
    expect(document.querySelector('#loading')!.classList.contains('au-loading-files')).toBe(false);
    const chosen = vi.fn();
    offerGameFiles(chosen);
    expect(document.querySelector('#loading')!.classList.contains('au-loading-files')).toBe(true);
    p.done();
    const files = document.querySelector<HTMLButtonElement>('.lc-files')!;
    files.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(p.isWaiting).toBe(true);
    files.click();
    expect(chosen).toHaveBeenCalledTimes(1);
    expect(p.isWaiting).toBe(true);
  });

  it('offerGameFiles without the screen does nothing', () => {
    document.body.innerHTML = '';
    expect(() => offerGameFiles(() => {})).not.toThrow();
  });
});

describe('Start and the messages', () => {
  it('skips Start for a dev start, ?autostart or an automated browser only', () => {
    expect(autostartFor('', false)).toBe(false);
    expect(autostartFor('?game=demo', false)).toBe(false);
    expect(autostartFor('?dev', false)).toBe(true);
    expect(autostartFor('?autostart', false)).toBe(true);
    expect(autostartFor('', true)).toBe(true);
    // (?autosave asks for the player's start, with Continue, even in a dev or test browser)
    expect(autostartFor('?dev&autosave', true)).toBe(false);
  });

  it('holds each line for a few seconds at least, and types it slower than it is held', () => {
    expect(FLAVOUR_EVERY).toBeGreaterThanOrEqual(4000);
  });

  it('has enough generic lines, none repeated', () => {
    expect(FLAVOUR.length).toBeGreaterThanOrEqual(20);
    expect(new Set(FLAVOUR).size).toBe(FLAVOUR.length);
    expect(FLAVOUR).toContain('Opening hailing frequencies');
    expect(FLAVOUR).toContain('Calibrating inertial dampers');
  });

  it('types a line out, or shows it whole with reduced motion', async () => {
    const el = document.createElement('p');
    new Typewriter(el, true).show('Hello');
    expect(el.textContent).toBe('Hello…');
    const slow = document.createElement('p');
    new Typewriter(slow, false, 5).show('Hi');
    expect(slow.textContent).toBe('');
    await new Promise(r => setTimeout(r, 60));
    expect(slow.textContent).toBe('Hi…');
  });
});

describe('LoadingProgress note', () => {
  it('shows a note in place of the step, and the step again when it is cleared', () => {
    const p = new LoadingProgress(LOADING_STEPS, () => undefined);
    p.begin(LOADING_STEPS[0]!.label);
    p.setNote('Updating…');
    expect(p.label).toBe('Updating…');
    p.setNote(null);
    expect(p.label).toBe(`${LOADING_STEPS[0]!.label}…`);
  });
});
