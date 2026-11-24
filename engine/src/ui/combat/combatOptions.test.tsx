// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CombatCommand } from '../../sim/combat/commands';
import { SIM_SEAMS } from '../../sim/combat/seams';
import { miniBattle, miniBattleContext, miniEnterpriseUnits } from '../../testing/combat';
import { miniConsoleArt } from '../../testing/console';
import { DEFAULT_KEYS } from '../../view/combat/bindings';
import { newRadarMemory } from '../../view/combat/files';
import type { BattlePort, BattleView } from '../../web/battlePort';
import { DEFAULT_SETTINGS, type Settings } from '../../web/settings';
import type { ConsoleSound, SettingsPort } from '../../web/settingsPort';
import { AdminConsole } from '../admin/adminConsole';
import { areaStyle } from '../ship/areas';
import { UiStore } from '../store';
import { CombatOptions } from './combatOptions';
import { CombatConsole } from './console';

/** A settings record the screens share, as the session's one record; and the console's sounds. */
function settingsPort(over: Partial<Settings> = {}) {
  const store = new UiStore();
  let now: Settings = { ...structuredClone(DEFAULT_SETTINGS as Settings), ...over };
  const sounds: ConsoleSound[] = [];
  const settings: SettingsPort = {
    get: () => structuredClone(now),
    set: change => { now = { ...now, ...change }; },
    canChangeDifficulty: () => true,
    adminOpen: () => store.state.panel === 'admin',
    openAdmin: () => { store.set({ panel: 'admin' }); return true; },
    closeAdmin: () => { store.set({ panel: 'none' }); },
    sound: name => { sounds.push(name); },
    gameOver: () => false,
    newGame: async () => {},
    quit: async () => {},
  };
  return { store, settings, sounds, now: () => now };
}

/**
 * A made-up battle port over miniCombat's battle 3, as the session's: showOptions pauses the battle and makes the screen the battle's dialog,
 * then gives back the pause it had (session.ts); it records the orders, and where the preview is asked to be drawn.
 */
function fakePort() {
  const { ctx, b } = miniBattle({ ctx: miniBattleContext({ ...SIM_SEAMS }) });
  const orders: CombatCommand[] = [];
  const shown: boolean[] = [];
  const s = settingsPort();
  let previewBox: (() => DOMRect | null) | null = null;
  let held: boolean | null = null;
  const view: BattleView = { b, combat: ctx.combat, enterpriseUnits: miniEnterpriseUnits(), paused: false, redFlash: false, resolved: null, resolving: false, page: 'conn', warp: false, queued: [], overlay: null };
  const port: BattlePort = {
    battle: () => view, command: cmd => { orders.push(cmd); }, pause: on => { view.paused = on; }, autoResolve: async () => {}, finish: async () => {},
    assists: () => ({ difficulty: 'game', speed: 1 }), setAssists: () => {}, keys: () => s.now().keys,
    page: () => {}, consoleArt: () => miniConsoleArt(), flash: () => 0, viewBox: () => {}, hudBoxes: () => {}, logShown: () => {},
    beep: () => {}, radar: newRadarMemory, chunk: () => null, pick: () => null,
    optionsScreen: () => ({ settings: s.settings, picture: '/art/admin/final.webp', fonts: null }),
    showOptions: open => {
      shown.push(open);
      if (open && held === null) {
        held = view.paused;
        view.paused = true;
        view.overlay = 'dialog';
      } else if (!open && held !== null) {
        view.paused = held;
        view.overlay = null;
        held = null;
      }
    },
    previewBox: box => { previewBox = box; },
  };
  return { port, view, orders, shown, s, preview: () => previewBox };
}

const roots: HTMLElement[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => render(null, root));
    root.remove();
  }
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});
function mount(el: preact.JSX.Element): HTMLElement {
  const root = document.body.appendChild(document.createElement('div'));
  roots.push(root);
  act(() => render(el, root));
  return root;
}
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const key = async (k: string, target: EventTarget = document.activeElement ?? window) => {
  act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k, bubbles: true, cancelable: true })); });
  act(() => { target.dispatchEvent(new KeyboardEvent('keyup', { key: k, code: k, bubbles: true, cancelable: true })); });
  await settle();
};
const named = (root: ParentNode, name: string) => root.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
async function press(root: ParentNode, name: string) {
  const b = named(root, name);
  if (!b) throw new Error(`no button "${name}"`);
  act(() => b.click());
  await settle();
}
const dialog = (root: ParentNode) => root.querySelector('[role="dialog"][aria-label="Combat Options"]');

describe('Tactical\'s F1: the Combat Options (Plan 32 Task 11)', () => {
  it('F1 opens it and pauses the battle; F1 or Esc closes and restores', async () => {
    const f = fakePort();
    const root = mount(<CombatConsole port={f.port} pads={() => []} keyboardFocus={() => false} />);
    expect(dialog(root)).toBeNull();
    await key('F1', window);
    expect(dialog(root)).not.toBeNull();
    expect([f.shown, f.view.paused, f.view.overlay]).toEqual([[true], true, 'dialog']);
    // (the battle takes no key while it is up: no order, no pause)
    await key('ArrowUp');
    await key('p');
    expect(f.orders).toEqual([]);
    await key('F1');
    expect(dialog(root)).toBeNull();
    expect([f.shown.at(-1), f.view.paused, f.view.overlay]).toEqual([false, false, null]);
    // (Esc too; and a battle paused before it opened stays paused)
    f.view.paused = true;
    await key('F1', window);
    expect(dialog(root)).not.toBeNull();
    await key('Escape');
    expect(dialog(root)).toBeNull();
    expect([f.view.paused, f.view.overlay]).toEqual([true, null]);
    // (and Escape, the screen gone, is the assists panel's again)
    f.view.paused = false;
    await key('Escape', window);
    expect(root.querySelector('.au-assists')).not.toBeNull();
  });

  it('its values are the PADD\'s: a change here shows on the SETTINGS COMBAT tab', async () => {
    const s = settingsPort();
    const options = mount(<CombatOptions settings={s.settings} fonts={null} preview={() => {}} onClose={() => {}} />);
    await press(options, 'STARS OFF');
    await press(options, 'RESOLUTION 2X');
    await press(options, 'RADAR OFF');
    await press(options, 'DETAIL HIGH');
    expect(s.now().combat).toEqual({ stars: false, resolution: 2, radar: false, detail: 'medium' });
    expect(named(options, 'STARS OFF')!.getAttribute('aria-pressed')).toBe('true');
    act(() => render(null, options));
    s.store.set({ panel: 'admin' });
    const admin = mount(<AdminConsole settings={s.settings} store={s.store} measure={t => t.length * 8} />);
    await settle();
    await press(admin, 'SETTINGS');
    await press(admin, 'COMBAT');
    for (const name of ['STARS OFF', 'RESOLUTION 2X', 'RADAR OFF']) expect(named(admin, name)!.getAttribute('aria-pressed')).toBe('true');
    expect(named(admin, 'DETAIL MEDIUM')).not.toBeNull();
    // (and the console's change shows here)
    await press(admin, 'STARS ON');
    act(() => render(null, admin));
    const again = mount(<CombatOptions settings={s.settings} fonts={null} preview={() => {}} onClose={() => {}} />);
    expect(named(again, 'STARS ON')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('CANCEL puts back what it opened with and closes; USE closes keeping them; DEFAULT gives the original\'s', async () => {
    const s = settingsPort({ combat: { stars: true, resolution: 1, radar: true, detail: 'low' } });
    let closed = 0;
    const root = mount(<CombatOptions settings={s.settings} fonts={null} preview={() => {}} onClose={() => { closed++; }} />);
    await press(root, 'STARS OFF');
    await press(root, 'CANCEL');
    expect([s.now().combat.stars, closed]).toEqual([true, 1]);
    await press(root, 'RADAR OFF');
    await press(root, 'USE');
    expect([s.now().combat.radar, closed]).toEqual([false, 2]);
    s.settings.set({ keys: { ...DEFAULT_KEYS, phasers: 'k' } });
    await press(root, 'DEFAULT');
    expect([s.now().combat, s.now().keys, closed]).toEqual([DEFAULT_SETTINGS.combat, DEFAULT_KEYS, 2]);
  });

  it('lists the original\'s sixteen keys and rebinds them as the KEYS tab does: Esc gives the wait up, a used key is refused', async () => {
    const s = settingsPort();
    let closed = 0;
    const root = mount(<CombatOptions settings={s.settings} fonts={null} preview={() => {}} onClose={() => { closed++; }} />);
    const rows = [...root.querySelectorAll('[data-action]')].map(el => el.getAttribute('data-action'));
    // (named as final.spr prints them: the Up key's row is Pitch Up)
    expect([named(root, 'PITCH UP UP') !== null, named(root, 'PITCH DOWN DOWN') !== null]).toEqual([true, true]);
    expect(rows).toEqual(['pitchDown', 'pitchUp', 'rollLeft', 'rollRight', 'yawLeft', 'yawRight', 'accelerate', 'decelerate', 'stop', 'phasers', 'torpedoes', 'toggleView', 'cycleCamera', 'nextTarget', 'zoomIn', 'zoomOut']);
    await press(root, 'PHASER SLASH');
    expect(named(root, 'PHASER PRESS A KEY')).not.toBeNull();
    await key('Escape');
    expect([closed, s.now().keys.phasers, named(root, 'PHASER SLASH') !== null]).toEqual([0, '/', true]);
    await press(root, 'PHASER SLASH');
    await key('Tab');
    expect(root.textContent).toContain('That key is already in use');
    expect(s.now().keys.phasers).toBe('/');
    await press(root, 'PHASER SLASH');
    await key('k');
    expect([s.now().keys.phasers, named(root, 'PHASER K') !== null, closed]).toEqual(['k', true, 0]);
  });

  it('keeps the keyboard: Tab goes round its own controls, and what is behind it is inert', async () => {
    const s = settingsPort();
    const behind = document.body.appendChild(document.createElement('button'));
    const root = mount(<CombatOptions settings={s.settings} fonts={null} preview={() => {}} onClose={() => {}} />);
    expect(behind.hasAttribute('inert')).toBe(true);
    const box = dialog(root)!;
    expect(box.contains(document.activeElement)).toBe(true);
    for (let i = 0; i < 30; i++) {
      await key('Tab');
      expect(box.contains(document.activeElement)).toBe(true);
    }
    act(() => render(null, root));
    expect(behind.hasAttribute('inert')).toBe(false);
  });

  it('draws final.spr\'s picture with the preview\'s window left open, and hands the session the window\'s place; without the picture, CSS at the same places', async () => {
    const s = settingsPort();
    let box: (() => DOMRect | null) | null | undefined;
    const root = mount(<CombatOptions settings={s.settings} picture="/art/admin/final.webp" fonts={null} preview={b => { box = b; }} onClose={() => {}} />);
    expect(root.querySelector('.au-options')!.getAttribute('data-art')).toBe('picture');
    expect(root.querySelector('img.au-options-picture, canvas.au-options-picture')).not.toBeNull();
    const hole = root.querySelector<HTMLElement>('.au-options-preview')!;
    expect(hole.style.left).toBe(areaStyle([399, 128, 149, 142]).left);
    expect(typeof box).toBe('function');
    act(() => render(null, root));
    expect(box).toBeNull();
    const plain = mount(<CombatOptions settings={s.settings} fonts={null} preview={() => {}} onClose={() => {}} />);
    expect(plain.querySelector('.au-options')!.getAttribute('data-art')).toBeNull();
    expect(named(plain, 'STARS ON')).not.toBeNull();
  });
});
