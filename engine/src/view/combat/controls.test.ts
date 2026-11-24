// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { NO_AXES } from './consoleInput';
import { BINDABLE_ACTIONS, DEFAULT_KEYS, rebind } from './bindings';
import { dragAxes, isClick, keyAction, keyMapFor, KEY_MAP, keyFor, nextSpeed, padAxes, padPresses, repeats, type PadState } from './controls';

const key = (k: string, o: { shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean } = {}) =>
  keyAction({ key: k, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...o });
/** A standard pad at rest, its axes and buttons set from `o`. */
const pad = (o: { axes?: number[]; pressed?: number[]; values?: Record<number, number> } = {}): PadState => ({
  axes: o.axes ?? [0, 0, 0, 0],
  buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: o.pressed?.includes(i) ?? false, value: o.values?.[i] ?? (o.pressed?.includes(i) ? 1 : 0) })),
});

describe('the keys (kCombatActions, metaengine.cpp:113-141; M8 spec Decision 18)', () => {
  it('gives the original\'s actions by their keys and the keypad\'s, then the port\'s own', () => {
    expect(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'a', 'PageUp', 'D', '+', '=', '-', 'Enter'].map(k => key(k)))
      .toEqual(['pitchDown', 'pitchUp', 'rollLeft', 'rollRight', 'yawLeft', 'yawLeft', 'yawRight', 'yawRight', 'accelerate', 'accelerate', 'decelerate', 'stop']);
    expect(['/', 'f', '*', 't', 'Insert', 'v', 'Delete', 'c', 'End', 'z', 'PageDown', 'x', '1', '8', '9', '0', 'F1'].map(k => key(k)))
      .toEqual(['phasers', 'phasers', 'torpedoes', 'torpedoes', 'toggleView', 'toggleView', 'cycleCamera', 'cycleCamera', 'zoomIn', 'zoomIn', 'zoomOut', 'zoomOut', 'view1', 'view8', 'orbitLeft', 'orbitRight', 'options']);
    expect([key('Tab'), key('Tab', { shiftKey: true })]).toEqual(['nextTarget', 'previousTarget']);
    expect(['w', 's', 'q', 'e', ' ', 'p', '.', 'Escape'].map(k => key(k))).toEqual(['pitchDown', 'pitchUp', 'rollLeft', 'rollRight', 'fireBoth', 'pause', 'cycleSpeed', 'assists']);
    // (nothing with Ctrl, Alt or Meta, nor an unbound key)
    expect([key('f', { ctrlKey: true }), key('t', { metaKey: true }), key('a', { altKey: true }), key('k'), key('F2')]).toEqual([null, null, null, null, null]);
  });

  it('repeats a held key as the keymap\'s allowKbdRepeats does: not the flight keys, the orbit, all stop or the port\'s toggles', () => {
    expect((['phasers', 'fireBoth', 'toggleView', 'cycleCamera', 'nextTarget', 'zoomIn', 'view3'] as const).every(a => repeats(a))).toBe(true);
    expect((['pitchDown', 'yawRight', 'accelerate', 'orbitLeft', 'stop', 'pause', 'cycleSpeed', 'assists'] as const).some(a => repeats(a))).toBe(false);
  });

  it('leaves a key to the page in a field or a part that keeps its keys, and to a control with the keyboard\'s focus only for the keys it uses (Plan 29 R2)', () => {
    document.body.innerHTML = '<input id="i"><select id="s"></select><div data-keys="page"><button id="p">P</button></div><button id="b">B</button><div id="r" role="slider" tabindex="0"></div>';
    const el = (id: string) => document.getElementById(id);
    expect([keyFor(el('i'), 'f', false), keyFor(el('s'), 'ArrowUp', false), keyFor(el('p'), 'f', false), keyFor(null, 'Tab', false)]).toEqual(['page', 'page', 'page', 'battle']);
    // (a button the mouse focused: every key the battle's; the keyboard's: Tab, Enter and Space its own, the rest the battle's)
    expect([keyFor(el('b'), 'Tab', false), keyFor(el('b'), 'Enter', true), keyFor(el('b'), ' ', true), keyFor(el('b'), 'Tab', true), keyFor(el('b'), 'f', true), keyFor(el('b'), 'ArrowUp', true)])
      .toEqual(['battle', 'page', 'page', 'page', 'battle', 'battle']);
    expect([keyFor(el('r'), 'ArrowLeft', true), keyFor(el('r'), 'ArrowLeft', false)]).toEqual(['page', 'battle']);
  });

  it('leaves Tab, Enter and Space to any focusable with the keyboard\'s focus: a summary, a tabindex, a checkbox, radio, switch or menu item', () => {
    document.body.innerHTML = '<details><summary id="s">S</summary></details><span id="t" tabindex="0"></span><div id="n" tabindex="-1"></div><div id="c" role="checkbox"></div><div id="r" role="radio"></div><div id="w" role="switch"></div><div id="m" role="menuitem"></div><div id="p"></div>';
    const el = (id: string) => document.getElementById(id);
    for (const id of ['s', 't', 'n', 'c', 'r', 'w', 'm']) expect([id, keyFor(el(id), 'Tab', true), keyFor(el(id), 'f', true)]).toEqual([id, 'page', 'battle']);
    // (a plain element isn't one)
    expect(keyFor(el('p'), 'Tab', true)).toBe('battle');
  });

  it('cycles the speed 1, 2, 4, 8 and round', () => {
    expect([nextSpeed(1), nextSpeed(2), nextSpeed(4), nextSpeed(8)]).toEqual([2, 4, 8, 1]);
  });
});

describe('the drag on the view (M8 spec Decision 17)', () => {
  it('holds yaw and pitch past 24 px each way, each axis apart, as the yaw keys and the arrows; a press under 6 px and 250 ms a click', () => {
    expect([dragAxes(24, -24), dragAxes(25, 0), dragAxes(-30, 10), dragAxes(0, -25), dragAxes(40, 40)]).toEqual([
      NO_AXES, { ...NO_AXES, yaw: 1 }, { ...NO_AXES, yaw: -1 }, { ...NO_AXES, pitch: -1 }, { ...NO_AXES, yaw: 1, pitch: 1 },
    ]);
    expect([isClick(3, 4, 249), isClick(4, 4.5, 100), isClick(0, 0, 250)]).toEqual([true, false, false]);
  });
});

describe('the pad (M8 spec §6.1, the standard mapping)', () => {
  it('holds the sticks and triggers past 0.3: the left yaw and pitch (up as the up arrow), the right roll and the orbit, the triggers the throttle', () => {
    expect(padAxes(pad())).toEqual(NO_AXES);
    expect(padAxes(pad({ axes: [0.3, -0.31, -0.9, 0.5] }))).toEqual({ yaw: 0, pitch: -1, roll: -1, orbit: 1, throttle: 0 });
    expect([padAxes(pad({ values: { 7: 0.5 } })).throttle, padAxes(pad({ values: { 6: 0.9 } })).throttle, padAxes(pad({ values: { 6: 0.9, 7: 0.9 } })).throttle]).toEqual([1, -1, 0]);
  });

  it('gives a button\'s action as it is pressed, not while it stays down', () => {
    const a = pad({ pressed: [0, 9] });
    expect(padPresses(null, a)).toEqual(['phasers', 'pause']);
    expect(padPresses(a, pad({ pressed: [0, 9, 1, 4, 5, 2, 3, 8, 12, 13, 14, 15] })))
      .toEqual(['torpedoes', 'stop', 'cycleCamera', 'previousTarget', 'nextTarget', 'toggleView', 'zoomIn', 'zoomOut', 'pagePrevious', 'pageNext']);
    // (the triggers are the throttle's, not presses)
    expect(padPresses(null, pad({ pressed: [6, 7] }))).toEqual([]);
  });
});

describe('rebinding (Plan 32 Task 10)', () => {
  it('has the default bindings give today\'s keys, F1 now the options', () => {
    // (the map as it stood before the bindings: the original's keys, the port's aliases and its own, F1 apart)
    expect(KEY_MAP).toEqual({
      ArrowUp: 'pitchDown', ArrowDown: 'pitchUp', ArrowLeft: 'rollLeft', ArrowRight: 'rollRight', Home: 'yawLeft', a: 'yawLeft', PageUp: 'yawRight', d: 'yawRight',
      '+': 'accelerate', '=': 'accelerate', '-': 'decelerate', Enter: 'stop', '/': 'phasers', f: 'phasers', '*': 'torpedoes', t: 'torpedoes',
      Insert: 'toggleView', v: 'toggleView', Delete: 'cycleCamera', c: 'cycleCamera', Tab: 'nextTarget', End: 'zoomIn', z: 'zoomIn', PageDown: 'zoomOut', x: 'zoomOut',
      1: 'view1', 2: 'view2', 3: 'view3', 4: 'view4', 5: 'view5', 6: 'view6', 7: 'view7', 8: 'view8', 9: 'orbitLeft', 0: 'orbitRight',
      F1: 'options', w: 'pitchDown', s: 'pitchUp', q: 'rollLeft', e: 'rollRight', ' ': 'fireBoth', p: 'pause', '.': 'cycleSpeed', Escape: 'assists',
    });
    expect(Object.isFrozen(KEY_MAP)).toBe(true);
  });

  it('F1 is the options, not the assists panel; Escape stays the assists panel', () => {
    expect([key('F1'), key('Escape')]).toEqual(['options', 'assists']);
    expect(repeats('options')).toBe(false);
  });

  it('binding a used key is refused', () => {
    expect(rebind(DEFAULT_KEYS, 'phasers', '*')).toBe('used');
    expect(rebind(DEFAULT_KEYS, 'pause', 'ArrowUp')).toBe('used');
    // (a letter's case does not matter)
    expect(rebind(DEFAULT_KEYS, 'phasers', 'P')).toBe('used');
  });

  it('F1 and Escape can\'t be bound', () => {
    for (const a of BINDABLE_ACTIONS) expect([rebind(DEFAULT_KEYS, a, 'F1'), rebind(DEFAULT_KEYS, a, 'Escape')]).toEqual(['fixed', 'fixed']);
  });

  it('refuses the view and orbit keys as used, and F6, F5 and F12 as fixed', () => {
    expect(['1', '8', '9', '0'].map(k => rebind(DEFAULT_KEYS, 'phasers', k))).toEqual(['used', 'used', 'used', 'used']);
    expect(['F6', 'F5', 'F12'].map(k => rebind(DEFAULT_KEYS, 'phasers', k))).toEqual(['fixed', 'fixed', 'fixed']);
  });

  it('gives back the table with the key changed, or as it was for its own key', () => {
    expect(rebind(DEFAULT_KEYS, 'phasers', 'K')).toEqual({ ...DEFAULT_KEYS, phasers: 'k' });
    expect(rebind(DEFAULT_KEYS, 'phasers', '/')).toEqual(DEFAULT_KEYS);
  });

  it('has a rebound key drive its action, and the old key no longer do', () => {
    const map = keyMapFor(rebind(DEFAULT_KEYS, 'phasers', 'k') as typeof DEFAULT_KEYS);
    const k = (name: string) => keyAction({ key: name, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false }, map);
    expect([k('k'), k('K'), k('/'), k('*')]).toEqual(['phasers', 'phasers', null, 'torpedoes']);
    // (its port alias stays while no binding takes it)
    expect(k('f')).toBe('phasers');
  });

  it('gives an alias key to the action bound to it, and drops the alias', () => {
    const map = keyMapFor(rebind(DEFAULT_KEYS, 'torpedoes', 'f') as typeof DEFAULT_KEYS);
    const k = (name: string) => keyAction({ key: name, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false }, map);
    expect([k('f'), k('/'), k('t')]).toEqual(['torpedoes', 'phasers', 'torpedoes']);
    // (the views, F1 and Escape are no binding's, even from a stored record)
    const over = keyMapFor({ ...DEFAULT_KEYS, phasers: '1', pause: 'F1', stop: 'Escape' });
    expect([over[1], over.F1, over.Escape]).toEqual(['view1', 'options', 'assists']);
  });

  it('keeps Tab and Shift-Tab on the targets only while Tab is the next target\'s', () => {
    const map = keyMapFor(rebind(DEFAULT_KEYS, 'nextTarget', 'n') as typeof DEFAULT_KEYS);
    const tab = (shiftKey: boolean) => keyAction({ key: 'Tab', shiftKey, ctrlKey: false, altKey: false, metaKey: false }, map);
    expect([tab(false), tab(true), keyAction({ key: 'n', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false }, map)]).toEqual([null, null, 'nextTarget']);
  });
});
