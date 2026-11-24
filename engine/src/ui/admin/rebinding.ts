// SPDX-License-Identifier: GPL-3.0-or-later
import { useLayoutEffect, useState, type MutableRef } from 'preact/hooks';
import { normalKey, rebind, type BindableAction } from '../../view/combat/bindings';
import type { Settings } from '../../web/settings';
import type { SettingsPort } from '../../web/settingsPort';

/**
 * Rebinding a key (Plan 32 Task 10), shared by the console's KEYS tab (settingsPage.tsx) and Tactical's F1 Combat Options (combatOptions.tsx):
 * the words the original's options screen prints, the wait for a key, and how the screen's keyboard capture offers each key to that wait.
 */

/** The keys' names as the original's options screen prints them (final.spr's list, help.cpp), by KeyboardEvent.key; a letter is its capital. */
export const KEY_NAMES: Readonly<Record<string, string>> = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn',
  Insert: 'Ins', Delete: 'Del', Enter: 'Enter', Tab: 'Tab', ' ': 'Space', '+': 'Plus', '-': 'Minus', '/': 'Slash', '*': 'Star', '.': 'Period',
};
export const keyName = (key: string) => KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key);
/**
 * What each action does, in the options screen's printed words (final.spr's list: its Accel, Phaser, View, Camera, Target), and the remake's own
 * three. final.spr prints the Up key's action, pitchDown here (the nose goes down as the stick goes forward), as "Pitch Up" and Down's as "Pitch
 * Down": the screen's words are kept (the controller's ruling, Plan 32 Task 11 review).
 */
export const ACTION_NAMES: Readonly<Record<BindableAction, string>> = {
  pitchDown: 'Pitch Up', pitchUp: 'Pitch Down', rollLeft: 'Roll Left', rollRight: 'Roll Right', yawLeft: 'Yaw Left', yawRight: 'Yaw Right',
  accelerate: 'Accel', decelerate: 'Decel', stop: 'Stop', phasers: 'Phaser', torpedoes: 'Torpedo', toggleView: 'View', cycleCamera: 'Camera',
  nextTarget: 'Target', zoomIn: 'Zoom In', zoomOut: 'Zoom Out', fireBoth: 'Fire Both', pause: 'Pause', cycleSpeed: 'Speed',
};
/** A key row's name: what it does, then its key, or that it waits for one. */
export const keyRowName = (action: BindableAction, key: string, waiting: boolean) => `${ACTION_NAMES[action].toUpperCase()} ${waiting ? 'PRESS A KEY' : keyName(key).toUpperCase()}`;

/** What a view or orbit key does, for the refusal: those keys keep their jobs. */
const viewKeyJob = (key: string): string | null =>
  key === '9' ? 'That key orbits left' : key === '0' ? 'That key orbits right' : /^[1-8]$/.test(key) ? `That key shows view ${key}` : null;
/** Not keys of their own: a bare modifier, a dead key. */
const NOT_KEYS = ['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Dead', 'Unidentified'];

/** A screen's keyboard capture, as it offers a key to a wait: `grab` is the wait's (set while one is pending), `taken` the keys it took. */
export interface KeyGrab {
  grab: MutableRef<((e: KeyboardEvent) => boolean) | null>;
  taken: MutableRef<Set<string>>;
}

/** Offers a keydown to the wait, first, before the screen's own keys: true if it took it (and then nothing else has it). */
export function offerKey({ grab, taken }: KeyGrab, e: KeyboardEvent): boolean {
  if (!grab.current?.(e)) return false;
  taken.current.add(e.key);
  e.preventDefault();
  return true;
}

/** A keyup: while a key is waited for, and for a key a binding took, it presses nothing (a Space let go on a focused row must not press it again). */
export function guardKeyUp({ grab, taken }: KeyGrab, e: KeyboardEvent): void {
  if (grab.current || taken.current.delete(e.key)) e.preventDefault();
}

/**
 * The wait for a key to bind: `wait(action)` starts it (and says so on the screen's message line), `wait(null)` gives it up. While it waits, the
 * next keydown the screen offers (offerKey) is taken: Esc gives the wait up (the screen stays), a bare modifier or a chord is not a key, and any
 * other goes through rebind, which refuses a key another action has, a view key, and F1 and Esc; a key taken is kept with `set`.
 */
export function useRebinding({ settings, set, say, grab, beep }: {
  settings: SettingsPort;
  set(change: Partial<Settings>): void;
  /** The screen's message line (null: its own words again). */
  say(text: string | null): void;
  grab: KeyGrab['grab'];
  beep(): void;
}): { pending: BindableAction | null; wait(action: BindableAction | null): void } {
  const [pending, setPending] = useState<BindableAction | null>(null);
  const wait = (action: BindableAction | null) => {
    setPending(action);
    say(action === null ? null : `Press a key for ${ACTION_NAMES[action]}`);
  };
  // (a layout effect: the grab is in place as the row shows its wait, so a key pressed at once is taken)
  useLayoutEffect(() => {
    if (pending === null) return;
    grab.current = e => {
      if (e.key === 'Escape') {
        wait(null);
        return true;
      }
      if (NOT_KEYS.includes(e.key) || e.ctrlKey || e.altKey || e.metaKey) return true;
      const result = rebind(settings.get().keys, pending, normalKey(e.key));
      if (result === 'used') say(viewKeyJob(e.key) ?? 'That key is already in use');
      else if (result === 'fixed') say('That key cannot be used');
      else {
        beep();
        set({ keys: result });
        say(null);
      }
      setPending(null);
      return true;
    };
    return () => { grab.current = null; };
  });
  return { pending, wait };
}
