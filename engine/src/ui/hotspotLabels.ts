// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from 'preact/hooks';
import { readSettings, writeSettings } from '../web/settings';
import { pageStorage } from '../web/settingsPort';

let on = false;
let loaded = false;
/** Where a change goes: the session's settings once it binds them, else straight into the stored record (Plan 32). */
let keep: ((value: boolean) => void) | null = null;
const listeners = new Set<() => void>();

/** Whether the labelled outlines over the clickable areas show over the art. Off unless the player turned it on (the settings record's `hotspots`). */
export function hotspotLabels(): boolean {
  if (!loaded) {
    loaded = true;
    on = readSettings(pageStorage()).hotspots;
  }
  return on;
}

export function setHotspotLabels(value: boolean): void {
  hotspotLabels();
  if (value === on) return;
  on = value;
  if (keep) keep(value);
  else {
    // (no session: the whole record, as it is stored, with this one change)
    const storage = pageStorage();
    writeSettings(storage, { ...readSettings(storage), hotspots: value });
  }
  for (const l of listeners) l();
}

/** The session's settings own the value (Plan 32): it starts as theirs, and each change goes to `onChange`. */
export function bindHotspotLabels(value: boolean, onChange: (value: boolean) => void): void {
  keep = onChange;
  showHotspotLabels(value);
}

/** The value the settings now have, shown without handing it back to them (their own change, applied). */
export function showHotspotLabels(value: boolean): void {
  loaded = true;
  if (value === on) return;
  on = value;
  for (const l of listeners) l();
}

/** The setting, re-rendering the component when it changes. */
export function useHotspotLabels(): boolean {
  const [, setRevision] = useState(0);
  useEffect(() => {
    const l = () => setRevision(n => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return hotspotLabels();
}

/** Forgets what was read and any session's binding, so the next read looks at storage again (tests). */
export function resetHotspotLabels(): void {
  loaded = false;
  on = false;
  keep = null;
}

/**
 * Whether the room's labels show (the stage's `hotspotLabels`): the setting, but only while the team is away. Aboard, the stage can still
 * hold the last away room, and its names must not sit over the ship's screens.
 */
export function roomHotspotLabels(world: { state: { onShip: unknown } } | undefined): boolean {
  return hotspotLabels() && world !== undefined && world.state.onShip === null;
}
