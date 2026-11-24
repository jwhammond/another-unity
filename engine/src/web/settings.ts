// SPDX-License-Identifier: GPL-3.0-or-later
import { ORIGINAL_ASSISTS, readAssists, type CombatAssists } from '../sim/combat/assists';
import { DEFAULT_KEYS, soundKeys, type BindableAction } from '../view/combat/bindings';

/**
 * Every setting the player keeps, in one record (Plan 32): the sound, what the PADD shows, the difficulty, the combat assists and
 * options, and the battle's keys. Per player, not in the save. Pure: the Session applies it, the admin PADD edits it.
 */

/** The battle's own options (the original's, ScummVM's detail and keys, are the port's settings here). */
export interface CombatOptions { stars: boolean; resolution: 1 | 2; radar: boolean; detail: 'high' | 'medium' | 'low' }
export type KeyBindings = Readonly<Record<BindableAction, string>>;

export interface Settings {
  /** Each 0..1: `voices` is the voice and effects buses, `music` the music and ambience. */
  master: number; voices: number; music: number;
  text: boolean; art: boolean; hotspots: boolean; movies: boolean;
  /** 3D SOUND: combat's effects panned by their bearing from the camera (the port's; off is the original's mono mix). */
  threeD: boolean;
  difficulty: 0 | 1 | 2; assists: CombatAssists; combat: CombatOptions; keys: KeyBindings;
}

export const SETTINGS_KEY = 'au.settings';
/** The keys before the record, folded in when it has none (what session.ts and ui/hotspotLabels.ts kept them under before Plan 32). */
const LEGACY_DIFFICULTY = 'au.difficulty';
const LEGACY_ASSISTS = 'au.combatAssists';
const LEGACY_HOTSPOTS = 'au.hotspotLabels';

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  master: 0.5, voices: 1, music: 1, text: true, art: true, hotspots: false, movies: true, threeD: true,
  difficulty: 1, assists: ORIGINAL_ASSISTS,
  combat: Object.freeze({ stars: true, resolution: 1, radar: true, detail: 'high' }),
  keys: DEFAULT_KEYS,
});

const DETAILS = ['high', 'medium', 'low'] as const;

function level(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
}
function flag(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}
function record(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}
function get(storage: Pick<Storage, 'getItem'> | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function parse(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The stored settings, read leniently: a missing or broken record is the defaults, and each field that is not a valid value is
 * its default alone. Where there is no record, the legacy keys give the difficulty, the assists and the hotspot labels; once a
 * record is written it is the only source.
 */
export function readSettings(storage: Pick<Storage, 'getItem'> | undefined): Settings {
  const raw = get(storage, SETTINGS_KEY);
  const stored = parse(raw);
  const s = record(stored);
  const hasRecord = stored !== null && typeof stored === 'object' && !Array.isArray(stored);

  let difficulty: unknown = s.difficulty;
  let assists: unknown = s.assists;
  let hotspots: unknown = s.hotspots;
  if (!hasRecord) {
    const d = get(storage, LEGACY_DIFFICULTY);
    difficulty = d === null || d.trim() === '' ? undefined : Number(d);
    assists = parse(get(storage, LEGACY_ASSISTS));
    const h = get(storage, LEGACY_HOTSPOTS);
    hotspots = h === null ? undefined : h === '1';
  }
  const c = record(s.combat);
  const k = record(s.keys);
  const keys = soundKeys(k);

  return {
    master: level(s.master, DEFAULT_SETTINGS.master),
    voices: level(s.voices, DEFAULT_SETTINGS.voices),
    music: level(s.music, DEFAULT_SETTINGS.music),
    text: flag(s.text, DEFAULT_SETTINGS.text),
    art: flag(s.art, DEFAULT_SETTINGS.art),
    hotspots: flag(hotspots, DEFAULT_SETTINGS.hotspots),
    movies: flag(s.movies, DEFAULT_SETTINGS.movies),
    threeD: flag(s.threeD, DEFAULT_SETTINGS.threeD),
    difficulty: difficulty === 0 || difficulty === 1 || difficulty === 2 ? difficulty : DEFAULT_SETTINGS.difficulty,
    assists: readAssists(assists),
    combat: {
      stars: flag(c.stars, DEFAULT_SETTINGS.combat.stars),
      resolution: c.resolution === 1 || c.resolution === 2 ? c.resolution : DEFAULT_SETTINGS.combat.resolution,
      radar: flag(c.radar, DEFAULT_SETTINGS.combat.radar),
      detail: (DETAILS as readonly unknown[]).includes(c.detail) ? c.detail as CombatOptions['detail'] : DEFAULT_SETTINGS.combat.detail,
    },
    keys,
  };
}

/** Keeps the record (where the browser lets it: with no storage, or a full one, the settings last for the page). */
export function writeSettings(storage: Pick<Storage, 'setItem'> | undefined, s: Settings): void {
  try {
    storage?.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // (no storage: the settings last for this page)
  }
}

/** The sound bar's top and bottom (y, in the original's screen) and its range: the original's slider maps (244 - y) * 0x7fff / 162. */
const BAR_BOTTOM = 244;
const BAR_HEIGHT = 162;
const BAR_RANGE = 0x7fff;
/** What the original takes as silence: a level under this is 0. */
const BAR_FLOOR = 800;
const BAR_SEGMENTS = 27;

/** The level a click at `y` on the bar gives, 0..1 (the original's, under 800 of 0x7fff silent). */
export function levelFromBar(y: number): number {
  const v = Math.trunc(((BAR_BOTTOM - y) * BAR_RANGE) / BAR_HEIGHT);
  if (!(v >= BAR_FLOOR)) return 0;
  return Math.min(1, v / BAR_RANGE);
}

/**
 * The segments of the bar's 27 that a level lights: segment `i` from the top sits at y = 81 + 6i (237 up to 81, BAR_HEIGHT / 27
 * apart) and the edge is y = 240 - level * 162. The notes' literal rule ("lit when y < 240 - level * 162") would light every
 * segment at silence, so this reads it as dark above the edge and lit from it down. (Plan 32 Tasks 8 and 9 confirm it against the drawing.)
 */
export function barSegments(level: number): number {
  const edge = BAR_BOTTOM - 4 - Math.min(1, Math.max(0, level)) * BAR_HEIGHT;
  let lit = 0;
  for (let i = 0; i < BAR_SEGMENTS; i++) if (BAR_BOTTOM - BAR_HEIGHT - 1 + (BAR_HEIGHT / BAR_SEGMENTS) * i >= edge) lit++;
  return lit;
}
