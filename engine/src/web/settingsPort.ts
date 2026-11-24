// SPDX-License-Identifier: GPL-3.0-or-later
import { readSettings, writeSettings, type Settings } from './settings';

/** The admin console's sounds (phase4_rest.md §6.2): rgcd as it opens, beep7 a button, beep14 a sound bar, softbop a toggle. */
export type ConsoleSound = 'rgcd' | 'beep7' | 'beep14' | 'softbop';

/** Each console sound's name in presentation.yaml's `shipSounds` (the lifter's SHIP_SOUNDS): beep7 and softbop are the ship screens' own. */
export const CONSOLE_SOUNDS: Readonly<Record<ConsoleSound, string>> = { rgcd: 'adminOpen', beep7: 'shipBeep', beep14: 'adminLevel', softbop: 'shipSoftbop' };

/**
 * What the admin PADD (Plan 32) asks of the session: the settings record, applied at once, and the console being open, which stops the
 * game (the original's admin menu stops the clock and pauses the music: phase4_rest.md §6.2, §9).
 */
export interface SettingsPort {
  get(): Settings;
  /** Applies at once, and keeps the record, less any field a URL parameter set for this page load. */
  set(change: Partial<Settings>): void;
  /** Only while no team is away (metaengine.cpp:84-86). */
  canChangeDifficulty(): boolean;
  adminOpen(): boolean;
  /** False, and nothing opens, while a warp is pending (the original's callers refuse with -1: phase4_rest.md §6.1). */
  openAdmin(): boolean;
  closeAdmin(): void;
  /** One of the console's sounds, at `level` (0..1) of its bus where given. */
  sound(name: ConsoleSound, level?: number): void;
  /** The game is over: the original's game-failure screen opens the console with no SAVE and no RESUME (phase4_rest.md §6.1). */
  gameOver(): boolean;
  /** NEW's YES: a new game (the original loads its restart point, savegame.0). */
  newGame(): Promise<void>;
  /** QUIT's YES: the game ends as the original's quit does, with the credits and then the title (result 0x20fe: game over 0x20). */
  quit(): Promise<void>;
}

/** The fields a URL parameter gives for this page load (`?difficulty=`, `?art=`): applied, never written back. */
export type SettingsOverrides = Partial<Pick<Settings, 'difficulty' | 'art'>>;

type SettingsStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** The page's localStorage, or none where the browser refuses it (the settings then last for the page). */
export function pageStorage(): SettingsStorage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The settings in force: the stored record (settings.ts readSettings) with this load's URL overrides over it. A change is checked as a
 * stored record is, and written back whole, from what is stored, with the overridden fields left as
 * the player last kept them (Plan 32 Review Focus 1: readSettings folds in the legacy keys only while there is no record).
 */
export class SettingsRecord {
  private current: Settings;

  constructor(private readonly storage: () => SettingsStorage | undefined, private readonly overrides: SettingsOverrides = {}) {
    this.current = { ...readSettings(storage()), ...overrides };
  }

  /** The settings in force (not to be changed: `change` does that). */
  get now(): Readonly<Settings> {
    return this.current;
  }

  /** Takes a change, returning the settings now in force; the stored record changes only for the fields not overridden. */
  change(change: Partial<Settings>): Readonly<Settings> {
    // (checked as a stored record is: a level clamped to 0..1, a value that is not one of the field's its default)
    const next = readSettings({ getItem: () => JSON.stringify({ ...this.current, ...change }) });
    this.current = next;
    const kept = Object.keys(change).filter(k => k in next && !(k in this.overrides)) as (keyof Settings)[];
    if (kept.length > 0) {
      const storage = this.storage();
      const stored = readSettings(storage) as unknown as Record<keyof Settings, unknown>;
      for (const key of kept) stored[key] = next[key];
      writeSettings(storage, stored as unknown as Settings);
    }
    return next;
  }
}
