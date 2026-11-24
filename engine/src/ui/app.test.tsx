// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObjectDef } from '../content/types';
import type { HeadlessPresenter } from '../sim/presenter';
import { settle } from '../sim/settle';
import { makeWorld } from '../testing/fixture';
import { GameUi } from './app';
import type { Faces, PanelArt, TricorderArt } from './faces';
import { cursorCss } from './cursors';
import { hotspotLabels, resetHotspotLabels } from './hotspotLabels';
import { Input } from './input';
import { UiStore } from './store';
import { DEFAULT_SETTINGS, type Settings } from '../web/settings';
import type { SettingsPort } from '../web/settingsPort';

const panel: ObjectDef = { id: 'panel', name: 'Panel', screen: 'room', at: 'panel' };
const tricorder: ObjectDef = { id: 'tricorder', name: 'Tricorder', screen: null, inventory: true };
const phaser: ObjectDef = { id: 'phaser', name: 'Phaser', screen: null, inventory: true };
const communicator: ObjectDef = {
  id: 'communicator', name: 'Combadge', screen: null,
  on: { use: [{ do: [{ say: { who: 'picard', text: 'Away team here.' } }] }] },
};

const mounted: HTMLElement[] = [];

function setup() {
  const world = makeWorld([panel, tricorder, phaser, communicator], {
    rules: { items: { tricorder: 'tricorder', phaser: 'phaser', communicator: 'communicator' }, lines: {} },
  });
  world.state.awayFlags.combadge = true;
  const store = new UiStore();
  const input = new Input(world, store, { skipLine: () => {} });
  const root = document.body.appendChild(document.createElement('div'));
  act(() => render(<GameUi ui={{ store, input: () => input }} />, root));
  mounted.push(root);
  return { world, store, input, root };
}

function button(root: HTMLElement, name: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find(b => b.textContent === name);
  if (!found) throw new Error(`no button "${name}"`);
  return found;
}

const click = (el: HTMLElement) => act(() => { el.click(); });

/** A made-up settings port that opens and closes the console through the store. */
function consolePort(store: UiStore): SettingsPort {
  return {
    get: () => structuredClone(DEFAULT_SETTINGS as Settings),
    set: () => {},
    canChangeDifficulty: () => true,
    adminOpen: () => store.state.panel === 'admin',
    openAdmin: () => { store.set({ panel: 'admin' }); return true; },
    closeAdmin: () => store.set({ panel: 'none' }),
    sound: () => {},
    gameOver: () => false,
    newGame: async () => {},
    quit: async () => {},
  };
}

// (a plain stand-in: the test runner's own localStorage is not always there)
const memory = new Map<string, string>();
beforeEach(() => {
  memory.clear();
  vi.stubGlobal('localStorage', { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => { memory.set(k, v); }, clear: () => memory.clear() });
});

afterEach(() => {
  // (unmounted, so no earlier HUD is still listening for keys)
  for (const root of mounted.splice(0)) act(() => render(null, root));
  document.body.innerHTML = '';
  resetHotspotLabels();
});

describe('the pointer', () => {
  /** The HUD inside a frame with the game's id, as index.html has it. */
  function framed() {
    const world = makeWorld([panel, tricorder], { rules: { items: { tricorder: 'tricorder' }, lines: {} } });
    const store = new UiStore();
    const input = new Input(world, store, { skipLine: () => {} });
    const frame = document.body.appendChild(document.createElement('div'));
    frame.id = 'game';
    const root = frame.appendChild(document.createElement('div'));
    act(() => render(<GameUi ui={{ store, input: () => input }} />, root));
    mounted.push(root);
    return { frame, root, store, world };
  }

  it('follows the verb on the room, set on the game root only', () => {
    const { frame, root, store } = framed();
    expect(frame.style.getPropertyValue('--au-cursor-room')).toBe(cursorCss('walk'));
    for (const mode of ['look', 'use', 'talk'] as const) {
      act(() => store.set({ mode }));
      expect(frame.style.getPropertyValue('--au-cursor-room')).toBe(cursorCss(mode));
      expect(frame.dataset.mode).toBe(mode);
    }
    expect(new Set(['walk', 'look', 'use', 'talk'].map(m => cursorCss(m as 'walk'))).size).toBe(4);
    expect(frame.style.getPropertyValue('--au-cursor')).toBe(cursorCss('default'));
    expect(frame.style.getPropertyValue('--au-cursor-pointer')).toBe(cursorCss('pointer'));
    expect(document.body.style.cursor).toBe('');
    expect(root.style.cursor).toBe('');
  });

  it('keeps the arrow on the ship, whatever the verb', () => {
    const { frame, store, world } = framed();
    act(() => store.set({ mode: 'talk' }));
    world.state.onShip = { gameOver: null };
    act(() => store.bump());
    expect(frame.style.getPropertyValue('--au-cursor-room')).toBe(cursorCss('default'));
    expect(frame.dataset.mode).toBe('ship');
  });

  it('names a held item beside the pointer, in Use mode only', () => {
    const { root, store } = framed();
    expect(root.querySelector('.au-held')).toBeNull();
    act(() => store.set({ mode: 'use', held: 'tricorder' }));
    expect(root.querySelector('.au-held')?.textContent).toBe('Tricorder');
    act(() => store.set({ mode: 'look', held: null }));
    expect(root.querySelector('.au-held')).toBeNull();
  });
});

describe('GameUi', () => {
  it('switches the verb mode with its buttons', () => {
    const { store, root } = setup();
    click(button(root, 'Look'));
    expect(store.state.mode).toBe('look');
    expect(button(root, 'Look').getAttribute('aria-pressed')).toBe('true');
    expect(button(root, 'Walk').getAttribute('aria-pressed')).toBe('false');
  });

  it('picks up an inventory item to use, and says what a click will do', () => {
    const { store, root } = setup();
    click(button(root, 'Use'));
    click(button(root, 'Tricorder'));
    expect(store.state.held).toBe('tricorder');
    expect(root.querySelector('.au-action')?.textContent).toBe('Use Tricorder with …');
  });

  it('sets the phaser from its control', () => {
    const { world, root } = setup();
    const select = root.querySelector<HTMLSelectElement>('select[aria-label="Phaser setting"]')!;
    act(() => {
      select.value = '2';
      select.dispatchEvent(new Event('change'));
    });
    expect(world.state.phaserSetting).toBe(2);
  });

  it('answers a choice, and a conversation menu, which has no cancel', async () => {
    const { store, root } = setup();
    let picked: unknown = 'none';
    act(() => { void store.ask<0 | 1>({ kind: 'choice', question: 'Go?', options: ['Yes', 'No'] }).then(v => { picked = v; }); });
    expect(root.querySelector('[role=dialog]')?.getAttribute('aria-label')).toBe('Go?');
    click(button(root, 'No'));
    await Promise.resolve();
    expect(picked).toBe(1);
    expect(root.querySelector('[role=dialog]')).toBeNull();
    act(() => { void store.ask<number | null>({ kind: 'menu', options: ['Who goes there?', 'Bye.'] }).then(v => { picked = v; }); });
    expect(root.querySelector('[role=dialog]')?.getAttribute('aria-label')).toBe('Say');
    // (runDialogChoice has no cancel: unity.cpp:1784-1791)
    expect([...root.querySelectorAll('[role=dialog] button')].map(b => b.textContent)).toEqual(['Who goes there?', 'Bye.']);
    click(button(root, 'Bye.'));
    await Promise.resolve();
    expect(picked).toBe(1);
  });

  it('marks a conversation menu with the conversation and situation that ask it, ids only', () => {
    const { store, root } = setup();
    act(() => { void store.ask<number | null>({ kind: 'menu', options: ['A'], conversation: 'ship.c011', situation: 3 }); });
    const dialog = root.querySelector('.au-menu');
    expect(dialog?.getAttribute('data-conversation')).toBe('ship.c011');
    expect(dialog?.getAttribute('data-situation')).toBe('3');
    act(() => { store.answer(0); });
    act(() => { void store.ask<number | null>({ kind: 'menu', options: ['A'] }); });
    expect(root.querySelector('.au-menu')?.hasAttribute('data-conversation')).toBe(false);
  });

  it('selects a team member', () => {
    const { world, root } = setup();
    click(button(root, 'Data'));
    expect(world.state.currentActor).toBe('data');
    expect(button(root, 'Data').getAttribute('aria-pressed')).toBe('true');
  });

  it('asks before hailing the ship from the combadge', async () => {
    const { world, root } = setup();
    click(button(root, 'Combadge'));
    expect(root.querySelector('[role=dialog]')?.getAttribute('aria-label')).toBe('Do you wish to contact the ship?');
    click(button(root, 'Hail'));
    await settle(world);
    expect((world.presenter as HeadlessPresenter).log).toEqual(['say picard: Away team here.']);
  });

  it("shows the combadge disabled while the screen has it off, as the original's panel does", () => {
    const { world, store, root } = setup();
    act(() => {
      world.state.awayFlags.combadge = false;
      store.bump();
    });
    // (the original draws it on the panel whatever the setting, and ignores a click on it: awayteam.cpp:828)
    expect(button(root, 'Combadge').disabled).toBe(true);
    click(button(root, 'Combadge'));
    expect(root.querySelector('[role=dialog]')).toBeNull();
  });

  it('shows the subtitle, and the transcript when asked', () => {
    const { store, root } = setup();
    act(() => store.say({ who: 'data', name: 'Data', text: 'Fascinating.' }));
    expect(root.querySelector('[role=status]')?.textContent).toBe('Data: Fascinating.');
    click(button(root, 'Log'));
    expect(root.querySelector('[role=log]')?.textContent).toContain('Data: Fascinating.');
  });

  it('shows no box for a line said with text off (hidden), and logs it', () => {
    const { store, root } = setup();
    act(() => store.say({ who: 'data', name: 'Data', text: 'Fascinating.' }, false));
    expect(store.state.subtitle).not.toBeNull();
    expect(root.querySelector('.au-subtitle')).toBeNull();
    click(button(root, 'Log'));
    expect(root.querySelector('[role=log]')?.textContent).toContain('Data: Fascinating.');
  });

  it("has Admin on the plain bar, which opens the console (R2: it was Saves), and L toggles the log", () => {
    const { store, input, root } = setup();
    expect([...root.querySelectorAll('.au-bar button')].some(b => b.textContent === 'Saves')).toBe(false);
    act(() => render(<GameUi ui={{ store, input: () => input, settings: consolePort(store) }} />, root));
    click(button(root, 'Admin'));
    expect(store.state.panel).toBe('admin');
    // (the console's own pictures are absent: its CSS stand-ins, with every control)
    for (const name of ['LOAD', 'NEW', 'QUIT', 'SOUND LEVELS', 'TEXT ON', 'DIFFICULTY LIEUTENANT', 'SETTINGS', 'RESUME']) {
      expect([name, root.querySelector(`button[aria-label="${name}"]`) !== null]).toEqual([name, true]);
    }
    click(root.querySelector<HTMLButtonElement>('button[aria-label="RESUME"]')!);
    expect(store.state.panel).toBe('none');
    expect([input.key('L'), store.state.panel]).toEqual([true, 'transcript']);
  });

  it('shows a message until it is dismissed', () => {
    const { store, root } = setup();
    act(() => store.set({ message: 'The away team is back aboard the ship.' }));
    expect(root.querySelector('[role=alert]')?.textContent).toContain('back aboard');
    click(button(root, 'OK'));
    expect(root.querySelector('[role=alert]')).toBeNull();
  });

  describe('controls', () => {
    const disabledOf = (root: HTMLElement) =>
      [...root.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('.au-bar button, .au-bar select')]
        .filter(el => el.textContent !== 'Log' && el.textContent !== 'Hotspots').map(el => el.disabled);

    it('are enabled when idle', () => {
      const { root } = setup();
      expect(disabledOf(root).length).toBeGreaterThan(5);
      expect(disabledOf(root).every(d => !d)).toBe(true);
    });

    it('are disabled while a dialog is up, and the bar is inert', () => {
      const { store, root } = setup();
      act(() => { void store.ask<void>({ kind: 'tricorder', reading: 1, pages: [], index: 0 }); });
      expect(disabledOf(root).every(d => d)).toBe(true);
      expect(root.querySelector('.au-bar')?.hasAttribute('inert')).toBe(true);
      act(() => store.answer(undefined));
      expect(root.querySelector('.au-bar')?.hasAttribute('inert')).toBe(false);
      expect(disabledOf(root).every(d => !d)).toBe(true);
    });

    it('are disabled while input is blocked', () => {
      const { world, store, root } = setup();
      world.state.awayFlags.inputBlocked = true;
      act(() => store.bump());
      expect(disabledOf(root).every(d => d)).toBe(true);
    });
  });

  describe('dialogs', () => {
    const escape = () => act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });

    it('are modal and focus their first button', () => {
      const { store, root } = setup();
      act(() => { void store.ask<number>({ kind: 'choice', question: 'Go?', options: ['Yes', 'No'] }); });
      expect(root.querySelector('[role=dialog]')?.getAttribute('aria-modal')).toBe('true');
      expect(document.activeElement).toBe(button(root, 'Yes'));
    });

    it('pages through the tricorder\'s readings, and falls back to the reading\'s number without any', () => {
      const { store, root } = setup();
      const pages = [{ title: '-A-', heading: '-a-', text: '-Zap-' }, { title: '-B-', heading: '-b-', text: '-Zip-' }];
      act(() => { void store.ask<void>({ kind: 'tricorder', reading: 2, pages, index: 1 }); });
      expect(root.textContent).toContain('-B-');
      expect(root.textContent).toContain('2 of 2');
      act(() => button(root, 'Previous').click());
      expect(root.textContent).toContain('-Zap-');
      act(() => button(root, 'Close').click());
      expect(store.state.dialog).toBeNull();
      act(() => { void store.ask<void>({ kind: 'tricorder', reading: 5, pages: [], index: 0 }); });
      expect(root.textContent).toContain('Tricorder reading 5');
    });

    it('focuses an enabled button in the tricorder on the first page, with several pages or one, and keeps it after paging to an end', () => {
      const { store, root } = setup();
      const pages = [{ title: '-A-', heading: '-a-', text: '-Zap-' }, { title: '-B-', heading: '-b-', text: '-Zip-' }];
      act(() => { void store.ask<void>({ kind: 'tricorder', reading: 1, pages, index: 0 }); });
      expect(document.activeElement).toBe(button(root, 'Next'));
      act(() => button(root, 'Next').click());
      expect(document.activeElement).toBe(button(root, 'Close'));
      act(() => button(root, 'Close').click());
      act(() => { void store.ask<void>({ kind: 'tricorder', reading: 1, pages: pages.slice(0, 1), index: 0 }); });
      expect(root.textContent).toContain('1 of 1');
      expect(document.activeElement).toBe(button(root, 'Close'));
    });

    it('are dismissed by Escape: the tricorder, and the combadge prompt as Ignore', async () => {
      const { store, root } = setup();
      let done = false;
      act(() => { void store.ask<void>({ kind: 'tricorder', reading: 1, pages: [], index: 0 }).then(() => { done = true; }); });
      escape();
      await Promise.resolve();
      expect(done).toBe(true);
      let picked: unknown = null;
      act(() => { void store.ask<number>({ kind: 'prompt', text: 'Hail?', buttons: ['Hail', 'Ignore'] }).then(v => { picked = v; }); });
      escape();
      await Promise.resolve();
      expect(picked).toBe(1);
      expect(root.querySelector('[role=dialog]')).toBeNull();
    });

    it('give focus back to what had it when they close', () => {
      const { store, root } = setup();
      const look = button(root, 'Look');
      look.focus();
      act(() => { void store.ask<number>({ kind: 'choice', question: 'Go?', options: ['Yes', 'No'] }); });
      expect(document.activeElement).toBe(button(root, 'Yes'));
      click(button(root, 'No'));
      expect(root.querySelector('[role=dialog]')).toBeNull();
      expect(document.activeElement).toBe(look);
    });

    it('leave a conversation menu up on Escape, as the original has no cancel', () => {
      const { store, root } = setup();
      act(() => { void store.ask<number | null>({ kind: 'menu', options: ['Bye.'] }); });
      escape();
      expect(root.querySelector('[role=dialog]')).not.toBeNull();
    });
  });

  it('keeps the transcript log in the page, hidden until the Log panel is opened', () => {
    const { store, root } = setup();
    act(() => store.say({ who: 'data', name: 'Data', text: 'Fascinating.' }));
    const log = root.querySelector('[role=log]')!;
    expect(log.textContent).toContain('Fascinating.');
    expect(log.classList.contains('au-transcript-closed')).toBe(true);
    click(button(root, 'Log'));
    expect(root.querySelector('[role=log]')?.classList.contains('au-transcript-closed')).toBe(false);
  });

  describe('the movie dialog', () => {
    const film = { kind: 'movie', title: 'intro', url: '/movies/intro.webm' } as const;

    function play() {
      const { store, root } = setup();
      let answered = false;
      act(() => { void store.ask<void>(film).then(() => { answered = true; }); });
      const video = root.querySelector('video')!;
      return { store, root, video, answered: async () => { await Promise.resolve(); return answered; } };
    }

    it('answers the scene when the film ends', async () => {
      const { store, video, answered } = play();
      expect(await answered()).toBe(false);
      act(() => { video.dispatchEvent(new Event('ended')); });
      expect(await answered()).toBe(true);
      expect(store.state.dialog).toBeNull();
    });

    it('answers the scene when the film fails to load or play, so a broken film cannot hang it', async () => {
      const { store, video, answered } = play();
      act(() => { video.dispatchEvent(new Event('error')); });
      expect(await answered()).toBe(true);
      expect(store.state.dialog).toBeNull();
    });

    it('answers the scene when it is skipped', async () => {
      const { root, answered } = play();
      click(button(root, 'Skip'));
      expect(await answered()).toBe(true);
    });

    it('answers the scene when the film is clicked', async () => {
      const { video, answered } = play();
      click(video);
      expect(await answered()).toBe(true);
    });

    it('shows the title card, with no film, until it is answered', () => {
      const { store, root } = setup();
      act(() => { void store.ask<void>({ kind: 'movie', title: 'lost', url: null }); });
      expect(root.querySelector('video')).toBeNull();
      expect(root.querySelector('.au-movie-card')?.textContent).toBe('lost');
    });
  });
});

describe('the hotspot labels toggle', () => {
  it('is off to begin with, flips with the Hotspots button and the H key, and is remembered in the settings record', () => {
    const { root } = setup();
    expect(hotspotLabels()).toBe(false);
    expect(button(root, 'Hotspots').getAttribute('aria-pressed')).toBe('false');
    click(button(root, 'Hotspots'));
    expect(hotspotLabels()).toBe(true);
    expect(button(root, 'Hotspots').getAttribute('aria-pressed')).toBe('true');
    expect(JSON.parse(localStorage.getItem('au.settings')!)).toMatchObject({ hotspots: true });
    act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true })); });
    expect(hotspotLabels()).toBe(false);
    expect(JSON.parse(localStorage.getItem('au.settings')!)).toMatchObject({ hotspots: false });
    // (a modifier, or typing in a field, does not toggle it)
    act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', ctrlKey: true, bubbles: true })); });
    expect(hotspotLabels()).toBe(false);
    resetHotspotLabels();
    localStorage.setItem('au.settings', JSON.stringify({ hotspots: true }));
    expect(hotspotLabels()).toBe(true);
  });

  it('still works when storage throws', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    try {
      resetHotspotLabels();
      expect(hotspotLabels()).toBe(false);
      const { root } = setup();
      click(button(root, 'Hotspots'));
      expect(hotspotLabels()).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('portraits and icons', () => {
  const faces: Faces = {
    portrait: id => (id === 'data' ? '/p/data.webp' : undefined),
    icon: id => (id === 'phaser' ? '/i/phaser.webp' : id === 'communicator' ? '/i/badge.webp' : undefined),
    combadge: () => '/i/badge.webp',
    speaker: who => (who === 'data' ? { url: '/p/data.webp', placeholder: false } : { url: '/i/badge.webp', placeholder: true }),
    panel: () => undefined, astro: () => undefined, astroMap: () => undefined, astroTables: () => undefined, transporter: () => undefined, sensor: () => undefined, cursors: () => undefined, tricorder: () => undefined,
  };
  function withFaces(f: Faces | undefined) {
    const world = makeWorld([panel, tricorder, phaser, communicator], { rules: { items: { tricorder: 'tricorder', phaser: 'phaser', communicator: 'communicator' }, lines: {} } });
    world.state.awayFlags.combadge = true;
    const store = new UiStore();
    const input = new Input(world, store, { skipLine: () => {} });
    const root = document.body.appendChild(document.createElement('div'));
    act(() => render(<GameUi ui={{ store, input: () => input, faces: () => f }} />, root));
    mounted.push(root);
    return { world, store, input, root };
  }
  const named = (root: HTMLElement, name: string) => root.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);

  it('shows a crew member as their portrait, named by aria-label and title, and keeps the text for one without', () => {
    const { world, root } = withFaces(faces);
    const data = named(root, 'Data')!;
    expect(data.querySelector('img')?.getAttribute('src')).toBe('/p/data.webp');
    expect(data.title).toBe('Data');
    expect(data.textContent).toBe('');
    expect(button(root, 'Picard')).toBeTruthy();
    click(data);
    expect(world.state.currentActor).toBe('data');
    expect(data.getAttribute('aria-pressed')).toBe('true');
  });

  it('shows the inventory item as its icon, with the phaser setting beside it, and the rest as text', () => {
    const { root } = withFaces(faces);
    const ph = named(root, 'Phaser')!;
    expect(ph.querySelector('img')?.getAttribute('src')).toBe('/i/phaser.webp');
    expect(ph.parentElement?.querySelector('select[aria-label="Phaser setting"]')).toBeTruthy();
    click(ph);
    expect(ph.getAttribute('aria-pressed')).toBe('true');
    expect(button(root, 'Tricorder')).toBeTruthy();
  });

  it('shows the combadge as the communicator icon, still named Combadge', () => {
    const { root } = withFaces(faces);
    const badge = root.querySelector<HTMLButtonElement>('button.au-combadge')!;
    expect(badge.querySelector('img')?.getAttribute('src')).toBe('/i/badge.webp');
    expect(badge.getAttribute('aria-label')).toBe('Combadge');
  });

  it("shows a speaker's portrait beside the line, and the combadge as a placeholder for anyone else", () => {
    const { store, root } = withFaces(faces);
    act(() => store.say({ who: 'data', name: 'Data', text: 'Fascinating.' }));
    const img = root.querySelector('.au-subtitle img')!;
    expect(img.getAttribute('src')).toBe('/p/data.webp');
    expect(img.hasAttribute('data-placeholder')).toBe(false);
    expect(root.querySelector('[role=status]')?.textContent).toBe('Data: Fascinating.');
    act(() => store.say({ who: 'computer_voice', name: 'Computer', text: 'Working.' }));
    const badge = root.querySelector('.au-subtitle img')!;
    expect(badge.getAttribute('src')).toBe('/i/badge.webp');
    expect(badge.hasAttribute('data-placeholder')).toBe(true);
    expect(root.querySelector('[role=status]')?.textContent).toBe('Computer: Working.');
  });

  it('keeps the text buttons and a plain subtitle with no faces (art off)', () => {
    const { store, root } = withFaces(undefined);
    expect(root.querySelector('img')).toBeNull();
    expect(button(root, 'Data')).toBeTruthy();
    expect(button(root, 'Combadge')).toBeTruthy();
    act(() => store.say({ who: 'data', name: 'Data', text: 'Fascinating.' }));
    expect(root.querySelector('.au-subtitle img')).toBeNull();
  });
});

describe('the tricorder viewer on the original\'s frame (art.tricorder)', () => {
  const art: TricorderArt = { scale: 4, sprite: name => `/tric/${name}.webp` };
  const faces: Faces = {
    portrait: () => undefined, icon: () => undefined, combadge: () => undefined, speaker: () => undefined,
    panel: () => undefined, astro: () => undefined, astroMap: () => undefined, astroTables: () => undefined, transporter: () => undefined, sensor: () => undefined, cursors: () => undefined,
    tricorder: () => art,
  };
  function open(f: Faces) {
    const world = makeWorld([panel, tricorder], { rules: { items: { tricorder: 'tricorder' }, lines: {} } });
    const store = new UiStore();
    const input = new Input(world, store, { skipLine: () => {} });
    const root = document.body.appendChild(document.createElement('div'));
    act(() => render(<GameUi ui={{ store, input: () => input, faces: () => f }} />, root));
    mounted.push(root);
    return { store, root };
  }
  const pages = [{ title: '-A-', heading: '-a-', text: '-Zap-' }, { title: '-B-', heading: '-b-', text: '-Zip-' }];

  it('draws the frame, the readout on its screen and the readings\' numbers in its boxes, and the buttons keep their names', () => {
    const { store, root } = open(faces);
    act(() => { void store.ask<void>({ kind: 'tricorder', reading: 2, pages, index: 1 }); });
    const dialog = root.querySelector('[role=dialog]')!;
    expect(dialog.classList.contains('au-tricorder-art')).toBe(true);
    expect(dialog.querySelector('img.au-tricorder-frame')?.getAttribute('src')).toBe('/tric/frame.webp');
    // (the screen is at 121, 97 of the 410 by 478 picture, 223 by 191)
    const screen = dialog.querySelector<HTMLElement>('.au-tricorder-screen')!;
    expect(screen.style.cssText).toContain('left: 29.512195');
    expect(screen.style.cssText).toContain('top: 20.29288');
    expect(screen.textContent).toContain('-B-');
    expect(screen.textContent).toContain('-Zip-');
    // (page 0 of 0 and reading 1 of 1: the original counts from 0)
    expect([...dialog.querySelectorAll('.au-tricorder-number')].map(n => n.textContent)).toEqual(['0', '0', '1', '1']);
    // (the page buttons are the greyed pictures the original draws with one page)
    expect(dialog.querySelector('img[src="/tric/page_up_off.webp"]')).not.toBeNull();
    // (the previous button is live and lit under the pointer; next is at the end and greyed)
    expect(named(root, 'Previous')!.querySelector('img')?.getAttribute('src')).toBe('/tric/prev_hover.webp');
    expect(named(root, 'Next')!.disabled).toBe(true);
    expect(named(root, 'Next')!.querySelector('img')?.getAttribute('src')).toBe('/tric/next_off.webp');
    act(() => named(root, 'Previous')!.click());
    expect(screen.textContent).toContain('-Zap-');
    expect([...dialog.querySelectorAll('.au-tricorder-number')].map(n => n.textContent)).toEqual(['0', '0', '0', '1']);
    act(() => named(root, 'Close')!.click());
    expect(store.state.dialog).toBeNull();
  });

  it('is the plain dialog without the frame published (art off or not made)', () => {
    const { store, root } = open({ ...faces, tricorder: () => undefined });
    act(() => { void store.ask<void>({ kind: 'tricorder', reading: 2, pages, index: 1 }); });
    expect(root.querySelector('.au-tricorder-art')).toBeNull();
    expect(root.textContent).toContain('2 of 2');
  });
  const named = (root: HTMLElement, name: string) => root.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
});

describe('the original\'s panel (art.panel)', () => {
  const art: PanelArt = { sprite: name => `/panel/${name}.webp`, colours: { status: '#000000', separator: '#000000', empty: '#404040', healthy: '#00904c', injured: '#a41c1c', injuredEdge: '#781414' } };
  const faces: Faces = {
    portrait: id => `/p/${id}.webp`,
    icon: id => (id === 'phaser' ? '/i/phaser.webp' : undefined),
    combadge: () => '/i/badge.webp',
    speaker: () => undefined,
    panel: () => art, astro: () => undefined, astroMap: () => undefined, astroTables: () => undefined, transporter: () => undefined, sensor: () => undefined, cursors: () => undefined, tricorder: () => undefined,
  };
  const extra: ObjectDef[] = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id: `item_${id}`, name: `Item ${id.toUpperCase()}`, screen: null, inventory: true }));
  function withPanel(objects: ObjectDef[] = []) {
    const world = makeWorld([panel, tricorder, phaser, communicator, ...objects], { rules: { items: { tricorder: 'tricorder', phaser: 'phaser', communicator: 'communicator' }, lines: {} } });
    world.state.awayFlags.combadge = true;
    const store = new UiStore();
    const input = new Input(world, store, { skipLine: () => {} });
    const root = document.body.appendChild(document.createElement('div'));
    act(() => render(<GameUi ui={{ store, input: () => input, faces: () => faces, saves: undefined }} />, root));
    mounted.push(root);
    return { world, store, input, root };
  }
  const named = (root: HTMLElement, name: string) => root.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);

  it('replaces the bar with the panel picture and puts the verbs over it, the selected one lit', () => {
    const { root, store } = withPanel();
    expect(root.querySelector('.au-bar')).toBeNull();
    expect(root.querySelector('.au-action')).toBeNull();
    expect(root.querySelector<HTMLImageElement>('.au-awaypanel > img')?.getAttribute('src')).toBe('/panel/panel.webp');
    click(named(root, 'Look')!);
    expect(store.state.mode).toBe('look');
    expect(named(root, 'Look')!.getAttribute('aria-pressed')).toBe('true');
    expect(named(root, 'Look')!.querySelector('img')?.getAttribute('src')).toBe('/panel/look_on.webp');
    expect(named(root, 'Use')!.querySelector('img')?.getAttribute('src')).toBe('/panel/use.webp');
    expect(named(root, 'Look')!.style.left).toBe('16.875%');
    // the status line has the action line
    expect(root.querySelector('.au-status')?.textContent).toMatch(/^Look/);
  });

  it('shows the current member in the black box, and a click there moves to the next', () => {
    const { root, world } = withPanel();
    const box = () => root.querySelector<HTMLButtonElement>('.au-member')!;
    expect(box().dataset.member).toBe('picard');
    expect(box().getAttribute('aria-label')).toBe('Picard: next team member');
    expect(box().querySelector('img')?.getAttribute('src')).toBe('/p/picard.webp');
    click(box());
    expect(world.state.currentActor).toBe('data');
    expect(box().dataset.member).toBe('data');
    click(box());
    expect(world.state.currentActor).toBe('picard');
  });

  it('a refused Admin press keeps the held item', () => {
    const { root, store, input } = withPanel();
    const settings = { ...consolePort(store), openAdmin: () => false };
    act(() => render(<GameUi ui={{ store, input: () => input, faces: () => faces, settings }} />, root));
    input.setMode('use');
    input.clickItem('tricorder');
    click(named(root, 'Admin')!);
    expect([store.state.panel, store.state.held]).toEqual(['none', 'tricorder']);
  });

  it("opens the admin console from its admin button, as the original's panel does (R2), dropping the held item", () => {
    const { root, store, input } = withPanel();
    // (no settings port: nothing to open)
    expect(named(root, 'Admin')!.disabled).toBe(true);
    const settings = consolePort(store);
    act(() => render(<GameUi ui={{ store, input: () => input, faces: () => faces, settings }} />, root));
    input.setMode('use');
    input.clickItem('tricorder');
    click(named(root, 'Admin')!);
    expect([store.state.panel, store.state.held]).toEqual(['admin', null]);
    expect(root.querySelector('[role=dialog][aria-label="Admin console"]')).toBeTruthy();
    expect(root.querySelector('.au-options')).toBeNull();
  });

  it('pages the inventory one item at a time when there are more than six', () => {
    const { root } = withPanel(extra);
    const shown = () => [...root.querySelectorAll<HTMLButtonElement>('.au-strip button[data-item]')].map(b => b.dataset.item);
    expect(shown()).toHaveLength(6);
    const first = shown()[0];
    expect(named(root, 'Previous items')!.disabled).toBe(true);
    click(named(root, 'More items')!);
    expect(shown()[0]).not.toBe(first);
    expect(named(root, 'More items')!.disabled).toBe(true);
    click(named(root, 'Previous items')!);
    expect(shown()[0]).toBe(first);
    expect(root.querySelector('[data-drop="inventory"]')).toBeTruthy();
  });

  it('sets the phaser from the power bar as a slider, and covers the bar without a phaser', () => {
    const { root, world } = withPanel();
    const slider = root.querySelector<HTMLElement>('[role=slider][aria-label="Phaser setting"]')!;
    expect(slider.getAttribute('aria-valuenow')).toBe(String(world.state.phaserSetting));
    act(() => { slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })); });
    expect(world.state.phaserSetting).toBe(3);
    expect(slider.getAttribute('aria-valuetext')).toBe('High');
    act(() => { slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); });
    expect(world.state.phaserSetting).toBe(2);
    act(() => { world.state.objects.phaser!.active = false; });
    click(named(root, 'Look')!);
    expect(root.querySelector('[role=slider]')).toBeNull();
    expect(root.querySelector('img[src="/panel/no_phaser.webp"]')).toBeTruthy();
  });

  it('has the combadge over its picture', () => {
    const { root } = withPanel();
    expect(named(root, 'Combadge')!.disabled).toBe(false);
  });
});
