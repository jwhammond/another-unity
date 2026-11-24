// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The battle's rebindable actions (Plan 32): the original's sixteen, in the order of its keys' table (tactical_flight.md §4.1,
 * kCombatActions, metaengine.cpp:113-141), then the remake's own three (Decision 18). Data only; the rebinding's behaviour
 * (Plan 32 Task 10) is built on it. The names are TACTICAL_ACTIONS' and PORT_ACTIONS' (consoleInput.ts, controls.ts).
 */
export const BINDABLE_ACTIONS = [
  'pitchDown', 'pitchUp', 'rollLeft', 'rollRight', 'yawLeft', 'yawRight', 'accelerate', 'decelerate', 'stop', 'phasers', 'torpedoes',
  'toggleView', 'cycleCamera', 'nextTarget', 'zoomIn', 'zoomOut',
  'fireBoth', 'pause', 'cycleSpeed',
] as const;
export type BindableAction = (typeof BINDABLE_ACTIONS)[number];

/**
 * The key each action has at first, by KeyboardEvent.key as KEY_MAP spells it: the original's own for its sixteen, Space, P and
 * `.` for the remake's three. The port's alias keys (W, S, A, D...) are not here: they stay in KEY_MAP beside the binding.
 */
export const DEFAULT_KEYS: Readonly<Record<BindableAction, string>> = Object.freeze({
  pitchDown: 'ArrowUp', pitchUp: 'ArrowDown', rollLeft: 'ArrowLeft', rollRight: 'ArrowRight', yawLeft: 'Home', yawRight: 'PageUp',
  accelerate: '+', decelerate: '-', stop: 'Enter', phasers: '/', torpedoes: '*',
  toggleView: 'Insert', cycleCamera: 'Delete', nextTarget: 'Tab', zoomIn: 'End', zoomOut: 'PageDown',
  fireBoth: ' ', pause: 'p', cycleSpeed: '.',
});

/** A binding table: each bindable action's key (web/settings.ts' KeyBindings, which is this type). */
export type Bindings = Readonly<Record<BindableAction, string>>;

/**
 * The keys no action can be bound to: the original's F1 and Esc (tactical_hooks_ui.md §8), F6 (the console's controls) and the browser's
 * own F5 and F12.
 */
export const FIXED_KEYS: readonly string[] = ['F1', 'Escape', 'F6', 'F5', 'F12'];

/** The keys that keep their jobs: 1-8 the views, 9 and 0 the orbit (an action cannot take them: 'used'). */
export const VIEW_KEYS: readonly string[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

/** A key as KEY_MAP spells it: a letter lower case, whatever Shift did. */
export const normalKey = (key: string): string => (key.length === 1 ? key.toLowerCase() : key);

/** Whether a stored or pressed key may be an action's at all (not fixed, not a view or orbit key, a sane length). */
export const isBindable = (key: string): boolean => key !== '' && key.length <= 16 && !FIXED_KEYS.includes(key) && !VIEW_KEYS.includes(key);

/**
 * `key` for `action`: the new table, or why not. 'fixed' for F1, Escape, F6, F5 and F12; 'used' for a key another bindable action has
 * (the original allows no duplicates) and for the view and orbit keys. A key that is only a port alias (W, S, ...) is not used: the
 * binding takes it over (keyMapFor). Binding an action to the key it has already changes nothing.
 */
export function rebind(keys: Bindings, action: BindableAction, key: string): Bindings | 'used' | 'fixed' {
  const k = normalKey(key);
  if (FIXED_KEYS.includes(k)) return 'fixed';
  if (VIEW_KEYS.includes(k)) return 'used';
  if (BINDABLE_ACTIONS.some(a => a !== action && keys[a] === k)) return 'used';
  return { ...keys, [action]: k };
}

/**
 * A stored binding table made sound: each key normalised; one that is fixed, a view or orbit key, too long or empty goes back to the
 * action's default, and so does the later of two actions that share one (earlier actions in BINDABLE_ACTIONS order win; a default
 * that clashes with an earlier action's key sends that action back to its default too, so the table has no duplicate).
 */
export function soundKeys(stored: Readonly<Record<string, unknown>>): Bindings {
  const keys = { ...DEFAULT_KEYS } as Record<BindableAction, string>;
  for (const a of BINDABLE_ACTIONS) {
    const raw = stored[a];
    const k = typeof raw === 'string' ? normalKey(raw) : '';
    if (isBindable(k)) keys[a] = k;
  }
  for (let again = true; again;) {
    again = false;
    for (const [i, a] of BINDABLE_ACTIONS.entries()) {
      const earlier = BINDABLE_ACTIONS.slice(0, i).find(b => keys[b] === keys[a]);
      if (earlier === undefined) continue;
      const target = keys[a] !== DEFAULT_KEYS[a] ? a : earlier;
      keys[target] = DEFAULT_KEYS[target];
      again = true;
    }
  }
  return keys;
}
