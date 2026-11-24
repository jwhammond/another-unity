// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CombatCommand, ConsolePage } from '../../sim/combat/commands';
import { SIM_SEAMS } from '../../sim/combat/seams';
import { miniBattle, miniBattleContext, miniEnterpriseUnits } from '../../testing/combat';
import { miniConsoleArt } from '../../testing/console';
import { newRadarMemory } from '../../view/combat/files';
import type { BattlePort, BattleView } from '../../web/battlePort';
import { areaStyle } from '../ship/areas';
import { CombatConsole } from './console';

/**
 * A made-up port over miniCombat's battle 3 (its weapons set up), recording the orders, pages, beeps and picks the console gives.
 * Its view's `queued` is empty: a test that pauses the battle sets it to `orders`, the orders a paused battle keeps waiting.
 */
function fakePort() {
  const { ctx, b } = miniBattle({ ctx: miniBattleContext({ ...SIM_SEAMS }) });
  const orders: CombatCommand[] = [];
  const pages: ConsolePage[] = [];
  let beeps = 0;
  let wall = 50000;
  let gone = false;
  let stale = 0;
  /** Where on the view the console asked for a ship (BattlePort.pick), and the ship the fake finds there: the chodak. */
  const picks: [number, number][] = [];
  /** As the session's port without a battle: battleCommand and consolePage throw (tacticalScreen.ts). */
  const live = () => {
    if (!gone) return;
    stale++;
    throw new Error('there is no battle');
  };
  const view: BattleView = { b, combat: ctx.combat, enterpriseUnits: miniEnterpriseUnits(), paused: false, redFlash: false, resolved: null, resolving: false, page: 'conn', warp: false, queued: [], overlay: null };
  const port: BattlePort = {
    battle: () => (gone ? null : view), command: cmd => { live(); orders.push(cmd); }, pause: () => {}, autoResolve: async () => {}, finish: async () => {},
    assists: () => ({ difficulty: 'game', speed: 1 }), setAssists: () => {},
    page: p => { live(); pages.push(p); view.page = p; }, consoleArt: () => miniConsoleArt(), flash: () => 0, viewBox: () => {}, hudBoxes: () => {}, logShown: () => {},
    beep: () => { if (!gone) beeps++; }, radar: newRadarMemory, chunk: () => null,
    pick: (fx, fy) => { picks.push([fx, fy]); return 1; },
  };
  return {
    port, view, b, orders, pages, picks, beeps: () => beeps, later: (ms: number) => { wall += ms; }, now: () => wall,
    /** The battle ends: the port has none now (its controls stay up until a parent re-renders). */
    end: () => { gone = true; },
    /** How many orders or pages reached the port with no battle. */
    stale: () => stale,
  };
}
let root: HTMLElement;
afterEach(() => {
  render(null, root);
  root.remove();
  vi.unstubAllGlobals();
});
function show(f: ReturnType<typeof fakePort>, wide?: HTMLElement, o: { keyboardFocus?: (el: Element) => boolean } = {}) {
  root = document.body.appendChild(document.createElement('div'));
  act(() => { render(<CombatConsole port={f.port} now={f.now} wide={wide} pads={() => []} keyboardFocus={o.keyboardFocus ?? (() => false)} />, root); });
}
/** A control by its name, pressed as a keyboard presses it (a click at its middle). */
const control = (name: string) => root.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`)!;
const frame = () => act(async () => { await new Promise(r => setTimeout(r, 40)); });

describe('the console with the art on (Plan 30 R7)', () => {
  it('lays its frame over the repainted plate and the art layer at the repaint\'s scale; with none, the frame alone', () => {
    const f = fakePort();
    const art = { ...miniConsoleArt(), repaint: { plate: '/a/plate.webp', images: new Map(), scale: 4, opaque: [] } };
    f.port.consoleArt = () => art;
    show(f);
    const console = root.querySelector('.au-console-root')!;
    expect([...console.children].slice(0, 3).map(el => el.getAttribute('class'))).toEqual(['au-console-plate', 'au-console-art', 'au-console-canvas']);
    expect([console.getAttribute('data-art'), root.querySelector('.au-console-plate')!.getAttribute('src')]).toEqual(['repaint', '/a/plate.webp']);
    expect(['width', 'height'].map(a => root.querySelector('.au-console-art')!.getAttribute(a))).toEqual(['2560', '1920']);
    render(null, root);
    root.remove();
    const plain = fakePort();
    show(plain);
    expect([root.querySelector('.au-console-plate'), root.querySelector('.au-console-art'), root.querySelector('.au-console-root')!.getAttribute('data-art')]).toEqual([null, null, null]);
  });
});

describe('the console in the game (Plan 27)', () => {
  it('names its page\'s controls over their places, the current tab and the toggles pressed as they are', () => {
    const f = fakePort();
    f.b.console.shieldsRaised = true;
    f.b.console.powerLevel = 2;
    show(f);
    const names = [...root.querySelectorAll('[data-control]')].map(el => el.getAttribute('aria-label'));
    expect(names.slice(0, 6)).toEqual(['Phaser banks', 'Torpedoes', 'Own damage', 'Helm', 'Maneuvers', 'Target sensors']);
    expect(names).toEqual(expect.arrayContaining(['Bridge', 'Engineering', 'Camera view', 'Full view', 'Zoom in', 'Shields', 'Weapons lock', 'Self-destruct', 'Delegate', 'Power level 4']));
    expect(names).not.toContain('Maneuvers up');
    expect([control('Helm').getAttribute('aria-pressed'), control('Shields').getAttribute('aria-pressed'), control('Power level 2').getAttribute('aria-pressed')]).toEqual(['true', 'true', 'true']);
    expect(root.querySelector('[aria-label="Radar"]')).not.toBeNull();
  });

  it('takes a click as mouseClick does: a button acts and beeps, nothing more while it is down, then a tab; Bridge when its 498 ms are up', async () => {
    const f = fakePort();
    show(f);
    await act(async () => { control('Shields').click(); });
    expect([f.orders, f.beeps()]).toEqual([[{ type: 'shields', on: true }], 1]);
    await act(async () => { control('Maneuvers').click(); });
    expect(f.pages).toEqual([]);
    f.later(498);
    await frame();
    await act(async () => { control('Maneuvers').click(); });
    expect(f.pages).toEqual(['tactics']);
    // (TACTICS' rows, arrows and Engage are on it now)
    await frame();
    expect(control('Maneuvers up')).not.toBeNull();
    // (Bridge: nothing at once, the order when the button comes up; the seam makes it the hail at red alert)
    await act(async () => { control('Bridge').click(); });
    await frame();
    expect(f.orders.length).toBe(1);
    f.later(498);
    await frame();
    expect(f.orders.at(-1)).toEqual({ type: 'bridge' });
  });

  it('is nothing under the warp overlay, which lets the pressed button go (tactical.cpp:843-846), and only the HUD while wide', async () => {
    const f = fakePort();
    show(f);
    await act(async () => { control('Bridge').click(); });
    f.view.warp = true;
    await frame();
    expect(root.querySelector('[data-control]')).toBeNull();
    f.view.warp = false;
    f.later(600);
    await frame();
    expect(f.orders).toEqual([]);
    f.b.view.wide = true;
    await frame();
    expect([root.querySelector('[data-control]'), root.querySelector('canvas'), root.querySelector('[aria-label="Wide view"]') !== null]).toEqual([null, null, true]);
  });

  it('is the HUD while wide, in the frame it is given: its fire buttons the console\'s, its Split back to the console (Plan 27 R10)', async () => {
    const f = fakePort();
    f.b.view.wide = true;
    const frameEl = document.body.appendChild(document.createElement('div'));
    show(f, frameEl);
    expect([root.querySelector('[data-control]'), frameEl.querySelector('[aria-label="Wide view"]') !== null]).toEqual([null, true]);
    const hud = (name: string) => [...frameEl.querySelectorAll('button')].find(b => b.textContent === name)!;
    await act(async () => { hud('Fire phasers').click(); });
    await act(async () => { hud('Fire torpedoes').click(); });
    // (the second within the first's 498 ms, as a click on the console's own buttons: not taken)
    expect([f.orders, f.beeps()]).toEqual([[{ type: 'fire', weapon: 'phasers' }], 1]);
    f.later(498);
    await frame();
    await act(async () => { hud('Split view').click(); });
    expect(f.orders.at(-1)).toEqual({ type: 'wide', on: false });
    frameEl.remove();
  });

  it('turns Shields up and down again with two presses while paused, its control showing the order waiting (Plan 29 R3)', async () => {
    const f = fakePort();
    f.view.paused = true;
    f.view.queued = f.orders;
    show(f);
    await act(async () => { control('Shields').click(); });
    await frame();
    const pressed = control('Shields').getAttribute('aria-pressed');
    f.later(498);
    await frame();
    await act(async () => { control('Shields').click(); });
    await frame();
    expect([f.orders, pressed, control('Shields').getAttribute('aria-pressed')]).toEqual([[{ type: 'shields', on: true }, { type: 'shields', on: false }], 'true', 'false']);
  });

  it('opens wide on a short screen, a phone on its side, once as it comes up; not on a tall one (M8 spec Decision 16)', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(max-height: 559px)' }));
    const short = fakePort();
    show(short);
    expect(short.orders).toEqual([{ type: 'wide', on: true }]);
    render(null, root);
    root.remove();
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const tall = fakePort();
    show(tall);
    expect(tall.orders).toEqual([]);
  });

  it('opens its drawer from the HUD while wide, its pages\' controls doing the console\'s (Plan 27 R10)', async () => {
    const f = fakePort();
    f.b.view.wide = true;
    show(f);
    await act(async () => { [...root.querySelectorAll('button')].find(b => b.textContent === 'Console')!.click(); });
    await frame();
    const tab = [...root.querySelectorAll('[role="tab"]')].find(b => b.textContent === 'Phaser banks') as HTMLButtonElement;
    await act(async () => { tab.click(); });
    expect(f.pages).toEqual(['phasers']);
    await frame();
    await act(async () => { [...root.querySelectorAll('button')].find(b => b.textContent === 'No banks')!.click(); });
    expect([f.orders, f.beeps()]).toEqual([[{ type: 'banks', all: false }], 1]);
  });

  it('asks for wide again on a short screen when the view is already wide at mount, as coming back from Engineering (R10)', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(max-height: 559px)' }));
    const f = fakePort();
    f.b.view.wide = true;
    show(f);
    expect(f.orders).toEqual([{ type: 'wide', on: true }]);
  });

  it('locks the drawer\'s taps while a button is down but not its slider drags, as mouseClick and dragSlider (R8)', async () => {
    const f = fakePort();
    f.b.view.wide = true;
    f.view.page = 'phasers';
    show(f);
    await act(async () => { [...root.querySelectorAll('button')].find(b => b.textContent === 'Console')!.click(); });
    await frame();
    await act(async () => { [...root.querySelectorAll('button')].find(b => b.textContent === 'All banks')!.click(); });
    const before = f.orders.length;
    const bank = root.querySelector<HTMLInputElement>('[aria-label="Phaser bank 1"]')!;
    bank.value = '40';
    await act(async () => { bank.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(f.orders.slice(before)).toEqual([{ type: 'bank', bank: 0, setting: 40 }]);
    f.view.page = 'tactics';
    await frame();
    const mid = f.orders.length;
    await act(async () => { [...root.querySelectorAll('button')].find(b => b.textContent === 'Engage')!.click(); });
    f.view.page = 'conn';
    await frame();
    await act(async () => { [...root.querySelectorAll('button')].find(b => b.textContent === 'Power 3')!.click(); });
    expect(f.orders.length).toBe(mid);
  });

  it('drags a bank\'s slider where the pointer is, as dragSlider (tactical.cpp:618-632), the console\'s box 640 x 480 here', async () => {
    const f = fakePort();
    f.view.page = 'phasers';
    show(f);
    root.querySelector<HTMLElement>('.au-console-root')!.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 480, right: 640, bottom: 480, x: 0, y: 0 }) as DOMRect;
    const slider = root.querySelector<HTMLElement>('[aria-label="Phaser bank 1"]')!;
    const pointer = (type: string, x: number) => slider.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: 320, button: 0, bubbles: true }));
    await act(async () => { pointer('pointerdown', 153); pointer('pointermove', 209); pointer('pointermove', 266); pointer('pointerup', 266); pointer('pointermove', 160); });
    expect(f.orders).toEqual([0, 49, 100].map(setting => ({ type: 'bank', bank: 0, setting })));
  });

  it('sets a bank by its slider, in fives by the arrow keys, on the phasers page', async () => {
    const f = fakePort();
    f.view.page = 'phasers';
    f.b.ships[0]!.banks[1]!.setting = 50;
    // (the keyboard's focus on the slider: its arrows are its own, not the battle's roll, Plan 29 R2)
    show(f, undefined, { keyboardFocus: () => true });
    const slider = root.querySelector<HTMLElement>('[aria-label="Phaser bank 2"]')!;
    expect([slider.getAttribute('aria-valuenow'), root.querySelectorAll('[role="slider"]').length]).toEqual(['50', 6]);
    await act(async () => { slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    expect(f.orders).toEqual([{ type: 'bank', bank: 1, setting: 55 }]);
  });

  it('shows Paused in the HUD while the battle is paused, its pace otherwise', async () => {
    const f = fakePort();
    f.b.view.wide = true;
    show(f);
    const pace = () => root.querySelector('[data-hud="pace"]')!.textContent;
    expect(pace()).toBe('1×');
    f.view.paused = true;
    await frame();
    expect(pace()).toBe('Paused');
  });

  it('takes the HUD away under the warp overlay while wide, from the frame it was given, and gives it back after', async () => {
    const f = fakePort();
    f.b.view.wide = true;
    const frameEl = document.body.appendChild(document.createElement('div'));
    show(f, frameEl);
    const hud = () => frameEl.querySelector('[aria-label="Wide view"]') !== null;
    expect(hud()).toBe(true);
    f.view.warp = true;
    await frame();
    expect(hud()).toBe(false);
    f.view.warp = false;
    await frame();
    expect(hud()).toBe(true);
    frameEl.remove();
  });

  it('does nothing from a stale control once the battle is gone, the HUD\'s, the drawer\'s or a slider\'s, and doesn\'t throw (as mouseClick\'s !_inCombat, tactical.cpp:653)', async () => {
    const button = (name: string) => [...root.querySelectorAll('button')].find(b => b.textContent === name)!;
    const errors: unknown[] = [];
    const onError = (e: Event) => { errors.push((e as ErrorEvent).error ?? e); e.preventDefault(); };
    window.addEventListener('error', onError);
    try {
      // (wide, the drawer open on CONN: the HUD's buttons, a tab, a power cell, the toggles)
      const conn = fakePort();
      conn.b.view.wide = true;
      show(conn);
      await act(async () => { button('Console').click(); });
      await frame();
      conn.end();
      await frame();
      await act(async () => {
        button('Fire phasers').click();
        button('Split view').click();
        button('Power 3').click();
        button('Shields').click();
        button('Engineering').click();
        ([...root.querySelectorAll('[role="tab"]')].find(b => b.textContent === 'Phaser banks') as HTMLButtonElement).click();
      });
      await frame();
      render(null, root);
      root.remove();
      // (wide, the drawer open on PHASERS: a bank's slider)
      const banks = fakePort();
      banks.b.view.wide = true;
      banks.view.page = 'phasers';
      show(banks);
      await act(async () => { button('Console').click(); });
      await frame();
      banks.end();
      const input = root.querySelector<HTMLInputElement>('[aria-label="Phaser bank 1"]')!;
      input.value = '40';
      await act(async () => { input.dispatchEvent(new Event('input', { bubbles: true })); });
      render(null, root);
      root.remove();
      // (Split, PHASERS: a drag going as the battle ends, a slider's arrow keys, a click on a button)
      const split = fakePort();
      split.view.page = 'phasers';
      show(split);
      root.querySelector<HTMLElement>('.au-console-root')!.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 480, right: 640, bottom: 480, x: 0, y: 0 }) as DOMRect;
      const slider = root.querySelector<HTMLElement>('[aria-label="Phaser bank 1"]')!;
      const pointer = (type: string, x: number) => slider.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: 320, button: 0, bubbles: true }));
      await act(async () => { pointer('pointerdown', 153); });
      const taken = split.orders.length;
      split.end();
      await act(async () => {
        pointer('pointermove', 209);
        slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        pointer('pointerdown', 266);
        control('Bridge').click();
        control('Helm').click();
      });
      expect([conn.stale(), banks.stale(), split.stale(), conn.orders, banks.orders, split.orders.length, taken, conn.pages, errors]).toEqual([0, 0, 0, [], [], 1, 1, [], []]);
    } finally {
      window.removeEventListener('error', onError);
    }
  });

  it('takes a radar click up to 7 px beyond its blips\' bounds, as mouseClick\'s blip test (|dx|, |dy| < 8, tactical.cpp:696), clear of the view', () => {
    const f = fakePort();
    show(f);
    const radar = root.querySelector<HTMLElement>('[aria-label="Radar"]')!;
    // (the blips are drawn at x 12-307, y 30-288, tactical.cpp:1127: the area [5, 21] to [315, 296), short of the view at x 319)
    const want = areaStyle([5, 21, 310, 275]);
    expect([radar.style.left, radar.style.top, radar.style.width, radar.style.height]).toEqual([want.left, want.top, want.width, want.height]);
  });

  it('fills the drawer\'s scanner picture each frame from one image it keeps, not a new one a frame', async () => {
    const made: [number, number][] = [];
    let put = 0;
    const g = {
      createImageData: (w: number, h: number) => { made.push([w, h]); return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
      putImageData: () => { put++; },
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => g) as never);
    try {
      const f = fakePort();
      f.b.view.wide = true;
      f.view.page = 'sensors';
      show(f);
      await act(async () => { [...root.querySelectorAll('button')].find(b => b.textContent === 'Console')!.click(); });
      await frame();
      await frame();
      await frame();
      expect([put > 2, made]).toEqual([true, [[337, 170]]]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('fills the drawer\'s scanner picture on a short screen\'s Split too, where the view is not wide (Plan 29 R12)', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(max-height: 559px)' }));
    let put = 0;
    const g = {
      createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: () => { put++; },
    };
    // (only the drawer's own canvas has a context: the console's, drawn each frame on Split, would count as well)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((function (this: HTMLCanvasElement) { return this.classList.contains('au-drawer-scanner') ? g : null; }) as never);
    try {
      const f = fakePort();
      f.view.page = 'sensors';
      show(f);
      await act(async () => { [...root.querySelectorAll<HTMLButtonElement>('.au-console-phone button')].find(b => b.textContent === 'Console')!.click(); });
      await frame();
      await frame();
      expect([f.b.view.wide, put > 1]).toEqual([false, true]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('on a short screen, takes a tap anywhere on its 32 px Full control as Full, pressButton\'s way (Plan 27 R10: a phone\'s way back to the wide view)', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(max-height: 559px)' }));
    const f = fakePort();
    show(f);
    const asked = f.orders.length;
    root.querySelector<HTMLElement>('.au-console-root')!.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 480, right: 640, bottom: 480, x: 0, y: 0 }) as DOMRect;
    const full = control('Full view');
    expect(full.classList.contains('au-console-touch')).toBe(true);
    // (a tap below the button's picture, in the control's taller box: a pointer's click, at the original's (500, 40))
    await act(async () => { full.dispatchEvent(new MouseEvent('click', { clientX: 500, clientY: 40, detail: 1, bubbles: true })); });
    expect([f.orders.slice(asked).length > 0, f.beeps()]).toEqual([true, 1]);
  });

  it('steers by a drag on Split\'s view past 24 px, lets go as it ends, and targets the ship a click picks there (Decision 17; Plan 29 R6, R7)', async () => {
    const f = fakePort();
    show(f);
    root.querySelector<HTMLElement>('.au-console-root')!.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 480, right: 640, bottom: 480, x: 0, y: 0 }) as DOMRect;
    const view = root.querySelector<HTMLElement>('.au-console-view')!;
    const pointer = (type: string, x: number, y: number) => view.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: 'mouse', bubbles: true }));
    // (a drag right and up: yaw right, then up as the up arrow, pitch down; let go, nothing held)
    await act(async () => { pointer('pointerdown', 400, 100); pointer('pointermove', 420, 100); pointer('pointermove', 430, 100); pointer('pointermove', 430, 70); pointer('pointerup', 430, 70); });
    expect(f.orders).toEqual([
      { type: 'steer', yaw: 1, pitch: 0, roll: 0, throttle: 0 }, { type: 'steer', yaw: 1, pitch: -1, roll: 0, throttle: 0 }, { type: 'steer', yaw: 0, pitch: 0, roll: 0, throttle: 0 },
    ]);
    // (a click: Split's view is 320 x 220 at (319, 23), so (399, 133) is a quarter across and half down it)
    f.orders.length = 0;
    await act(async () => { pointer('pointerdown', 399, 133); f.later(100); pointer('pointerup', 401, 134); });
    expect([f.picks, f.orders]).toEqual([[[(401 - 319) / 320, (134 - 23) / 220]], [{ type: 'target', ship: 1 }]]);
    // (a press held 250 ms is no click)
    await act(async () => { pointer('pointerdown', 399, 133); f.later(250); pointer('pointerup', 399, 133); });
    expect(f.picks).toHaveLength(1);
  });

  it('zooms by the wheel on the view as the zoom keys do, at most once a second (tactical.cpp:779-788)', async () => {
    const f = fakePort();
    show(f);
    const view = root.querySelector<HTMLElement>('.au-console-view')!;
    const wheel = (deltaY: number) => view.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }));
    await act(async () => { wheel(-100); wheel(-100); });
    f.later(1000);
    await act(async () => { wheel(100); });
    expect(f.orders).toEqual([{ type: 'zoom', direction: 'in' }, { type: 'zoom', direction: 'out' }]);
  });

  it.each(['pointercancel', 'lostpointercapture'])('lets a drag go on %s, as a touch the browser takes for a gesture ends (Plan 29 R7)', async type => {
    const f = fakePort();
    show(f);
    const view = root.querySelector<HTMLElement>('.au-console-view')!;
    const pointer = (t: string, x: number) => view.dispatchEvent(new PointerEvent(t, { clientX: x, clientY: 100, button: 0, pointerId: 3, pointerType: 'touch', bubbles: true }));
    await act(async () => { pointer('pointerdown', 400); pointer('pointermove', 430); });
    expect(f.orders).toEqual([{ type: 'steer', yaw: 1, pitch: 0, roll: 0, throttle: 0 }]);
    await act(async () => { pointer(type, 430); });
    expect(f.orders.at(-1)).toEqual({ type: 'steer', yaw: 0, pitch: 0, roll: 0, throttle: 0 });
  });

  it('keeps the wheel off the page: the event is prevented as it zooms', async () => {
    const f = fakePort();
    show(f);
    const view = root.querySelector<HTMLElement>('.au-console-view')!;
    const e = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
    await act(async () => { view.dispatchEvent(e); });
    expect(e.defaultPrevented).toBe(true);
  });

  it('puts a click on Split\'s view by the console\'s own 640 x 480, at any size it is shown', async () => {
    const f = fakePort();
    show(f);
    root.querySelector<HTMLElement>('.au-console-root')!.getBoundingClientRect = () => ({ left: 10, top: 20, width: 1280, height: 960, right: 1290, bottom: 980, x: 10, y: 20 }) as DOMRect;
    const view = root.querySelector<HTMLElement>('.au-console-view')!;
    const pointer = (type: string, x: number, y: number) => view.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: 'mouse', bubbles: true }));
    // (twice the size: (399, 133) of the original is (10 + 798, 20 + 266))
    await act(async () => { pointer('pointerdown', 808, 286); pointer('pointerup', 808, 286); });
    expect(f.picks).toEqual([[(399 - 319) / 320, (133 - 23) / 220]]);
  });

  it('picks nothing on a click on the view while a console button is down (mouseClick\'s lockout, tactical.cpp:653)', async () => {
    const f = fakePort();
    show(f);
    root.querySelector<HTMLElement>('.au-console-root')!.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 480, right: 640, bottom: 480, x: 0, y: 0 }) as DOMRect;
    const view = root.querySelector<HTMLElement>('.au-console-view')!;
    const pointer = (type: string) => view.dispatchEvent(new PointerEvent(type, { clientX: 399, clientY: 133, button: 0, pointerId: 1, pointerType: 'mouse', bubbles: true }));
    await act(async () => { control('Shields').click(); });
    await act(async () => { pointer('pointerdown'); pointer('pointerup'); });
    expect([f.picks, f.orders]).toEqual([[], [{ type: 'shields', on: true }]]);
    f.later(498);
    await frame();
    await act(async () => { pointer('pointerdown'); pointer('pointerup'); });
    expect(f.picks).toHaveLength(1);
  });

  it('takes a tap on the wide view as a pick on the whole frame, under the HUD\'s own parts (Plan 29 R6)', async () => {
    const f = fakePort();
    f.b.view.wide = true;
    const frameEl = document.body.appendChild(document.createElement('div'));
    frameEl.getBoundingClientRect = () => ({ left: 100, top: 50, width: 800, height: 400, right: 900, bottom: 450, x: 100, y: 50 }) as DOMRect;
    show(f, frameEl);
    const view = frameEl.querySelector<HTMLElement>('.au-combat-hud-view')!;
    expect(view.parentElement!.firstElementChild).toBe(view);
    const pointer = (type: string) => view.dispatchEvent(new PointerEvent(type, { clientX: 300, clientY: 150, pointerId: 2, pointerType: 'touch', bubbles: true }));
    await act(async () => { pointer('pointerdown'); pointer('pointerup'); });
    expect([f.picks, f.orders]).toEqual([[[0.25, 0.25]], [{ type: 'target', ship: 1 }]]);
    frameEl.remove();
  });

  it('opens the assists panel from the HUD\'s button over the wide view, and shows auto-resolve\'s result over Split whether it was open or not (Plan 29 R9, R10)', async () => {
    const f = fakePort();
    f.b.view.wide = true;
    show(f);
    const hud = (name: string) => [...root.querySelectorAll('button')].find(b => b.textContent === name)!;
    expect(root.querySelector('[aria-label="Assists"][role="region"]')).toBeNull();
    await act(async () => { hud('Assists').click(); });
    expect([root.querySelector('.au-combat-hud .au-assists-over [role="region"]') !== null, hud('Assists').getAttribute('aria-expanded')]).toEqual([true, 'true']);
    await act(async () => { hud('Close').click(); });
    expect(root.querySelector('[aria-label="Assists"][role="region"]')).toBeNull();
    f.b.view.wide = false;
    f.view.resolved = { outcome: 'stoodDown', leave: null, steps: 9, log: [] };
    await frame();
    expect(root.querySelector('.au-console-root .au-assists-over [aria-label="Result"]')?.textContent).toContain('Stood down after 9 steps');
  });

  it('goes wide when the screen becomes short, once, and keeps its view when it becomes tall; a short Split has the drawer too (Plan 29 R12)', async () => {
    const listeners: ((e: { matches: boolean }) => void)[] = [];
    const removed: unknown[] = [];
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: (_: string, f: (e: { matches: boolean }) => void) => listeners.push(f), removeEventListener: (_: string, f: unknown) => removed.push(f) }));
    const f = fakePort();
    f.view.queued = f.orders;
    show(f);
    expect([f.orders, root.querySelector('.au-console-phone')]).toEqual([[], null]);
    await act(async () => { listeners.forEach(l => l({ matches: true })); });
    await act(async () => { listeners.forEach(l => l({ matches: true })); });
    expect(f.orders).toEqual([{ type: 'wide', on: true }]);
    // (still Split until the order is applied: the short screen's drawer is on the console, its tabs the console's)
    expect(root.querySelector('.au-console-phone [data-hud="drawer"]')).not.toBeNull();
    await act(async () => { [...root.querySelectorAll<HTMLButtonElement>('.au-console-phone button')].find(b => b.textContent === 'Console')!.click(); });
    await act(async () => { ([...root.querySelectorAll('[role="tab"]')].find(b => b.textContent === 'Torpedoes') as HTMLButtonElement).click(); });
    await act(async () => { listeners.forEach(l => l({ matches: false })); });
    expect([f.pages, f.orders.length, root.querySelector('.au-console-phone')]).toEqual([['torpedoes'], 1, null]);
    // (and lets go of the query as the console goes)
    expect(removed).toEqual([]);
    await act(async () => { render(null, root); });
    expect(removed).toEqual([listeners[0]]);
  });

  it('lets a drag go as the view switches between Split and Wide under it, its surface gone mid-drag (Plan 29 R7)', async () => {
    const f = fakePort();
    show(f);
    const drag = async (surface: HTMLElement) => {
      const pointer = (t: string, x: number) => surface.dispatchEvent(new PointerEvent(t, { clientX: x, clientY: 100, button: 0, pointerId: 4, pointerType: 'mouse', bubbles: true }));
      await act(async () => { pointer('pointerdown', 400); pointer('pointermove', 430); });
    };
    await drag(root.querySelector<HTMLElement>('.au-console-view')!);
    f.b.view.wide = true;
    await frame();
    expect([root.querySelector('.au-console-view'), f.orders.splice(0)]).toEqual([null, [{ type: 'steer', yaw: 1, pitch: 0, roll: 0, throttle: 0 }, { type: 'steer', yaw: 0, pitch: 0, roll: 0, throttle: 0 }]]);
    await drag(root.querySelector<HTMLElement>('.au-combat-hud-view')!);
    f.b.view.wide = false;
    await frame();
    expect([root.querySelector('.au-combat-hud-view'), f.orders]).toEqual([null, [{ type: 'steer', yaw: 1, pitch: 0, roll: 0, throttle: 0 }, { type: 'steer', yaw: 0, pitch: 0, roll: 0, throttle: 0 }]]);
  });

  it('puts the keyboard\'s focus in the assists panel Escape opens, and back where it was, or on the console, as it closes (Plan 29 R2, R9)', async () => {
    const f = fakePort();
    show(f);
    const key = (k: string, target: EventTarget = document.body) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k, bubbles: true, cancelable: true }));
    const panel = () => root.querySelector<HTMLElement>('.au-assists');
    await act(async () => { key('Escape'); });
    const opened = document.activeElement === panel() && panel() !== null;
    // (Escape in the panel closes it: the focus goes back to the body, where it was)
    await act(async () => { key('Escape', panel()!); });
    expect([opened, panel(), document.activeElement]).toEqual([true, null, document.body]);
    // (from a console control: Escape, then Close, and the control has it again)
    control('Shields').focus();
    await act(async () => { key('Escape', control('Shields')); });
    const fromControl = document.activeElement === panel();
    await act(async () => { [...panel()!.querySelectorAll('button')].find(b => b.textContent === 'Close')!.click(); });
    expect([fromControl, document.activeElement === control('Shields')]).toEqual([true, true]);
    // (what had it is gone by then: the console's first control)
    const other = document.body.appendChild(document.createElement('button'));
    other.focus();
    await act(async () => { key('Escape', other); });
    other.remove();
    await act(async () => { key('Escape', panel()!); });
    expect(document.activeElement).toBe(root.querySelector('.au-console-root [data-control]'));
  });

  it('names Full as Split and shows it pressed once its order waits, while paused (Plan 29 R3)', async () => {
    const f = fakePort();
    f.view.paused = true;
    f.view.queued = f.orders;
    show(f);
    await act(async () => { control('Full view').click(); });
    await frame();
    expect([f.orders, control('Split view')?.getAttribute('aria-pressed'), control('Full view')]).toEqual([[{ type: 'wide', on: true }], 'true', null]);
  });

  it('turns a switch from the battle as it is at the click, not as the console last drew it', async () => {
    const f = fakePort();
    show(f);
    const raised = f.b.console.shieldsRaised;
    f.view.b = { ...f.b, console: { ...f.b.console, shieldsRaised: !raised } };
    await act(async () => { control('Shields').click(); });
    expect(f.orders).toEqual([{ type: 'shields', on: raised }]);
  });

  it('shows no second assists panel over the console while a game panel, the saves with their own, is open', async () => {
    const f = fakePort();
    f.view.overlay = 'panel';
    f.view.resolving = true;
    show(f);
    const hidden = root.querySelector('.au-assists-over');
    f.view.overlay = null;
    await frame();
    expect([hidden, root.querySelector('.au-assists-over') !== null]).toEqual([null, true]);
  });

  it('says the sensors are blank in the HUD where the target goes while they read nothing (Plan 29 R13)', async () => {
    const f = fakePort();
    f.b.view.wide = true;
    f.b.target = 1;
    f.b.console.sensorsBlank = true;
    show(f);
    expect(root.querySelector('[data-hud="target"]')!.textContent).toBe('Sensors blank');
  });
});
