// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CombatAssists } from '../../sim/combat/assists';
import type { CombatCommand } from '../../sim/combat/commands';
import { miniBattle, miniCombat, miniEnterpriseUnits } from '../../testing/combat';
import { DEFAULT_KEYS } from '../../view/combat/bindings';
import { NO_AXES, TacticalKeys } from '../../view/combat/consoleInput';
import type { PadState } from '../../view/combat/controls';
import { newRadarMemory } from '../../view/combat/files';
import type { BattlePort, BattleView } from '../../web/battlePort';
import { useBattleControls, type BattleControls } from './controls';

/** A made-up port over miniCombat's battle 3, and the hook on it, recording the orders and what else it asks. */
function setup(o: { keyboardFocus?: boolean; bound?: Record<string, string> } = {}) {
  const { b } = miniBattle();
  const orders: CombatCommand[] = [];
  const calls: string[] = [];
  let assists: CombatAssists = { difficulty: 'game', speed: 1 };
  let wall = 50000;
  let pads: (PadState | null)[] = [];
  const view: BattleView = { b, combat: miniCombat(), enterpriseUnits: miniEnterpriseUnits(), paused: false, redFlash: false, resolved: null, resolving: false, page: 'conn', warp: false, queued: [], overlay: null };
  const port: BattlePort = {
    battle: () => view,
    // (dropped while the warp overlay shows, as battleCommand does)
    command: cmd => { if (!view.warp) orders.push(cmd); },
    pause: on => { calls.push(`pause ${on}`); }, autoResolve: async () => {}, finish: async () => {},
    assists: () => assists, setAssists: a => { assists = a; calls.push(`speed ${a.speed}`); },
    keys: () => ({ ...DEFAULT_KEYS, ...o.bound }),
    page: () => {}, consoleArt: () => null, flash: () => 0, viewBox: () => {}, hudBoxes: () => {}, logShown: () => {}, beep: () => {}, radar: newRadarMemory, chunk: () => null, pick: () => null,
  };
  const keys = new TacticalKeys();
  const c: BattleControls = {
    port, keys, now: () => wall, pads: () => pads, keyboardFocus: () => o.keyboardFocus ?? false,
    assists: () => calls.push('assists'), turnPage: step => calls.push(`page ${step}`), focusConsole: () => calls.push('focus'),
  };
  function Harness() {
    useBattleControls(c);
    return null;
  }
  root = document.body.appendChild(document.createElement('div'));
  act(() => render(<Harness />, root));
  return { view, keys, orders, calls, later: (ms: number) => { wall += ms; }, setPads: (p: (PadState | null)[]) => { pads = p; } };
}
let root: HTMLElement;
afterEach(() => {
  render(null, root);
  root.remove();
  document.body.innerHTML = '';
});
/** A key going down (or up) on `target`, as the browser sends it; whether it was taken (its default prevented). */
function key(k: string, o: { up?: boolean; repeat?: boolean; shiftKey?: boolean; ctrlKey?: boolean; code?: string; target?: EventTarget } = {}): boolean {
  const e = new KeyboardEvent(o.up ? 'keyup' : 'keydown', { key: k, code: o.code ?? `Key${k}`, repeat: o.repeat ?? false, shiftKey: o.shiftKey ?? false, ctrlKey: o.ctrlKey ?? false, bubbles: true, cancelable: true });
  (o.target ?? document.body).dispatchEvent(e);
  return e.defaultPrevented;
}
const frame = () => act(async () => { await new Promise(r => setTimeout(r, 40)); });
const pad = (o: { axes?: number[]; pressed?: number[] } = {}): PadState => ({
  axes: o.axes ?? [0, 0, 0, 0], buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: o.pressed?.includes(i) ?? false, value: o.pressed?.includes(i) ? 1 : 0 })),
});
const ZERO: CombatCommand = { type: 'steer', yaw: 0, pitch: 0, roll: 0, throttle: 0 };

describe('the battle\'s keys (kCombatActions, metaengine.cpp:113-141; M8 spec Decision 18; Plan 29)', () => {
  it('gives each key\'s order, holds a flight key until it comes up, repeats only what the keymap repeats, and takes the keys it uses', () => {
    const { orders, calls } = setup();
    expect([key('f'), key('Tab', { code: 'Tab' }), key('Tab', { code: 'Tab', shiftKey: true }), key('Tab', { code: 'Tab', repeat: true })]).toEqual([true, true, true, true]);
    expect(orders.splice(0)).toEqual([{ type: 'fire', weapon: 'phasers' }, { type: 'target', which: 'next' }, { type: 'target', which: 'prev' }, { type: 'target', which: 'next' }]);
    // (the up arrow pitches down while held, its repeats nothing; as it comes up, let go)
    key('ArrowUp', { code: 'ArrowUp' });
    key('ArrowUp', { code: 'ArrowUp', repeat: true });
    key('ArrowUp', { code: 'ArrowUp', up: true });
    expect(orders.splice(0)).toEqual([{ type: 'steer', yaw: 0, pitch: -1, roll: 0, throttle: 0 }, ZERO]);
    // (the port's: pause, the speed, the assists panel; F6 the console's controls)
    key('p');
    key('.', { code: 'Period' });
    key('Escape', { code: 'Escape' });
    key('F6', { code: 'F6' });
    expect(calls).toEqual(['pause true', 'speed 2', 'assists', 'focus']);
    // (not with Ctrl, nor a key it doesn't know: the page's)
    expect([key('f', { ctrlKey: true }), key('k'), orders.length]).toEqual([false, false, 0]);
  });

  it('takes the keys the settings have bound now, F1 opening nothing for now (Plan 32 Task 10)', () => {
    const { orders, calls } = setup({ bound: { phasers: 'k' } });
    expect([key('k'), key('/'), key('F1', { code: 'F1' })]).toEqual([true, false, true]);
    expect([orders.splice(0), calls]).toEqual([[{ type: 'fire', weapon: 'phasers' }], []]);
  });

  it('leaves a key typed into a field, or in the assists panel, to the page (Plan 29 R2)', () => {
    const { orders } = setup();
    const input = document.body.appendChild(document.createElement('input'));
    const panel = document.body.appendChild(document.createElement('div'));
    panel.dataset.keys = 'page';
    const inside = panel.appendChild(document.createElement('button'));
    expect([key('f', { target: input }), key('t', { target: inside }), orders]).toEqual([false, false, []]);
  });

  it('keeps F1 from the browser wherever the battle shows: a game panel open, the assists panel focused, a dialog up', () => {
    const { view, calls } = setup();
    const panel = document.body.appendChild(document.createElement('div'));
    panel.dataset.keys = 'page';
    const inside = panel.appendChild(document.createElement('button'));
    view.overlay = 'panel';
    const withPanel = key('F1', { code: 'F1' });
    view.overlay = null;
    const inPanel = key('F1', { code: 'F1', target: inside });
    view.overlay = 'dialog';
    const underDialog = key('F1', { code: 'F1' });
    expect([withPanel, inPanel, underDialog, calls]).toEqual([true, true, true, []]);
  });

  it('leaves Tab to the page on any focusable the keyboard has focused, not only buttons and links', () => {
    const kinds: [string, Record<string, string>][] = [
      ['summary', {}], ['div', { tabindex: '0' }], ['span', { tabindex: '-1' }], ['div', { role: 'checkbox' }], ['div', { role: 'radio' }], ['div', { role: 'switch' }], ['div', { role: 'menuitem' }],
    ];
    // (the keyboard's focus is on the element: the test's own stand-in, as :focus-visible is not in happy-dom)
    const { orders } = setup({ keyboardFocus: true });
    const c = document.body.appendChild(document.createElement('div'));
    c.id = 'host';
    for (const [tag, attrs] of kinds) {
      const el = c.appendChild(document.createElement(tag));
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      expect([tag, JSON.stringify(attrs), key('Tab', { code: 'Tab', target: el })]).toEqual([tag, JSON.stringify(attrs), false]);
    }
    expect(orders).toEqual([]);
  });

  it('takes no key while a dialog is up, auto-resolve runs or its result waits, nor Escape with a panel of the game\'s open', () => {
    const { view, orders, calls } = setup();
    view.overlay = 'dialog';
    const dialog = key('f');
    view.overlay = 'panel';
    const panel = [key('Escape', { code: 'Escape' }), key('f')];
    view.overlay = null;
    view.resolving = true;
    const resolving = key('t');
    expect([dialog, panel, resolving, orders, calls]).toEqual([false, [false, true], false, [{ type: 'fire', weapon: 'phasers' }], []]);
  });

  it('lets every key go as the warp overlay comes up, a key held through it acting no more (tactical.cpp:843-846), and as the page loses the keyboard', async () => {
    const { view, orders } = setup();
    key('a', { code: 'KeyA' });
    view.warp = true;
    await frame();
    // (under the overlay a key does nothing, not even its time; the held key coming up after says nothing either)
    const under = key('d', { code: 'KeyD' });
    view.warp = false;
    await frame();
    key('a', { code: 'KeyA', up: true });
    // (the held steer is zeroed in the sim as the overlay goes, the orders being dropped while it shows)
    expect([under, orders.splice(0)]).toEqual([true, [{ type: 'steer', yaw: -1, pitch: 0, roll: 0, throttle: 0 }, ZERO]]);
    // (the window loses the keyboard with a key down: let go, as no key will come up)
    key('d', { code: 'KeyD' });
    window.dispatchEvent(new Event('blur'));
    expect(orders).toEqual([{ type: 'steer', yaw: 1, pitch: 0, roll: 0, throttle: 0 }, ZERO]);
  });

  it('zeroes a held steer in the sim as a dialog comes up, and lets a drag and a pad go as the warp overlay does', async () => {
    const { view, keys, orders, setPads } = setup();
    key('a', { code: 'KeyA' });
    view.overlay = 'dialog';
    await frame();
    expect(orders.splice(0)).toEqual([{ type: 'steer', yaw: -1, pitch: 0, roll: 0, throttle: 0 }, ZERO]);
    view.overlay = null;
    await frame();
    // (a drag the surface was holding when the overlay came up, which unmounts it without a let-go)
    for (const cmd of keys.hold('drag', { ...NO_AXES, yaw: 1 })) orders.push(cmd);
    expect(orders.splice(0)).toEqual([{ type: 'steer', yaw: 1, pitch: 0, roll: 0, throttle: 0 }]);
    view.warp = true;
    await frame();
    view.warp = false;
    await frame();
    expect(orders.splice(0)).toEqual([ZERO]);
    // (and a pad's stick, held again by the pad's next read only if still pushed)
    setPads([null, pad({ axes: [0.8, 0, 0, 0] })]);
    await frame();
    expect(orders.splice(0)).toEqual([{ type: 'steer', yaw: 1, pitch: 0, roll: 0, throttle: 0 }]);
    view.warp = true;
    setPads([]);
    await frame();
    view.warp = false;
    await frame();
    expect(orders.splice(0)).toEqual([ZERO]);
  });
});

describe('what is held across a let-go, and the zeros after it (Plan 29 R4)', () => {
  it('leaves a stick or trigger held through a let-go alone until it comes back near the centre, as a key must be pressed again', async () => {
    const { view, orders, setPads } = setup();
    setPads([pad({ axes: [0.8, 0, 0, 0], pressed: [7] })]);
    await frame();
    expect(orders.splice(0)).toEqual([{ type: 'steer', yaw: 1, pitch: 0, roll: 0, throttle: 1 }]);
    view.overlay = 'dialog';
    await frame();
    view.overlay = null;
    await frame();
    await frame();
    expect(orders.splice(0)).toEqual([ZERO]);
    // (the trigger let go and pulled again acts; the stick, still pushed, doesn't until it has come back)
    setPads([pad({ axes: [0.8, 0, 0, 0] })]);
    await frame();
    setPads([pad({ axes: [0.8, 0, 0, 0], pressed: [7] })]);
    await frame();
    expect(orders.splice(0)).toEqual([{ type: 'steer', yaw: 0, pitch: 0, roll: 0, throttle: 1 }]);
    setPads([pad({ axes: [0.1, 0, 0, 0], pressed: [7] })]);
    await frame();
    setPads([pad({ axes: [0.8, 0, 0, 0], pressed: [7] })]);
    await frame();
    expect(orders.splice(0)).toEqual([{ type: 'steer', yaw: 1, pitch: 0, roll: 0, throttle: 1 }]);
  });

  it('counts a pad button held across a dialog only when it is pressed again', async () => {
    const { view, orders, setPads, later } = setup();
    setPads([pad({ pressed: [0] })]);
    await frame();
    expect(orders.splice(0)).toEqual([{ type: 'fire', weapon: 'phasers' }]);
    view.overlay = 'dialog';
    await frame();
    later(1000);
    view.overlay = null;
    await frame();
    await frame();
    expect(orders).toEqual([]);
    setPads([pad()]);
    await frame();
    later(1000);
    setPads([pad({ pressed: [0] })]);
    await frame();
    expect(orders.splice(0)).toEqual([{ type: 'fire', weapon: 'phasers' }]);
  });

  it('counts a key auto-repeating across a dialog only when it is pressed again', async () => {
    const { view, orders, later } = setup();
    key('f');
    expect(orders.splice(0).length).toBe(1);
    view.overlay = 'dialog';
    await frame();
    view.overlay = null;
    await frame();
    later(1000);
    key('f', { repeat: true });
    expect(orders).toEqual([]);
    key('f', { up: true });
    key('f');
    expect(orders.splice(0)).toEqual([{ type: 'fire', weapon: 'phasers' }]);
  });

  it('sends the waiting zeros before a key pressed between the overlay and the next frame', async () => {
    const { view, orders } = setup();
    key('a', { code: 'KeyA' });
    view.warp = true;
    await frame();
    orders.splice(0);
    view.warp = false;
    key('d', { code: 'KeyD' });
    expect(orders.splice(0)).toEqual([ZERO, { type: 'steer', yaw: 1, pitch: 0, roll: 0, throttle: 0 }]);
    await frame();
    expect(orders).toEqual([]);
  });

  it('zeroes a held steer as the console goes, and takes no key or frame after', async () => {
    const { orders } = setup();
    const cancel = vi.spyOn(globalThis, 'cancelAnimationFrame');
    const removed: string[] = [];
    const real = window.removeEventListener.bind(window);
    const remove = vi.spyOn(window, 'removeEventListener').mockImplementation(((t: string, ...rest: unknown[]) => { removed.push(t); (real as (...a: unknown[]) => void)(t, ...rest); }) as typeof window.removeEventListener);
    key('a', { code: 'KeyA' });
    orders.splice(0);
    act(() => render(null, root));
    remove.mockRestore();
    expect([cancel.mock.calls.length > 0, removed.sort(), orders.splice(0)]).toEqual([true, ['blur', 'keydown', 'keyup'], [ZERO]]);
    cancel.mockRestore();
    key('d', { code: 'KeyD' });
    window.dispatchEvent(new Event('blur'));
    await frame();
    expect(orders).toEqual([]);
  });
});

describe('the battle\'s pad (M8 spec §6.1, the standard mapping; Plan 29 R8)', () => {
  it('pauses by Start under the warp overlay as P does (R11), and takes no other button there, nor Start under a dialog', async () => {
    const { view, orders, calls, setPads } = setup();
    view.warp = true;
    await frame();
    setPads([pad({ pressed: [9, 0] })]);
    await frame();
    await frame();
    // (A, held through the overlay, is no press after it)
    view.warp = false;
    await frame();
    setPads([pad({ pressed: [0] })]);
    view.overlay = 'dialog';
    await frame();
    setPads([pad({ pressed: [0, 9] })]);
    await frame();
    expect([calls, orders]).toEqual([['pause true'], []]);
  });

  it('acts on a button as it is pressed, holds the sticks past 0.3, turns the page by the d-pad and pauses by Start', async () => {
    const { orders, calls, setPads } = setup();
    setPads([null, pad({ pressed: [0], axes: [0.8, 0, 0, 0] })]);
    await frame();
    await frame();
    expect(orders.splice(0)).toEqual([{ type: 'fire', weapon: 'phasers' }, { type: 'steer', yaw: 1, pitch: 0, roll: 0, throttle: 0 }]);
    setPads([null, pad({ pressed: [15, 9] })]);
    await frame();
    expect([orders, calls]).toEqual([[ZERO], ['pause true', 'page 1']]);
  });
});
