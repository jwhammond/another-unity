// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShipContent } from '../../content/types';
import { newSystems, UNIT_FUSION, UNIT_POWER_GRID, UNIT_TORPEDO, UNIT_WARP } from '../../sim/shipSystems';
import { PACK_ENTRIES } from '../../view/engineeringLayout';
import { BitmapFont, Palette } from '../../view/indexed';
import type { EngineeringView } from '../../web/engineeringSession';
import type { ShipPort } from '../../web/shipPort';
import { EngineeringPanel } from './engineering';

const unit = (name: string, type: number, max = 100, maxDamage = 180) => ({ name, type, current: max / 2, target: max / 2, max, chargeTicks: 291, dischargeTicks: 291, damage: 0, repair: 0, baseDamage: 0, maxDamage, efficiency: type === UNIT_FUSION ? 95 : 0 });
/** Every page's units, 35 as the original's: warp-typed but for a torpedo launcher, a reactor and the grid. */
const units = Array.from({ length: 35 }, (_, i) => unit(`Unit ${i}`, i === 19 ? UNIT_TORPEDO : i === 33 ? UNIT_FUSION : i === 32 ? UNIT_POWER_GRID : UNIT_WARP, i === 19 ? 10 : 100));

function artView(): NonNullable<EngineeringView['art']> {
  const sliders = Array.from({ length: 70 }, (_, i) => ({ x: 100 + (i & 1) * 150, y: 20 + (i >> 1) * 6, flags: i & 1 ? 0x21 : 0x11 }));
  const font = new BitmapFont(new Uint8Array([1, 3, 0x20, 0x20, 3, 0, 0, 0, 0, 4, 0, 0, 0]));
  return {
    images: Array.from({ length: PACK_ENTRIES }, () => ({ width: 2, height: 2, pixels: new Uint8Array(4) })),
    tables: { sliders, labels: [], rows: [], shieldOrder: [3, 2, 1, 0, 7, 6, 5, 4], paletteIndex: [] }, fonts: [font, font, font], palette: new Palette(),
  };
}

describe('EngineeringPanel', () => {
  let root: HTMLElement;
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    render(null, root);
    root.remove();
    vi.useRealTimers();
  });

  function show(art: boolean, systems = newSystems({ data: { units } } as unknown as ShipContent)) {
    const calls: string[] = [];
    const view: EngineeringView = { units, systems, delegate: false, art: art ? artView() : null };
    const port = {
      engineering: () => view,
      engineeringSlider: (u: number, kind: string, x: number) => { calls.push(`slider ${u} ${kind} ${x}`); },
      engineeringDelegate: () => { calls.push('delegate'); },
      screen: async (code: number) => { calls.push(`screen ${code}`); },
      sound: (name: string) => { calls.push(`sound ${name}`); },
      subscribe: () => () => {},
    } as unknown as ShipPort;
    root = document.body.appendChild(document.createElement('div'));
    act(() => { render(<EngineeringPanel port={port} />, root); });
    return { calls, view, systems };
  }
  const button = (name: string) => [...root.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === name || b.textContent === name) as HTMLButtonElement;
  const slider = (n: number) => root.querySelector<HTMLElement>(`[data-slider="${n}"]`)!;
  const withBox = (el: HTMLElement, width = 1300) => { el.getBoundingClientRect = () => ({ left: 0, top: 0, width, height: 250, right: width, bottom: 250, x: 0, y: 0, toJSON: () => ({}) }); return el; };
  const pointer = (type: string, clientX: number, extra: Record<string, unknown> = {}) => Object.assign(new MouseEvent(type, { bubbles: true, clientX, button: 0 }), { pointerId: 1, ...extra });

  describe('with the original\'s pictures', () => {
    it('draws the screen on a canvas with the tabs and buttons over it, the Power page first', () => {
      show(true);
      expect(root.querySelector('canvas.au-eng-canvas')).not.toBeNull();
      expect(root.querySelector('[data-page="power"]')).not.toBeNull();
      for (const name of ['Power', 'Weapons', 'Shields', 'Sensors', 'Other', 'Bridge', 'Tactical', 'Delegate']) expect(button(name), name).toBeTruthy();
      expect(button('Power').getAttribute('aria-pressed')).toBe('true');
      // the page's sixteen sliders (0x36 to 0x45), each named for its unit
      expect(root.querySelectorAll('[role="slider"]')).toHaveLength(16);
      expect(slider(0x37).getAttribute('aria-label')).toBe('Unit 27 power');
      expect(slider(0x36).getAttribute('aria-label')).toBe('Unit 27 repair');
    });

    it('changes page by its tabs, with the click, and shows that page\'s sliders: the shields in the executable\'s order', () => {
      const { calls } = show(true);
      act(() => { button('Shields').click(); });
      expect(calls).toEqual(['sound shipBeep']);
      expect(root.querySelector('[data-page="shields"]')).not.toBeNull();
      expect(button('Shields').getAttribute('aria-pressed')).toBe('true');
      expect(root.querySelectorAll('[role="slider"]')).toHaveLength(16);
      expect(slider(0).getAttribute('aria-label')).toBe('Unit 3 repair');
      act(() => { button('Shields').click(); });
      expect(calls).toEqual(['sound shipBeep']);
    });

    it('sets a slider where the pointer goes down and drags it along, in the original\'s pixels from the bar\'s own start', () => {
      const { calls } = show(true);
      const box = withBox(slider(0x37));
      // (the box starts 7 pixels left of the bar and is 130 wide: 1300 px here, ten to the pixel, so 400 is 40 along the box, 33 along the bar)
      act(() => { box.dispatchEvent(pointer('pointerdown', 400)); });
      act(() => { box.dispatchEvent(pointer('pointermove', 900)); });
      act(() => { box.dispatchEvent(pointer('pointerup', 900)); });
      act(() => { box.dispatchEvent(pointer('pointermove', 1000)); });
      expect(calls).toEqual(['slider 27 power 33', 'slider 27 power 83']);
    });

    it('steps a slider by the arrow keys by a twentieth of the bar, and to its ends by Home and End', () => {
      const { calls, view } = show(true);
      view.systems.units[27]!.target = 50;
      const el = slider(0x37);
      act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
      act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); });
      act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })); });
      expect(calls).toEqual([`slider 27 power ${Math.round(50 * 119 / 100) + 6}`, 'slider 27 power 0', 'slider 27 power 119']);
    });

    it('says the sliders\' values to a reader as percentages of the bar', () => {
      const { view } = show(true);
      view.systems.units[27]!.target = 25;
      act(() => { render(null, root); });
      root.remove();
      show(true, view.systems);
      expect(slider(0x37).getAttribute('aria-valuenow')).toBe(String(Math.round(Math.round(25 * 119 / 100) * 100 / 119)));
    });

    it('holds Bridge and Tactical down before they go, and Delegate before it takes over', () => {
      const { calls } = show(true);
      act(() => { button('Bridge').click(); });
      expect(calls).toEqual(['sound shipBeep']);
      // (a second button while one is down does nothing)
      act(() => { button('Tactical').click(); });
      expect(calls).toEqual(['sound shipBeep']);
      act(() => { vi.advanceTimersByTime(497); });
      expect(calls).toEqual(['sound shipBeep']);
      act(() => { vi.advanceTimersByTime(2); });
      expect(calls).toEqual(['sound shipBeep', 'screen 0']);
      act(() => { button('Tactical').click(); vi.advanceTimersByTime(500); });
      act(() => { button('Delegate').click(); });
      expect(calls.slice(-1)).toEqual(['sound shipBeep']);
      act(() => { vi.advanceTimersByTime(124); });
      expect(calls.slice(-2)).toEqual(['sound shipBeep', 'delegate']);
      expect(calls).toContain('screen 7');
    });

    it('gives each slider one pointer-hover to the one the info box shows, and lets go of it', () => {
      show(true);
      const el = slider(0x37);
      act(() => { el.dispatchEvent(new MouseEvent('pointerenter')); });
      expect(root.querySelector('[data-unit-info]')?.textContent).toContain('Unit 27');
      act(() => { el.dispatchEvent(new MouseEvent('pointerleave')); });
      expect(root.querySelector('[data-unit-info]')).toBeNull();
    });

    it('leaves a read-only slider alone', () => {
      const view = artView();
      view.tables.sliders[0x37]!.flags = 0x821;
      const calls: string[] = [];
      const port = {
        engineering: () => ({ units, systems: newSystems({ data: { units } } as unknown as ShipContent), delegate: false, art: view }),
        engineeringSlider: (u: number) => { calls.push(`slider ${u}`); }, engineeringDelegate: () => {}, screen: async () => {}, sound: () => {}, subscribe: () => () => {},
      } as unknown as ShipPort;
      root = document.body.appendChild(document.createElement('div'));
      act(() => { render(<EngineeringPanel port={port} />, root); });
      const el = withBox(slider(0x37));
      expect(el.getAttribute('aria-readonly')).toBe('true');
      act(() => { el.dispatchEvent(pointer('pointerdown', 400)); });
      expect(calls).toEqual([]);
    });
  });

  describe('without them', () => {
    it('lists the page\'s units with a power slider each, and sets it through the port', () => {
      const { calls } = show(false);
      expect(root.querySelector('canvas')).toBeNull();
      expect(root.querySelector('h2')?.textContent).toBe('Engineering');
      // the Power page: units 27 to 34 (the grid has no slider)
      const rows = [...root.querySelectorAll('[data-unit-row]')].map(r => r.getAttribute('data-unit-row'));
      expect(rows).toEqual(['27', '28', '29', '30', '31', '32', '33', '34']);
      expect(root.querySelector('[data-unit-row="32"] input')).toBeNull();
      const input = root.querySelector<HTMLInputElement>('[data-unit-row="27"] input[data-kind="power"]')!;
      input.value = '60';
      act(() => { input.dispatchEvent(new Event('input', { bubbles: true })); });
      expect(calls).toEqual(['slider 27 power 60']);
      expect(root.querySelector('[data-unit-row="33"] input')?.getAttribute('data-kind')).toBe('reactor');
    });

    it('offers a repair slider only for a damaged unit, and the torpedoes\' loading on the Weapons page', () => {
      const systems = newSystems({ data: { units } } as unknown as ShipContent);
      systems.units[28]!.damage = 60;
      show(false, systems);
      expect(root.querySelectorAll('[data-unit-row="28"] input')).toHaveLength(2);
      expect(root.querySelectorAll('[data-unit-row="27"] input')).toHaveLength(1);
      expect(root.querySelector('[data-unit-row="28"]')?.textContent).toContain('1.0000 minutes to repair');
      act(() => { button('Weapons').click(); });
      expect(root.querySelector('[data-unit-row="19"] input')?.getAttribute('data-kind')).toBe('torpedoes');
      expect(root.querySelector('[data-unit-row="19"] input')?.getAttribute('max')).toBe('101');
    });

    it('has the same three buttons', () => {
      const { calls } = show(false);
      act(() => { button('Bridge').click(); vi.advanceTimersByTime(500); });
      expect(calls).toEqual(['sound shipBeep', 'screen 0']);
    });
  });

  it('shows nothing when the ship is not at engineering', () => {
    const port = { engineering: () => null, subscribe: () => () => {} } as unknown as ShipPort;
    root = document.body.appendChild(document.createElement('div'));
    act(() => { render(<EngineeringPanel port={port} />, root); });
    expect(root.innerHTML).toBe('');
  });
});
