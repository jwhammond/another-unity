// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BINDABLE_ACTIONS, DEFAULT_KEYS } from '../../view/combat/bindings';
import { barSegments, DEFAULT_SETTINGS, levelFromBar, type Settings } from '../../web/settings';
import type { ConsoleSound, SettingsPort } from '../../web/settingsPort';
import type { AdminArt } from '../faces';
import type { SavesPort } from '../savesPort';
import { UiStore } from '../store';
import { AdminConsole } from './adminConsole';
import { KEY_NAMES, keyName } from './settingsPage';

/** Made-up ports that record what the console asks of them. */
function ports(over: { settings?: Partial<Settings>; importFails?: string } = {}) {
  const store = new UiStore();
  store.set({ panel: 'admin' });
  let now: Settings = { ...structuredClone(DEFAULT_SETTINGS as Settings), ...over.settings };
  const sounds: [ConsoleSound, number | undefined][] = [];
  const calls: string[] = [];
  const settings: SettingsPort = {
    get: () => structuredClone(now),
    set: change => { now = { ...now, ...change }; },
    canChangeDifficulty: () => true,
    adminOpen: () => store.state.panel === 'admin',
    openAdmin: () => { store.set({ panel: 'admin' }); return true; },
    closeAdmin: () => { calls.push('close'); store.set({ panel: 'none' }); },
    sound: (name, level) => { sounds.push([name, level]); },
    gameOver: () => false,
    newGame: async () => {},
    quit: async () => {},
  };
  const saves: SavesPort = {
    gameId: 'demo',
    list: async () => [],
    canSave: () => true,
    save: async () => {},
    load: async () => {},
    exportText: () => { calls.push('export'); return '{"made":"up"}'; },
    importText: async text => {
      if (over.importFails) throw new Error(over.importFails);
      calls.push(`import ${text}`);
    },
  };
  return { store, settings, saves, sounds, calls, now: () => now };
}

const settleUi = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

const mounted: HTMLElement[] = [];
afterEach(() => {
  for (const root of mounted.splice(0)) act(() => render(null, root));
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/** The console, on its SETTINGS page. */
async function settingsPage(p: ReturnType<typeof ports>, opts: { art?: AdminArt } = {}) {
  const root = document.body.appendChild(document.createElement('div'));
  mounted.push(root);
  act(() => render(<AdminConsole settings={p.settings} saves={p.saves} store={p.store} art={opts.art} measure={t => t.length * 8} />, root));
  await settleUi();
  const console = root.querySelector<HTMLElement>('.au-admin-console')!;
  // (the console in the original's pixels: 420 by 478, at the page's top left)
  console.getBoundingClientRect = () => ({ left: 0, top: 0, width: 420, height: 478, right: 420, bottom: 478, x: 0, y: 0, toJSON: () => ({}) });
  await press(root, 'SETTINGS');
  p.sounds.length = 0;
  return root;
}

const named = (root: HTMLElement, name: string) => root.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
async function press(root: HTMLElement, name: string) {
  const b = named(root, name);
  if (!b) throw new Error(`no button "${name}"`);
  act(() => b.click());
  await settleUi();
}
const key = (k: string, target: EventTarget = document.activeElement ?? window) => act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });

describe('SettingsPage', () => {
  it('3D SOUND toggles in the GAME tab, drawn as the other ON/OFF rows', async () => {
    const p = ports();
    const root = await settingsPage(p);
    expect([named(root, '3D SOUND OFF')!.getAttribute('aria-pressed'), named(root, '3D SOUND ON')!.getAttribute('aria-pressed')]).toEqual(['false', 'true']);
    await press(root, '3D SOUND OFF');
    expect([p.now().threeD, p.sounds.map(s => s[0])]).toEqual([false, ['softbop']]);
    expect(named(root, '3D SOUND OFF')!.getAttribute('aria-pressed')).toBe('true');
    await press(root, '3D SOUND ON');
    expect(p.now().threeD).toBe(true);
    // (the row after MOVIES: its name at the left, OFF and ON in the same cells, a row (22 px of 478) lower)
    const names = [...root.querySelectorAll<HTMLElement>('.au-admin-setname')].map(e => e.textContent);
    expect(names.slice(names.indexOf('MOVIES'), names.indexOf('MOVIES') + 2)).toEqual(['MOVIES', '3D SOUND']);
    for (const word of ['OFF', 'ON']) {
      const movies = named(root, `MOVIES ${word}`)!, threeD = named(root, `3D SOUND ${word}`)!;
      expect([threeD.className, threeD.style.left, threeD.style.width, threeD.style.height]).toEqual([movies.className, movies.style.left, movies.style.width, movies.style.height]);
      expect(parseFloat(threeD.style.top) - parseFloat(movies.style.top)).toBeCloseTo((22 / 478) * 100, 6);
    }
    // (not on the other tabs)
    await press(root, 'COMBAT');
    expect(named(root, '3D SOUND ON')).toBeNull();
  });

  it('each control sets its field', async () => {
    const p = ports();
    const root = await settingsPage(p);
    expect(root.querySelector('.au-admin-console')!.getAttribute('data-page')).toBe('settings');
    // GAME is the first tab
    expect(named(root, 'GAME')!.getAttribute('aria-pressed')).toBe('true');
    await press(root, 'ART OFF');
    await press(root, 'HOTSPOT LABELS ON');
    await press(root, 'MOVIES OFF');
    expect([p.now().art, p.now().hotspots, p.now().movies]).toEqual([false, true, false]);
    expect(named(root, 'ART OFF')!.getAttribute('aria-pressed')).toBe('true');
    expect(named(root, 'ART ON')!.getAttribute('aria-pressed')).toBe('false');
    expect(p.sounds.map(s => s[0])).toEqual(['softbop', 'softbop', 'softbop']);
    await press(root, 'ART ON');
    expect(p.now().art).toBe(true);

    p.sounds.length = 0;
    await press(root, 'COMBAT');
    expect(p.sounds).toEqual([['beep7', undefined]]);
    expect(named(root, 'ART ON')).toBeNull();
    await press(root, 'STARS OFF');
    await press(root, 'RESOLUTION 2X');
    await press(root, 'RADAR OFF');
    expect(p.now().combat).toEqual({ stars: false, resolution: 2, radar: false, detail: 'high' });
    // (the detail is the original's cycle box: High, Medium, Low)
    await press(root, 'DETAIL HIGH');
    expect(p.now().combat.detail).toBe('medium');
    await press(root, 'DETAIL MEDIUM');
    await press(root, 'DETAIL LOW');
    expect(p.now().combat.detail).toBe('high');
    await press(root, 'BATTLE SPEED 4X');
    expect(p.now().assists).toEqual({ difficulty: 'game', speed: 4 });
    expect(named(root, 'BATTLE SPEED 4X')!.getAttribute('aria-pressed')).toBe('true');
    // (another field's change keeps the others)
    expect(p.now().art).toBe(true);
  });

  it('the master bar uses the same 27 segments as SOUND LEVELS', async () => {
    const p = ports({ settings: { master: 0.5 } });
    const root = await settingsPage(p);
    const bar = () => root.querySelector<HTMLElement>('[role=slider][aria-label="MASTER"]')!;
    const lit = () => bar().querySelectorAll('[data-seg="on"]').length;
    expect(bar().querySelectorAll('[data-seg]')).toHaveLength(27);
    expect(lit()).toBe(barSegments(0.5));
    // (a click dx along the bar is the sound bar's click dx up from its foot: levelFromBar(243 - dx))
    const left = Number(bar().dataset.left);
    act(() => { bar().dispatchEvent(new PointerEvent('pointerdown', { clientX: left + 100, clientY: 100, button: 0, bubbles: true })); });
    await settleUi();
    expect(p.now().master).toBeCloseTo(levelFromBar(243 - 100));
    expect(p.sounds).toEqual([['beep14', levelFromBar(243 - 100)]]);
    expect(lit()).toBe(barSegments(levelFromBar(243 - 100)));
    // (at its foot: silence)
    act(() => { bar().dispatchEvent(new PointerEvent('pointerdown', { clientX: left + 1, clientY: 100, button: 0, bubbles: true })); });
    await settleUi();
    expect([p.now().master, lit()]).toEqual([0, 0]);
    // the arrow keys step a segment, as the sound bars' do
    bar().focus();
    key('ArrowRight', bar());
    await settleUi();
    key('ArrowRight', bar());
    await settleUi();
    expect([lit(), p.sounds.at(-1)?.[0]]).toEqual([2, 'beep14']);
    key('ArrowLeft', bar());
    await settleUi();
    expect(lit()).toBe(1);
  });

  it("BATTLE DIFFICULTY lists game, ensign, lieutenant, captain, story; game reads 'AS DIFFICULTY'", async () => {
    const p = ports();
    const root = await settingsPage(p);
    await press(root, 'COMBAT');
    p.sounds.length = 0;
    const box = () => root.querySelector<HTMLButtonElement>('button[data-setting="battle difficulty"]')!;
    const seen: [string | null, string][] = [];
    for (let i = 0; i < 5; i++) {
      seen.push([box().getAttribute('aria-label'), p.now().assists.difficulty]);
      act(() => box().click());
      await settleUi();
    }
    expect(seen).toEqual([
      ['BATTLE DIFFICULTY AS DIFFICULTY', 'game'],
      ['BATTLE DIFFICULTY ENSIGN', 'ensign'],
      ['BATTLE DIFFICULTY LIEUTENANT', 'lieutenant'],
      ['BATTLE DIFFICULTY CAPTAIN', 'captain'],
      ['BATTLE DIFFICULTY STORY', 'story'],
    ]);
    // (round again, the speed untouched)
    expect(p.now().assists).toEqual({ difficulty: 'game', speed: 1 });
    expect(p.sounds.map(s => s[0])).toEqual(Array(5).fill('softbop'));
  });

  it('IMPORT reads a file and EXPORT writes one', async () => {
    const p = ports();
    const root = await settingsPage(p);
    const picker = root.querySelector<HTMLInputElement>('input[type=file]')!;
    const opened = vi.spyOn(picker, 'click').mockImplementation(() => {});
    await press(root, 'IMPORT');
    expect(opened).toHaveBeenCalledTimes(1);
    expect(p.sounds).toEqual([['beep7', undefined]]);

    // EXPORT offers the game as a file
    const made = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:made-up');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    let saved: string | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { saved = this.download; });
    await press(root, 'EXPORT');
    expect(p.calls).toContain('export');
    expect(saved).toBe('demo-save.json');
    expect(await (made.mock.calls[0]![0] as Blob).text()).toBe('{"made":"up"}');

    // the picked file is read and loaded, and the console closes
    Object.defineProperty(picker, 'files', { configurable: true, value: [new File(['{"saved":1}'], 'game.json', { type: 'application/json' })] });
    act(() => { picker.dispatchEvent(new Event('change', { bubbles: true })); });
    await settleUi();
    await settleUi();
    expect(p.calls).toEqual(['export', 'import {"saved":1}', 'close']);
  });

  it('says on the strip why an import was refused, and stays up', async () => {
    const p = ports({ importFails: 'Not a save of this game' });
    const root = await settingsPage(p);
    const picker = root.querySelector<HTMLInputElement>('input[type=file]')!;
    Object.defineProperty(picker, 'files', { configurable: true, value: [new File(['x'], 'x.json')] });
    act(() => { picker.dispatchEvent(new Event('change', { bubbles: true })); });
    await settleUi();
    await settleUi();
    expect(root.querySelector('.au-admin-message')!.textContent).toBe('Not a save of this game');
    expect(p.store.state.panel).toBe('admin');
  });

  it('EXPORT is refused as SAVE is, when the game cannot be saved: the reason on the strip, and no file', async () => {
    for (const [refusal, said] of [[undefined, 'The game cannot be saved just now'], ['Not during a battle', 'Not during a battle']] as const) {
      const p = ports();
      p.saves.canSave = () => false;
      if (refusal) p.saves.refusal = () => refusal;
      const root = await settingsPage(p);
      const made = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:made-up');
      await press(root, 'EXPORT');
      expect([p.calls, made.mock.calls.length, p.sounds]).toEqual([[], 0, [['beep7', undefined]]]);
      expect(root.querySelector('.au-admin-message')!.textContent).toBe(said);
      vi.restoreAllMocks();
    }
  });

  it('IMPORT has left the LOAD page for the GAME tab', async () => {
    const p = ports();
    const root = await settingsPage(p);
    await press(root, 'LOAD');
    expect(named(root, 'IMPORT')).toBeNull();
    expect(root.querySelector('input[type=file]')).toBeNull();
  });

  it('LOG opens the conversation log, closing the console', async () => {
    const p = ports();
    const root = await settingsPage(p);
    await press(root, 'LOG');
    expect(p.store.state.panel).toBe('transcript');
  });

  it('KEYS lists every bindable action with its key, in the order of the keys table', async () => {
    const p = ports({ settings: { keys: { ...DEFAULT_KEYS, phasers: 'f' } } });
    const root = await settingsPage(p);
    await press(root, 'KEYS');
    const rows = [...root.querySelectorAll<HTMLButtonElement>('button[data-action]')];
    expect(rows.map(r => r.dataset.action)).toEqual([...BINDABLE_ACTIONS]);
    const phasers = rows.find(r => r.dataset.action === 'phasers')!;
    expect(phasers.getAttribute('aria-label')).toBe('PHASER F');
    expect(rows.find(r => r.dataset.action === 'fireBoth')!.getAttribute('aria-label')).toBe('FIRE BOTH SPACE');
  });

  describe('rebinding', () => {
    const message = (root: HTMLElement) => root.querySelector('.au-admin-message')!.textContent;
    const row = (root: HTMLElement, action: string) => root.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`)!;
    const keysTab = async (p: ReturnType<typeof ports>) => {
      const root = await settingsPage(p);
      await press(root, 'KEYS');
      return root;
    };
    /** A key down at the window, as the browser sends it; whether it was taken. */
    const down = (k: string, o: KeyboardEventInit = {}) => {
      const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o });
      act(() => { (document.activeElement ?? window).dispatchEvent(e); });
      return e.defaultPrevented;
    };

    it('shows a press-a-key state at a row, and takes the next key for it', async () => {
      const p = ports();
      const root = await keysTab(p);
      act(() => row(root, 'phasers').click());
      expect(row(root, 'phasers').getAttribute('aria-label')).toBe('PHASER PRESS A KEY');
      expect(row(root, 'phasers').getAttribute('aria-pressed')).toBe('true');
      expect(message(root)).toBe('Press a key for Phaser');
      expect(down('K')).toBe(true);
      expect(p.now().keys).toEqual({ ...DEFAULT_KEYS, phasers: 'k' });
      expect(row(root, 'phasers').getAttribute('aria-label')).toBe('PHASER K');
      expect(message(root)).not.toMatch(/Press a key/);
      // (the next key is no binding's: the wait is over)
      down('j');
      expect(p.now().keys).toEqual({ ...DEFAULT_KEYS, phasers: 'k' });
    });

    it('refuses a key another action has, and one that is fixed, on the message strip', async () => {
      const p = ports();
      const root = await keysTab(p);
      act(() => row(root, 'phasers').click());
      down('*');
      expect([p.now().keys, message(root)]).toEqual([DEFAULT_KEYS, 'That key is already in use']);
      act(() => row(root, 'phasers').click());
      down('F1');
      expect([p.now().keys, message(root)]).toEqual([DEFAULT_KEYS, 'That key cannot be used']);
      expect(row(root, 'phasers').getAttribute('aria-pressed')).toBe('false');
    });

    it('takes Tab, Enter and Space as keys, and not a modifier alone or a chord', async () => {
      const p = ports();
      const root = await keysTab(p);
      act(() => row(root, 'phasers').click());
      down('Shift');
      down('k', { ctrlKey: true });
      expect(p.now().keys).toEqual(DEFAULT_KEYS);
      expect(row(root, 'phasers').getAttribute('aria-pressed')).toBe('true');
      // (Tab is the next target's now: the action that has it keeps it, and Tab does not move the focus)
      const before = document.activeElement;
      down('Tab');
      expect([p.now().keys, message(root), document.activeElement]).toEqual([DEFAULT_KEYS, 'That key is already in use', before]);
      act(() => row(root, 'nextTarget').click());
      down('Tab');
      expect(p.now().keys).toEqual(DEFAULT_KEYS);
    });

    it('refuses a view key naming its job, and F6 as unusable', async () => {
      const p = ports();
      const root = await keysTab(p);
      act(() => row(root, 'phasers').click());
      down('3');
      expect([p.now().keys, message(root)]).toEqual([DEFAULT_KEYS, 'That key shows view 3']);
      act(() => row(root, 'phasers').click());
      down('F6');
      expect([p.now().keys, message(root)]).toEqual([DEFAULT_KEYS, 'That key cannot be used']);
    });

    it('keeps the keyup of a bound Space from pressing the focused row again', async () => {
      const p = ports({ settings: { keys: { ...DEFAULT_KEYS, fireBoth: 'k' } } });
      const root = await keysTab(p);
      row(root, 'phasers').focus();
      act(() => row(root, 'phasers').click());
      down(' ');
      expect(p.now().keys.phasers).toBe(' ');
      const up = () => {
        const e = new KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true });
        act(() => { document.activeElement!.dispatchEvent(e); });
        return e.defaultPrevented;
      };
      // (the keyup that matches is stopped, and only that one: the wait is not entered again)
      expect([up(), up(), row(root, 'phasers').getAttribute('aria-pressed')]).toEqual([true, false, 'false']);
    });

    it('has Esc give the wait up without closing the console, and the next Esc close it', async () => {
      const p = ports();
      const root = await keysTab(p);
      act(() => row(root, 'phasers').click());
      down('Escape');
      expect([p.calls.includes('close'), p.now().keys, row(root, 'phasers').getAttribute('aria-pressed'), message(root)]).toEqual([false, DEFAULT_KEYS, 'false', expect.not.stringMatching(/Press a key/)]);
      down('Escape');
      expect(p.calls).toContain('close');
    });

    it('keeps the Tab trap while no key is wanted, and gives the wait up as the tab changes', async () => {
      const p = ports();
      const root = await keysTab(p);
      act(() => row(root, 'phasers').click());
      await press(root, 'GAME');
      expect(message(root)).not.toMatch(/Press a key/);
      await press(root, 'KEYS');
      down('k');
      expect(p.now().keys).toEqual(DEFAULT_KEYS);
      const console = root.querySelector('.au-admin-console')!;
      for (let i = 0; i < 30; i++) {
        key('Tab');
        expect(console.contains(document.activeElement)).toBe(true);
      }
    });
  });

  it("names every default key the way the original's options screen does", () => {
    for (const k of Object.values(DEFAULT_KEYS)) expect(KEY_NAMES[k] ?? k.length === 1).toBeTruthy();
    expect([keyName('ArrowUp'), keyName('PageUp'), keyName('+'), keyName('q'), keyName(' ')]).toEqual(['Up', 'PgUp', 'Plus', 'Q', 'Space']);
  });

  it("keeps Tab among the console's controls, the settings' too", async () => {
    const p = ports();
    const root = await settingsPage(p);
    const console = root.querySelector('.au-admin-console')!;
    const visited = new Set<string>();
    for (let i = 0; i < 40; i++) {
      key('Tab');
      expect(console.contains(document.activeElement)).toBe(true);
      visited.add((document.activeElement as HTMLElement).getAttribute('aria-label') ?? '');
    }
    for (const name of ['GAME', 'COMBAT', 'KEYS', 'MASTER', 'ART ON', 'IMPORT', 'EXPORT', 'LOG']) expect(visited).toContain(name);
  });

  it('draws the tab words from the console\'s own pictures, the chosen tab lit', async () => {
    const button = (name: string) => `/admin/${name}.webp`;
    const tabs = { tabGame: '/t/g.webp', tabGameLit: '/t/gl.webp', tabCombat: '/t/c.webp', tabCombatLit: '/t/cl.webp', tabKeys: '/t/k.webp', tabKeysLit: '/t/kl.webp' };
    const art: AdminArt = { scale: 4, frame: i => `/admin/frame${i}.webp`, button, settings: '/admin/settings.webp', settingsLit: '/admin/settingsLit.webp', tabs };
    const p = ports();
    const root = await settingsPage(p, { art });
    // (what shows without the pointer over it: a tab's lit word is also there for the pointer, hidden)
    const srcs = () => [...root.querySelectorAll('img:not(.au-admin-hover)')].map(i => i.getAttribute('src'));
    expect(srcs()).toEqual(expect.arrayContaining(['/t/gl.webp', '/t/c.webp', '/t/k.webp']));
    expect(srcs()).not.toContain('/t/cl.webp');
    // (the page's lit frame, the sound page's, its insides cleared)
    expect(srcs()).toContain('/admin/frame5.webp');
    expect(named(root, 'GAME')!.textContent).toBe('');
    await press(root, 'COMBAT');
    expect(srcs()).toContain('/t/cl.webp');
    expect(srcs()).not.toContain('/t/gl.webp');
  });
});
