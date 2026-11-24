// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { barSegments, DEFAULT_SETTINGS, levelFromBar, type Settings } from '../../web/settings';
import type { ConsoleSound, SettingsPort } from '../../web/settingsPort';
import type { AdminArt } from '../faces';
import type { SaveMeta } from '../saves';
import type { SavesPort } from '../savesPort';
import { BitmapFont } from '../../view/indexed';
import type { AstroFonts } from '../../view/bitmapText';
import { bindSkipClick } from '../skipClick';
import { UiStore } from '../store';
import { AdminConsole, LED_MS } from './adminConsole';

/** Made-up ports that record what the console asks of them. */
function ports(over: { canSave?: boolean; refusal?: string; gameOver?: boolean; away?: boolean; metas?: SaveMeta[]; settings?: Partial<Settings> } = {}) {
  const store = new UiStore();
  store.set({ panel: 'admin' });
  let now: Settings = { ...structuredClone(DEFAULT_SETTINGS as Settings), ...over.settings };
  const sounds: [ConsoleSound, number | undefined][] = [];
  const calls: string[] = [];
  const metas: SaveMeta[] = over.metas ?? [{ slot: 2, label: 'Engine room', screen: 'room', savedAt: 1 }];
  const settings: SettingsPort = {
    get: () => structuredClone(now),
    set: change => { now = { ...now, ...change }; },
    canChangeDifficulty: () => !over.away,
    adminOpen: () => store.state.panel === 'admin',
    openAdmin: () => { store.set({ panel: 'admin' }); return true; },
    closeAdmin: () => { calls.push('close'); store.set({ panel: 'none' }); },
    sound: (name, level) => { sounds.push([name, level]); },
    gameOver: () => over.gameOver ?? false,
    newGame: async () => { calls.push('new game'); },
    quit: async () => { calls.push('quit'); },
  };
  const saves: SavesPort = {
    gameId: 'demo',
    list: async () => [...metas],
    canSave: () => over.canSave ?? true,
    refusal: () => over.refusal ?? null,
    save: async (slot, name) => { calls.push(`save ${slot} ${name}`); },
    load: async slot => { calls.push(`load ${slot}`); },
    exportText: () => '{}',
    importText: async () => { calls.push('import'); },
  };
  return { store, settings, saves, sounds, calls, now: () => now };
}

const settleUi = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

const mounted: HTMLElement[] = [];
afterEach(() => {
  for (const root of mounted.splice(0)) act(() => render(null, root));
  document.body.innerHTML = '';
  vi.useRealTimers();
});

async function show(p: ReturnType<typeof ports>, opts: { art?: AdminArt; fonts?: AstroFonts; measure?: (text: string) => number } = {}) {
  const root = document.body.appendChild(document.createElement('div'));
  mounted.push(root);
  act(() => render(<AdminConsole settings={p.settings} saves={p.saves} store={p.store} art={opts.art} fonts={opts.fonts} measure={opts.fonts ? opts.measure : opts.measure ?? (t => t.length * 8)} />, root));
  await settleUi();
  const console = root.querySelector<HTMLElement>('.au-admin-console')!;
  // (the console in the original's pixels: 420 by 478, at the page's top left)
  console.getBoundingClientRect = () => ({ left: 0, top: 0, width: 420, height: 478, right: 420, bottom: 478, x: 0, y: 0, toJSON: () => ({}) });
  return { root, console };
}

const named = (root: HTMLElement, name: string) => root.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
const press = async (root: HTMLElement, name: string) => {
  const b = named(root, name);
  if (!b) throw new Error(`no button "${name}"`);
  act(() => b.click());
  await settleUi();
};
const key = (k: string) => act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });
const message = (root: HTMLElement) => root.querySelector('.au-admin-message')!.textContent;
const page = (root: HTMLElement) => root.querySelector<HTMLElement>('.au-admin-console')!.dataset.page;
const row = (root: HTMLElement, slot: number) => root.querySelector<HTMLButtonElement>(`button[data-slot="${slot}"]`)!;

describe('the admin console (phase4_rest.md §6.2)', () => {
  it('each button opens its page, with its message and sound', async () => {
    const p = ports();
    const { root } = await show(p);
    expect([page(root), message(root)]).toEqual(['paused', 'Game paused']);
    const pages: [string, string, string, ConsoleSound | null][] = [
      ['LOAD', 'load', 'Select game to load', 'beep7'],
      ['SAVE', 'save', 'Select slot to save', 'beep7'],
      ['NEW', 'new', 'Start new game', 'beep7'],
      ['QUIT', 'quit', 'Quit game', 'beep7'],
      ['SOUND LEVELS', 'sound', 'Sound levels', 'beep7'],
      // (SOUND LEVELS again goes back: the original's state 4 and state 0)
      ['SOUND LEVELS', 'paused', 'Game paused', 'beep7'],
      ['SETTINGS', 'settings', 'Settings', 'beep7'],
    ];
    for (const [name, wanted, says, sound] of pages) {
      p.sounds.length = 0;
      await press(root, name);
      expect([name, page(root), message(root), p.sounds.map(s => s[0])]).toEqual([name, wanted, says, sound ? [sound] : []]);
    }
    p.sounds.length = 0;
    await press(root, 'TEXT ON');
    await press(root, 'DIFFICULTY LIEUTENANT');
    expect(p.sounds.map(s => s[0])).toEqual(['softbop', 'softbop']);
    p.sounds.length = 0;
    await press(root, 'RESUME');
    expect([p.calls, p.sounds, p.store.state.panel]).toEqual([['close'], [], 'none']);
  });

  it('shows each slot by its name, and the load page loads the one clicked', async () => {
    const p = ports({ metas: [{ slot: 2, label: 'Engine room', screen: 'room', savedAt: 1 }, { slot: 0, label: 'Autosave, today', screen: 'room', savedAt: 2 }] });
    const { root } = await show(p);
    await press(root, 'LOAD');
    const rows = [...root.querySelectorAll<HTMLButtonElement>('button[data-slot]')].filter(b => b.dataset.slot !== '0');
    expect(rows.map(r => r.textContent)).toEqual(['', 'Engine room', '', '', '', '', '', '', '']);
    act(() => row(root, 1).click());
    await settleUi();
    expect(p.calls).toEqual([]);
    act(() => row(root, 2).click());
    await settleUi();
    expect(p.calls).toEqual(['load 2', 'close']);
    // (the autosave is the remake's: a load-only entry on the load page)
    await press(root, 'LOAD');
    await press(root, 'AUTOSAVE');
    expect(p.calls.slice(2)).toEqual(['load 0', 'close']);
  });

  it('shows a stored label that is not a name the console could have taken (an old save\'s screen id and date) as Save Game N', async () => {
    const p = ports({ metas: [
      { slot: 2, label: 'Engine room', screen: 'room', savedAt: 1 },
      // (a save from before Plan 32: the screen's id and a locale date, with U+202F, which the font lacks)
      { slot: 3, label: 'room, 10/30/2026, 3:04\u202fPM', screen: 'room', savedAt: 2 },
      { slot: 4, label: 'b'.repeat(31), screen: 'room', savedAt: 3 },
      { slot: 5, label: 'Under @ sign', screen: 'room', savedAt: 4 },
    ] });
    const { root } = await show(p);
    await press(root, 'LOAD');
    const rows = [...root.querySelectorAll<HTMLButtonElement>('button[data-slot]')].filter(b => b.dataset.slot !== '0');
    expect(rows.slice(0, 5).map(r => r.textContent)).toEqual(['', 'Engine room', 'Save Game 3', 'Save Game 4', 'Save Game 5']);
    // (saving over one starts from the name shown)
    await press(root, 'SAVE');
    act(() => row(root, 3).click());
    await settleUi();
    expect(row(root, 3).textContent).toBe('Save Game 3');
  });

  it('SAVE stays while the game cannot be saved now and says why when pressed; RESUME stays; the failure screen has neither', async () => {
    // (RESUME stays: a player with no keys has no Esc to close it by)
    const busy = await show(ports({ canSave: false }));
    expect([named(busy.root, 'SAVE') !== null, named(busy.root, 'RESUME') !== null, message(busy.root)]).toEqual([true, true, 'Game paused']);
    await press(busy.root, 'SAVE');
    expect([page(busy.root), message(busy.root)]).toEqual(['paused', 'The game cannot be saved just now']);
    act(() => render(null, busy.root));
    // (the game's own reason, as a battle's)
    const battle = await show(ports({ canSave: false, refusal: 'Made-up refusal.' }));
    await press(battle.root, 'SAVE');
    expect([page(battle.root), message(battle.root)]).toEqual(['paused', 'Made-up refusal.']);
    act(() => render(null, battle.root));
    const failed = await show(ports({ gameOver: true }));
    expect([named(failed.root, 'SAVE'), named(failed.root, 'RESUME')]).toEqual([null, null]);
    expect(named(failed.root, 'LOAD')).not.toBeNull();
  });

  it('typing a name and Enter saves to the chosen slot; Backspace deletes; refused characters are ignored', async () => {
    const p = ports();
    const { root } = await show(p);
    await press(root, 'SAVE');
    // (keys before a slot is chosen do nothing)
    key('x');
    act(() => row(root, 3).click());
    await settleUi();
    expect([message(root), row(root, 3).textContent]).toEqual(['Press Enter to save', 'Save Game 3']);
    for (let i = 0; i < 'Save Game 3'.length; i++) key('Backspace');
    for (const c of 'Br@id_ge~') key(c);
    expect(row(root, 3).textContent).toBe('Bridge');
    key('Enter');
    await settleUi();
    expect(p.calls).toEqual(['save 3 Bridge', 'close']);
  });

  it('stops a name at 30 characters, or when it is drawn wider than 256 pixels', async () => {
    const typed = async (measure: (text: string) => number) => {
      const { root } = await show(ports(), { measure });
      await press(root, 'SAVE');
      act(() => row(root, 1).click());
      await settleUi();
      for (let i = 0; i < 11; i++) key('Backspace');
      for (let i = 0; i < 40; i++) key('a');
      const name = row(root, 1).textContent;
      act(() => render(null, root));
      return name;
    };
    expect(await typed(t => t.length * 8)).toHaveLength(30);
    // (a character is taken while the name so far is at most 256 wide: at 10 a character, 25 fit and the 26th is the last)
    expect(await typed(t => t.length * 10)).toHaveLength(26);
  });

  it('Esc from the save page closes without saving (Review Focus 2), and no key reaches the game behind', async () => {
    const p = ports();
    const { root } = await show(p);
    const behind = vi.fn();
    document.addEventListener('keydown', behind);
    await press(root, 'SAVE');
    act(() => row(root, 4).click());
    await settleUi();
    key('B');
    key('Escape');
    await settleUi();
    expect([p.calls, p.store.state.panel, behind.mock.calls.length]).toEqual([['close'], 'none', 0]);
    document.removeEventListener('keydown', behind);
  });

  it('NEW and QUIT ask YES/NO; YES restarts / quits, NO returns', async () => {
    const p = ports();
    const { root } = await show(p);
    await press(root, 'NEW');
    await press(root, 'NO');
    expect([page(root), message(root), p.calls]).toEqual(['paused', 'Game paused', []]);
    await press(root, 'NEW');
    await press(root, 'YES');
    expect(p.calls).toEqual(['new game']);
    await press(root, 'QUIT');
    await press(root, 'NO');
    expect(page(root)).toBe('paused');
    await press(root, 'QUIT');
    await press(root, 'YES');
    expect(p.calls).toEqual(['new game', 'quit']);
    // (YES and NO are only on their pages)
    expect(named(root, 'YES')).not.toBeNull();
    await press(root, 'LOAD');
    expect(named(root, 'YES')).toBeNull();
    await press(root, 'CANCEL');
    expect(page(root)).toBe('paused');
  });

  it('a click at bar height y sets the level levelFromBar(y) and plays beep14 at it', async () => {
    const p = ports({ settings: { voices: 0, music: 1 } });
    const { root } = await show(p);
    await press(root, 'SOUND LEVELS');
    const voices = root.querySelector<HTMLElement>('[role=slider][aria-label="VOICES/EFFECTS"]')!;
    const music = root.querySelector<HTMLElement>('[role=slider][aria-label="MUSIC/BACKGROUND"]')!;
    const lit = (bar: HTMLElement) => bar.querySelectorAll('[data-seg="on"]').length;
    expect([lit(voices), lit(music)]).toEqual([0, 27]);
    p.sounds.length = 0;
    // (y is the original's screen: the console's top is 1 down)
    act(() => { voices.dispatchEvent(new PointerEvent('pointerdown', { clientX: 120, clientY: 150 - 1, button: 0, bubbles: true })); });
    await settleUi();
    expect(p.now().voices).toBeCloseTo(levelFromBar(150));
    expect(p.sounds).toEqual([['beep14', levelFromBar(150)]]);
    expect(lit(root.querySelector<HTMLElement>('[role=slider][aria-label="VOICES/EFFECTS"]')!)).toBe(barSegments(levelFromBar(150)));
    // (under 800 of 0x7fff is silence)
    act(() => { music.dispatchEvent(new PointerEvent('pointerdown', { clientX: 300, clientY: 241 - 1, button: 0, bubbles: true })); });
    await settleUi();
    expect([p.now().music, p.sounds.at(-1)]).toEqual([0, ['beep14', 0]]);
  });

  it('the arrow keys move a focused sound bar a segment', async () => {
    const p = ports({ settings: { voices: 0.5 } });
    const { root } = await show(p);
    await press(root, 'SOUND LEVELS');
    const bar = () => root.querySelector<HTMLElement>('[role=slider][aria-label="VOICES/EFFECTS"]')!;
    const lit = () => bar().querySelectorAll('[data-seg="on"]').length;
    const before = lit();
    bar().focus();
    act(() => { bar().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })); });
    await settleUi();
    expect([lit(), p.sounds.at(-1)?.[0]]).toEqual([before + 1, 'beep14']);
    act(() => { bar().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); });
    await settleUi();
    expect(lit()).toBe(before);
  });

  it('keeps Tab on the console, and makes the game behind it inert while it is up', async () => {
    const behind = document.body.appendChild(document.createElement('button'));
    behind.textContent = 'Behind';
    const p = ports();
    const { root } = await show(p);
    expect(behind.hasAttribute('inert')).toBe(true);
    const console = root.querySelector('.au-admin-console')!;
    for (let i = 0; i < 30; i++) {
      key('Tab');
      expect(console.contains(document.activeElement)).toBe(true);
    }
    // (Enter on something behind, should the focus get there, presses nothing)
    const pressed = vi.fn();
    behind.addEventListener('click', pressed);
    behind.focus();
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    act(() => { behind.dispatchEvent(enter); });
    expect(enter.defaultPrevented).toBe(true);
    act(() => render(null, root));
    expect(behind.hasAttribute('inert')).toBe(false);
  });

  it("draws its words in the game's font 2 when it is published, and stops a name by that font's widths", async () => {
    // (a made-up colour font: every character 10 wide, 16 high)
    const height = 16, wide = 10;
    const font = new BitmapFont(new Uint8Array([1, height, 0x20, 0x7e, (height * wide + 1) & 0xff, (height * wide + 1) >> 8, 0, 1, wide,
      ...Array.from({ length: 0x5f }, () => [wide, ...Array<number>(height * wide).fill(173)]).flat()]));
    const fonts: AstroFonts = { fonts: [font, font, font], palette: new Uint8Array(768).fill(200) };
    const p = ports();
    const { root } = await show(p, { fonts });
    expect(root.querySelector('canvas[data-bitmap-text="Game paused"]')).toBeTruthy();
    // (the words stay in the page, unseen)
    expect(root.querySelector('.au-admin-message')!.classList.contains('au-admin-quiet')).toBe(true);
    await press(root, 'LOAD');
    expect(root.querySelector('canvas[data-bitmap-text="Engine room"]')).toBeTruthy();
    await press(root, 'SAVE');
    act(() => row(root, 1).click());
    await settleUi();
    for (let i = 0; i < 11; i++) key('Backspace');
    for (let i = 0; i < 40; i++) key('a');
    // (taken while the name so far is at most 256 wide: 25 at 10 a character fit, and the 26th is the last)
    expect(row(root, 1).textContent).toHaveLength(26);
    expect(root.querySelector('canvas[data-bitmap-text="_"]')).toBeTruthy();
  });

  it('cuts a stored name drawn wider than its row with "...", as the strip does', async () => {
    const height = 16, wide = 10;
    const font = new BitmapFont(new Uint8Array([1, height, 0x20, 0x7e, (height * wide + 1) & 0xff, (height * wide + 1) >> 8, 0, 1, wide,
      ...Array.from({ length: 0x5f }, () => [wide, ...Array<number>(height * wide).fill(173)]).flat()]));
    const fonts: AstroFonts = { fonts: [font, font, font], palette: new Uint8Array(768).fill(200) };
    // (30 characters, a valid name: 300 wide in this font, wider than the row)
    const { root } = await show(ports({ metas: [{ slot: 2, label: 'W'.repeat(30), screen: 'room', savedAt: 1 }] }), { fonts });
    await press(root, 'LOAD');
    const drawn = root.querySelector<HTMLCanvasElement>('canvas[data-bitmap-text^="WWW"]')!;
    expect(drawn.dataset.bitmapText).toMatch(/^W+\.\.\.$/);
    expect(drawn.width).toBeLessThan(300);
    // (the whole name stays in the page)
    expect(row(root, 2).textContent).toBe('W'.repeat(30));
  });

  it('keeps a long message inside the strip, cut at a letter with "..."', async () => {
    const height = 16, wide = 10;
    const font = new BitmapFont(new Uint8Array([1, height, 0x20, 0x7e, (height * wide + 1) & 0xff, (height * wide + 1) >> 8, 0, 1, wide,
      ...Array.from({ length: 0x5f }, () => [wide, ...Array<number>(height * wide).fill(173)]).flat()]));
    const fonts: AstroFonts = { fonts: [font, font, font], palette: new Uint8Array(768).fill(200) };
    const long = 'A made-up refusal of 33 letters.!';
    expect(long).toHaveLength(33);
    const { root } = await show(ports({ canSave: false, refusal: long }), { fonts });
    await press(root, 'SAVE');
    const strip = root.querySelector<HTMLCanvasElement>('canvas.au-admin-bt[data-bitmap-text$="..."]')!;
    expect(strip).toBeTruthy();
    // (the strip is 161 wide: (216,21)-(376,37))
    expect(strip.width).toBeLessThanOrEqual(161);
    const left = parseFloat(strip.style.left) / 100 * 420, width = parseFloat(strip.style.width) / 100 * 420;
    expect([left >= 216 - 1e-6, left + width <= 377 + 1e-6]).toEqual([true, true]);
    expect(strip.dataset.bitmapText).toBe(`${long.slice(0, 13).trimEnd()}...`);
    // (the whole message stays in the page)
    expect(message(root)).toBe(long);
  });

  it('steps a sound bar twice for two quick presses, before it is drawn again', async () => {
    const p = ports({ settings: { voices: 0.5 } });
    const { root } = await show(p);
    await press(root, 'SOUND LEVELS');
    const bar = () => root.querySelector<HTMLElement>('[role=slider][aria-label="VOICES/EFFECTS"]')!;
    const before = barSegments(0.5);
    bar().focus();
    const up = () => bar().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    act(() => { up(); up(); });
    expect(barSegments(p.now().voices)).toBe(before + 2);
  });

  it('keeps Space from pressing a button behind the console as the key comes up', async () => {
    const behind = document.body.appendChild(document.createElement('button'));
    const { root } = await show(ports());
    const up = new KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true });
    act(() => { behind.dispatchEvent(up); });
    expect(up.defaultPrevented).toBe(true);
    const inside = new KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true });
    act(() => { root.querySelector<HTMLButtonElement>('button[aria-label="LOAD"]')!.dispatchEvent(inside); });
    expect(inside.defaultPrevented).toBe(false);
  });

  it('TEXT toggles text; DIFFICULTY cycles 0→1→2→0 and is disabled away', async () => {
    const p = ports({ settings: { text: true, difficulty: 0 } });
    const { root } = await show(p);
    await press(root, 'TEXT ON');
    expect(p.now().text).toBe(false);
    await press(root, 'TEXT OFF');
    expect(p.now().text).toBe(true);
    const seen: number[] = [];
    for (const name of ['DIFFICULTY ENSIGN', 'DIFFICULTY LIEUTENANT', 'DIFFICULTY CAPTAIN']) {
      await press(root, name);
      seen.push(p.now().difficulty);
    }
    expect(seen).toEqual([1, 2, 0]);
    const away = await show(ports({ away: true }));
    const difficulty = away.root.querySelector<HTMLButtonElement>('button[aria-label^="DIFFICULTY"]')!;
    expect(difficulty.disabled).toBe(true);
  });

  it('chases its LEDs every 20 ticks of 60 Hz on its own timer, while the game is stopped', async () => {
    vi.useFakeTimers();
    const p = ports();
    const root = document.body.appendChild(document.createElement('div'));
    mounted.push(root);
    act(() => render(<AdminConsole settings={p.settings} saves={p.saves} store={p.store} measure={t => t.length * 8} />, root));
    const head = () => [...root.querySelectorAll<HTMLElement>('.au-admin-leds-top [data-led]')].findIndex(l => l.dataset.led === '2');
    expect(LED_MS).toBe(Math.round((20 * 1000) / 60));
    const first = head();
    act(() => { vi.advanceTimersByTime(LED_MS); });
    expect(head()).toBe((first + 1) % 11);
  });

  it('draws the published pictures where the original does, when there are some', async () => {
    const button = (name: string) => `/admin/${name}.webp`;
    const art: AdminArt = { scale: 4, frame: i => `/admin/frame${i}.webp`, button, settings: '/admin/settings.webp', settingsLit: '/admin/settingsLit.webp' };
    const p = ports({ settings: { difficulty: 2 } });
    const { root } = await show(p, { art });
    const srcs = () => [...root.querySelectorAll('img')].map(i => i.getAttribute('src'));
    expect(srcs()).toContain('/admin/frame0.webp');
    expect(srcs()).toContain('/admin/captain.webp');
    expect(srcs()).toContain('/admin/settings.webp');
    expect(root.querySelector<HTMLImageElement>('img[src="/admin/frame0.webp"]')!.style.width).toBe('100%');
    await press(root, 'LOAD');
    expect(srcs()).toContain('/admin/frame1.webp');
    // (the console's own pixels: no CSS stand-in text on its buttons)
    expect(named(root, 'CANCEL')!.textContent).toBe('');
    // (the lower LED row's groove is covered from the original's face)
    expect(root.querySelectorAll('.au-admin-cover')).toHaveLength(1);
  });

  it('draws no groove cover over an HD body, whose publish painted the groove out (Plan 32 Task 12)', async () => {
    const button = (name: string) => `/admin/${name}.webp`;
    const art: AdminArt = { scale: 4, frame: i => (i === 0 ? '/admin/frame0.hd.webp' : `/admin/frame${i}.webp`), button, settings: '/admin/settings.webp', settingsLit: '/admin/settingsLit.webp', bodyHd: true };
    const { root } = await show(ports({ settings: { difficulty: 2 } }), { art });
    expect(root.querySelector('img[src="/admin/frame0.hd.webp"]')).not.toBeNull();
    expect(root.querySelectorAll('.au-admin-cover')).toHaveLength(0);
  });

  it('fetches and decodes the screen\'s pages as it opens, so a page is drawable the frame it comes up (Plan 33 Task 7)', async () => {
    const made: { src: string; decoded: boolean }[] = [];
    vi.stubGlobal('Image', class {
      private rec = { src: '', decoded: false };
      constructor() { made.push(this.rec); }
      set src(v: string) { this.rec.src = v; }
      decode() { this.rec.decoded = true; return Promise.resolve(); }
    });
    try {
      const button = (name: string) => `/admin/${name}.webp`;
      const art: AdminArt = { scale: 4, frame: i => (i === 0 ? '/admin/frame0.webp' : `/admin/frame${i}.hd.webp`), button, settings: '/admin/settings.webp', settingsLit: '/admin/settingsLit.webp' };
      await show(ports({ settings: { difficulty: 2 } }), { art });
      expect(made).toEqual([1, 2, 3, 4, 5].map(i => ({ src: `/admin/frame${i}.hd.webp`, decoded: true })));
      // (without pictures, nothing to fetch)
      made.length = 0;
      await show(ports({ settings: { difficulty: 2 } }));
      expect(made).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('with the art off the pages preload the originals (Plan 34 Task 2)', async () => {
    const made: { src: string }[] = [];
    vi.stubGlobal('Image', class {
      private rec = { src: '' };
      constructor() { made.push(this.rec); }
      set src(v: string) { this.rec.src = v; }
      decode() { return Promise.resolve(); }
    });
    try {
      const button = (name: string) => `/admin/${name}.webp`;
      // (art.frame gives the original's page where the art is off: the preload follows it, not the HD name)
      const art: AdminArt = { scale: 4, frame: i => `/admin/frame${i}.webp`, button, settings: '/admin/settings.webp', settingsLit: '/admin/settingsLit.webp' };
      await show(ports({ settings: { difficulty: 2 } }), { art });
      expect(made.map(m => m.src)).toEqual([1, 2, 3, 4, 5].map(i => `/admin/frame${i}.webp`));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('unmounting drops the preloaded images (Plan 34 Task 2)', async () => {
    const made: { src: string }[] = [];
    vi.stubGlobal('Image', class {
      private rec = { src: '' };
      constructor() { made.push(this.rec); }
      set src(v: string) { this.rec.src = v; }
      decode() { return Promise.resolve(); }
    });
    try {
      const button = (name: string) => `/admin/${name}.webp`;
      const art: AdminArt = { scale: 4, frame: i => `/admin/frame${i}.hd.webp`, button, settings: '/admin/settings.webp', settingsLit: '/admin/settingsLit.webp' };
      const { root } = await show(ports({ settings: { difficulty: 2 } }), { art });
      expect(made.map(m => m.src).every(src => src !== '')).toBe(true);
      act(() => render(null, root));
      expect(made).toHaveLength(5);
      expect(made.map(m => m.src)).toEqual(['', '', '', '', '']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps a click on it from skipping the line being said behind it', () => {
    const store = new UiStore();
    const root = document.body.appendChild(document.createElement('div'));
    const skip = vi.fn();
    const off = bindSkipClick(root, store, skip);
    store.set({ subtitle: { who: 'picard', name: 'Picard', text: 'Made-up words.' }, panel: 'admin' });
    root.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
    expect(skip).not.toHaveBeenCalled();
    off();
  });
});
