// SPDX-License-Identifier: GPL-3.0-or-later
import { BATTLE_SPEEDS, type BattleSpeed } from '../../sim/combat/assists';
import type { Held } from '../../sim/combat/commands';
import { BINDABLE_ACTIONS, DEFAULT_KEYS, type Bindings } from './bindings';
import { NO_AXES, type Axes, type TacticalAction } from './consoleInput';

/**
 * The battle's modern controls (M8 spec §6.1, Decisions 17 and 18; Plan 29): which key, pad button, stick or drag gives which of
 * the original's actions (consoleInput.ts' TacticalKeys plays them) or the port's own. Pure: the console's hook (ui/combat/
 * controls.ts) reads the events and the pads and hands these on.
 */

/** The port's own actions beside the original's (Decision 18, §6.1's pad, §6.2): fire both, pause, the speed, the assists panel, the pages. */
export const PORT_ACTIONS = ['fireBoth', 'pause', 'cycleSpeed', 'assists', 'options', 'pagePrevious', 'pageNext'] as const;
export type PortAction = (typeof PORT_ACTIONS)[number];
export type BattleAction = TacticalAction | PortAction;

/**
 * The keys the player does not rebind, by KeyboardEvent.key (a letter lower case): the views and the orbit (no binding takes them), the original's
 * F1 (kActionOptions, metaengine.cpp:141: the combat options, which Plan 32 builds; tactical.cpp:743-747) and Escape (the assists
 * panel, §6.2), which can never be bound (tactical_hooks_ui.md §8).
 */
const FIXED_MAP: Readonly<Record<string, BattleAction>> = {
  1: 'view1', 2: 'view2', 3: 'view3', 4: 'view4', 5: 'view5', 6: 'view6', 7: 'view7', 8: 'view8',
  9: 'orbitLeft', 0: 'orbitRight',
  F1: 'options', Escape: 'assists',
};

/** The port's own keys beside the original's binding (Decision 18: W and S pitch, Q and E roll...; `=` the throttle): they give way to a binding. */
const ALIASES: Readonly<Record<string, BattleAction>> = {
  a: 'yawLeft', d: 'yawRight', '=': 'accelerate', f: 'phasers', t: 'torpedoes', v: 'toggleView', c: 'cycleCamera', z: 'zoomIn', x: 'zoomOut',
  w: 'pitchDown', s: 'pitchUp', q: 'rollLeft', e: 'rollRight',
};

/**
 * The keys for `keys` (kCombatActions, metaengine.cpp:113-141: the keypad's keys give the same `key` as the main ones): the fixed
 * keys and the port's aliases, the player's bindings laid over them, so a key bound to one action is that action's, and the alias it was is gone. By KeyboardEvent.key, a letter lower case. Shift-Tab is previousTarget (keyAction).
 */
export function keyMapFor(keys: Bindings): Readonly<Record<string, BattleAction>> {
  const map: Record<string, BattleAction> = { ...ALIASES, ...FIXED_MAP };
  // (the views, the orbit, F1 and Escape are never a binding's, whatever a stored record says)
  for (const a of BINDABLE_ACTIONS) if (!(keys[a] in FIXED_MAP)) map[keys[a]] = a;
  return Object.freeze(map);
}

/** The keys as they are at first: the original's, and the port's aliases. */
export const KEY_MAP: Readonly<Record<string, BattleAction>> = keyMapFor(DEFAULT_KEYS);

/**
 * The action a key gives, or null: none with Ctrl, Alt or Meta (the browser's and the system's), Shift-Tab previousTarget
 * ("S+TAB", metaengine.cpp:128), a letter whatever its case.
 */
export function keyAction(e: { key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }, map: Readonly<Record<string, BattleAction>> = KEY_MAP): BattleAction | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  // (Tab is the next target, Shift-Tab the previous, while the next target is bound to it)
  if (e.key === 'Tab' && map.Tab === 'nextTarget') return e.shiftKey ? 'previousTarget' : 'nextTarget';
  return map[e.key.length === 1 ? e.key.toLowerCase() : e.key] ?? null;
}

/**
 * The actions whose key repeats while held (allowKbdRepeats, metaengine.cpp:151-152, for the actions marked `true` at :114-141), each repeat an
 * actionStart (fire, wide and zoom then under kKeyRepeatDelay); the flight keys and orbit don't repeat, and the port's own act
 * once a press (fire both repeats as fire does).
 */
export function repeats(action: BattleAction): boolean {
  return !['pitchDown', 'pitchUp', 'rollLeft', 'rollRight', 'yawLeft', 'yawRight', 'accelerate', 'decelerate', 'orbitLeft', 'orbitRight', 'stop', 'pause', 'cycleSpeed', 'assists', 'options'].includes(action);
}

/** The roles of a focusable widget (a native one is its tag). */
const FOCUS_ROLES = new Set(['slider', 'tab', 'button', 'link', 'checkbox', 'radio', 'switch', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem', 'spinbutton']);

/**
 * Who a key is for (R2): the page when it is typed into a field (an input, a select, a text area, editable text), or in a part
 * of the page that keeps its keys (`data-keys="page"`: the assists panel); the control when a control has the
 * keyboard's focus (`keyboardFocus`, :focus-visible) and the key is one it uses (Tab, Shift-Tab, Enter and Space; a slider's
 * arrows too); else the battle's.
 */
export function keyFor(target: Element | null, key: string, keyboardFocus: boolean): 'page' | 'battle' {
  if (!target) return 'battle';
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea' || (target as HTMLElement).isContentEditable) return 'page';
  if (target.closest('[data-keys="page"]')) return 'page';
  if (!keyboardFocus) return 'battle';
  const role = target.getAttribute('role');
  // (any focusable: Tab must move the focus on from it, not be taken as the next target, or the keyboard is trapped)
  const control = tag === 'button' || tag === 'a' || tag === 'summary' || target.hasAttribute('tabindex') || (role !== null && FOCUS_ROLES.has(role));
  if (control && (key === 'Tab' || key === 'Enter' || key === ' ')) return 'page';
  if (role === 'slider' && key.startsWith('Arrow')) return 'page';
  return 'battle';
}

/** The next speed of fast-forward's (`.`, Decision 18): 1, 2, 4, 8, and round to 1. */
export function nextSpeed(speed: BattleSpeed): BattleSpeed {
  return BATTLE_SPEEDS[(BATTLE_SPEEDS.indexOf(speed) + 1) % BATTLE_SPEEDS.length]!;
}

/** Decision 17: a drag holds the steering past this many CSS px from where it began, each axis apart. */
export const DRAG_DEAD_ZONE = 24;
/** Decision 17: a press that moves less than this (CSS px) and ends within CLICK_TIME is a click, which targets. */
export const CLICK_DISTANCE = 6;
export const CLICK_TIME = 250;

/**
 * What a drag on the view holds (Decision 17; R7), `dx`, `dy` CSS px from where it began, y down: past the dead zone on an axis,
 * the keys that match it: across, the yaw keys (A and D: right yaws right); up and down, the arrows (up pitches down, as the up
 * arrow and a pad's stick pushed up, metaengine.cpp:114-115). Never roll, the throttle or the orbit.
 */
export function dragAxes(dx: number, dy: number): Axes {
  const way = (d: number): Held => (d > DRAG_DEAD_ZONE ? 1 : d < -DRAG_DEAD_ZONE ? -1 : 0);
  return { ...NO_AXES, yaw: way(dx), pitch: way(dy) };
}

/** Whether a press is a click (Decision 17): moved under CLICK_DISTANCE and over within CLICK_TIME ms. */
export function isClick(dx: number, dy: number, ms: number): boolean {
  return Math.hypot(dx, dy) < CLICK_DISTANCE && ms < CLICK_TIME;
}

/** A pad as the Gamepad API gives it (the standard mapping): its axes and its buttons. */
export interface PadState { axes: readonly number[]; buttons: readonly { pressed: boolean; value: number }[] }

/** §6.1: a stick or trigger is held past this. */
export const PAD_DEAD_ZONE = 0.3;

/**
 * The pad's buttons (M8 spec §6.1, the W3C standard mapping's numbers): A phasers, B torpedoes, X all stop, Y cycle the camera,
 * the bumpers the previous and next target, Back wide, Start pause, the d-pad's up and down zoom and its left and right the
 * page. The triggers (6, 7) are the throttle's (padAxes).
 */
export const PAD_BUTTONS: Readonly<Record<number, BattleAction>> = {
  0: 'phasers', 1: 'torpedoes', 2: 'stop', 3: 'cycleCamera', 4: 'previousTarget', 5: 'nextTarget', 8: 'toggleView', 9: 'pause',
  12: 'zoomIn', 13: 'zoomOut', 14: 'pagePrevious', 15: 'pageNext',
};

/**
 * What a pad's sticks and triggers hold (§6.1; R8), each past the dead zone: the left stick yaw (its x) and pitch (its y, pushed
 * up as the up arrow: pitch down), the right stick roll (its x) and the orbit (its y: up orbits left, as 9, down right, as 0), the
 * right trigger the throttle up and the left down.
 */
export function padAxes(pad: PadState): Axes {
  const way = (v: number | undefined): Held => (v === undefined ? 0 : v > PAD_DEAD_ZONE ? 1 : v < -PAD_DEAD_ZONE ? -1 : 0);
  const trigger = (i: number) => (pad.buttons[i]?.value ?? 0) > PAD_DEAD_ZONE;
  const up = trigger(7), down = trigger(6);
  return {
    yaw: way(pad.axes[0]), pitch: way(pad.axes[1]), roll: way(pad.axes[2]), orbit: way(pad.axes[3]),
    throttle: up && !down ? 1 : down && !up ? -1 : 0,
  };
}

/** The pad's buttons pressed since `before` (none before: a pad just found), in their numbers' order, as their actions. */
export function padPresses(before: PadState | null, pad: PadState): BattleAction[] {
  const out: BattleAction[] = [];
  pad.buttons.forEach((b, i) => {
    const action = PAD_BUTTONS[i];
    if (action && b.pressed && !before?.buttons[i]?.pressed) out.push(action);
  });
  return out;
}
