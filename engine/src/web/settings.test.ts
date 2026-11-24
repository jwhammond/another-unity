// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { KEY_MAP } from '../view/combat/controls';
import { BINDABLE_ACTIONS, DEFAULT_KEYS } from '../view/combat/bindings';
import { barSegments, DEFAULT_SETTINGS, levelFromBar, readSettings, SETTINGS_KEY, writeSettings } from './settings';

const store = (o: Record<string, string>) => ({ getItem: (k: string) => o[k] ?? null });

describe('settings', () => {
  it('missing or broken storage gives the defaults', () => {
    expect(readSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(readSettings(store({}))).toEqual(DEFAULT_SETTINGS);
    expect(readSettings(store({ [SETTINGS_KEY]: '{nope' }))).toEqual(DEFAULT_SETTINGS);
    expect(readSettings({ getItem: () => { throw new Error('denied'); } })).toEqual(DEFAULT_SETTINGS);
  });

  it('unknown values fall back field by field', () => {
    const s = readSettings(store({ [SETTINGS_KEY]: JSON.stringify({ master: 'x', music: 0.25, difficulty: 7, combat: { stars: false, detail: 'ultra' }, keys: { pause: 'o', stop: 3 } }) }));
    expect(s.master).toBe(0.5);
    expect(s.music).toBe(0.25);
    expect(s.difficulty).toBe(1);
    expect(s.combat).toEqual({ stars: false, resolution: 1, radar: true, detail: 'high' });
    expect(s.keys.pause).toBe('o');
    expect(s.keys.stop).toBe('Enter');
    expect(readSettings(store({ [SETTINGS_KEY]: JSON.stringify({ keys: { pause: 'x'.repeat(17), stop: '', phasers: 'g' } }) })).keys)
      .toEqual({ ...DEFAULT_KEYS, phasers: 'g' });
  });

  describe('stored key bindings', () => {
    const read = (keys: Record<string, unknown>) => readSettings(store({ [SETTINGS_KEY]: JSON.stringify({ keys }) })).keys;
    it('normalises a letter to lower case', () => {
      expect(read({ phasers: 'K' })).toEqual({ ...DEFAULT_KEYS, phasers: 'k' });
    });
    it('sends the later of two actions with one key back to its default', () => {
      expect(read({ pitchDown: 'k', pitchUp: 'K' })).toEqual({ ...DEFAULT_KEYS, pitchDown: 'k' });
    });
    it('sends an action back to its default for a fixed key, a view or orbit key, or the browser\'s own', () => {
      expect(read({ phasers: 'F1', torpedoes: 'Escape', stop: '3', pause: '0', fireBoth: 'F5', cycleSpeed: 'F12', zoomIn: 'F6' })).toEqual(DEFAULT_KEYS);
    });
    it('leaves no duplicate when a default clashes with an earlier action\'s key', () => {
      // (torpedoes is bound to the Enter that stop has by default, and stop is stored as itself)
      const keys = read({ torpedoes: 'Enter' });
      expect(new Set(Object.values(keys)).size).toBe(Object.values(keys).length);
    });
  });

  it('the legacy keys are folded in once', () => {
    const legacy = { 'au.difficulty': '2', 'au.combatAssists': JSON.stringify({ difficulty: 'story', speed: 4 }), 'au.hotspotLabels': '1' };
    const s = readSettings(store(legacy));
    expect(s.difficulty).toBe(2);
    expect(s.assists).toEqual({ difficulty: 'story', speed: 4 });
    expect(s.hotspots).toBe(true);
    // once a record exists the legacy keys no longer count
    expect(readSettings(store({ ...legacy, [SETTINGS_KEY]: '{}' }))).toEqual(DEFAULT_SETTINGS);
  });

  it('levelFromBar matches the original', () => {
    expect(levelFromBar(244)).toBe(0);
    expect(levelFromBar(82)).toBe(1);
    expect(levelFromBar(70)).toBe(1);
    expect(levelFromBar(244 - (799 * 162) / 0x7fff)).toBe(0);
    expect(levelFromBar(163)).toBeCloseTo(81 / 162, 2);
  });

  it('barSegments counts the lit segments of 27', () => {
    expect(barSegments(0)).toBe(0);
    expect(barSegments(1)).toBe(27);
    expect(barSegments(0.5)).toBe(14);
    // a step boundary: the segment at y = 81 + 6 * 2 = 93 is lit from an edge of 93 down, dark above it
    expect(barSegments((240 - 92.5) / 162)).toBe(25);
    expect(barSegments((240 - 93.5) / 162)).toBe(24);
    expect(barSegments(levelFromBar(244))).toBe(0);
  });

  it('a write round-trips', () => {
    const o: Record<string, string> = {};
    const s = { ...DEFAULT_SETTINGS, master: 0.8, hotspots: true, difficulty: 2 as const, keys: { ...DEFAULT_KEYS, pause: 'o' } };
    writeSettings({ setItem: (k, v) => { o[k] = v; } }, s);
    expect(readSettings(store(o))).toEqual(s);
    expect(() => writeSettings(undefined, s)).not.toThrow();
  });

  it('every default key is one KEY_MAP gives that action', () => {
    for (const a of BINDABLE_ACTIONS) expect(KEY_MAP[DEFAULT_KEYS[a]], a).toBe(a);
  });

  it('a settings record without threeD reads as on, its other fields kept', () => {
    const old = { master: 0.8, voices: 0.4, music: 0.3, text: false, art: false, hotspots: true, movies: false, difficulty: 2, combat: { stars: false, resolution: 2, radar: false, detail: 'low' }, keys: { pause: 'o' } };
    const s = readSettings(store({ [SETTINGS_KEY]: JSON.stringify(old) }));
    expect(DEFAULT_SETTINGS.threeD).toBe(true);
    expect(s).toEqual({ ...DEFAULT_SETTINGS, ...old, assists: DEFAULT_SETTINGS.assists, keys: { ...DEFAULT_KEYS, pause: 'o' }, threeD: true });
    // (and a broken one is on too)
    expect(readSettings(store({ [SETTINGS_KEY]: JSON.stringify({ ...old, threeD: 'yes' }) })).threeD).toBe(true);
  });

  it('threeD round-trips', () => {
    const o: Record<string, string> = {};
    const s = { ...DEFAULT_SETTINGS, threeD: false };
    writeSettings({ setItem: (k, v) => { o[k] = v; } }, s);
    expect(readSettings(store(o))).toEqual(s);
    expect(readSettings(store(o)).threeD).toBe(false);
  });
});
