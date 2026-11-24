// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import type { ComputerScreenView, ShipPort } from '../../web/shipPort';
import { ComputerPanel } from './computer';
import { areaStyle } from './areas';

type Areas = Record<string, [number, number, number, number]>;

describe('ComputerPanel', () => {
  let root: HTMLElement;
  afterEach(() => {
    render(null, root);
    root.remove();
  });
  const view: ComputerScreenView = {
    rows: [
      { entry: 0, child: false, title: '-Root-', selected: false },
      { entry: 4, child: true, title: '-Child-', selected: true },
    ],
    heading: '-Heading-', text: '-Body-', canScrollUp: false, canScrollDown: true,
  };
  function show(current: ComputerScreenView | null, areas: Areas | null = null) {
    const calls: string[] = [];
    const port = {
      computer: () => current,
      computerRow: async (i: number) => { calls.push(`row ${i}`); },
      computerScroll: async (by: number) => { calls.push(`scroll ${by}`); },
      computerLeave: async (to: string) => { calls.push(`leave ${to}`); },
      shipPlate: () => (areas === null ? null : { areas }),
      screenRect: (box: unknown) => { calls.push(box === null ? 'box off' : 'box on'); },
      subscribe: () => () => {},
    } as unknown as ShipPort;
    root = document.body.appendChild(document.createElement('div'));
    act(() => { render(<ComputerPanel port={port} />, root); });
    return calls;
  }
  const button = (name: string) => [...root.querySelectorAll('button')].find(b => b.textContent === name)!;

  it('shows the rows, the heading and the text, and marks the selected row', () => {
    show(view);
    expect([...root.querySelectorAll('[data-row]')].map(b => b.textContent)).toEqual(['-Root-', '-Child-']);
    expect(root.querySelector('[aria-current="true"]')?.textContent).toBe('-Child-');
    expect(root.querySelector('h2')?.textContent).toBe('-Heading-');
    expect(root.querySelector('article')?.textContent).toContain('-Body-');
  });

  it('clicks a row, scrolls the list, and leaves by its buttons', async () => {
    const calls = show(view);
    await act(async () => { root.querySelector<HTMLButtonElement>('[data-row="1"]')!.click(); });
    expect(button('Up').disabled).toBe(true);
    await act(async () => { button('Down').click(); });
    await act(async () => { button('Bridge').click(); });
    await act(async () => { button('Astrogation').click(); });
    await act(async () => { button('Tactical').click(); });
    expect(calls).toEqual(['row 1', 'scroll 1', 'leave bridge', 'leave astrogation', 'leave tactical']);
  });

  it('shows nothing when the computer is not open', () => {
    show(null);
    expect(root.innerHTML).toBe('');
  });

  describe('with a plate (R17)', () => {
    const AREAS: Areas = { rows: [14, 54, 155, 346], entry: [190, 53, 450, 305], scroll: [64, 416, 209, 49], exits: [491, 373, 119, 100] };
    const inside = (el: HTMLElement, rect: [number, number, number, number]) => {
      const [l, t, w, h] = [parseFloat(el.style.left), parseFloat(el.style.top), parseFloat(el.style.width), parseFloat(el.style.height)];
      return l >= (rect[0] / 640) * 100 - 0.01 && t >= (rect[1] / 480) * 100 - 0.01 && l + w <= ((rect[0] + rect[2]) / 640) * 100 + 0.01 && t + h <= ((rect[1] + rect[3]) / 480) * 100 + 0.01;
    };
    const snapshot = () => [...root.querySelectorAll('button, h2, p, [aria-label]')].map(el => [
      el.tagName, el.textContent, (el as HTMLButtonElement).disabled, ...el.getAttributeNames().filter(n => (n.startsWith('data-') && n !== 'data-area') || n.startsWith('aria-')).map(n => `${n}=${el.getAttribute(n)}`),
    ].join('|'));

    it('renders the same buttons, labels, order and data-* with a plate and without', () => {
      show(view, AREAS);
      const plated = snapshot();
      render(null, root);
      root.remove();
      show(view, null);
      expect(plated.length).toBeGreaterThan(6);
      expect(plated).toEqual(snapshot());
    });

    it('puts each section inside its area, in a 4:3 box that registers itself, and the exits over the plate\'s own grey buttons', () => {
      const calls = show(view, AREAS);
      const box = root.querySelector('.au-ship-screen') as HTMLElement;
      expect(box.style.aspectRatio).toMatch(/640\s*\/\s*480/);
      expect(calls).toContain('box on');
      const want: Record<string, string> = { '.au-ship-computer-rows': 'rows', '.au-ship-computer-scroll': 'scroll', '.au-ship-computer-entry': 'entry' };
      for (const [selector, area] of Object.entries(want)) {
        const el = root.querySelector(selector) as HTMLElement;
        expect(el.dataset.area).toBe(area);
        expect(el.classList.contains('au-area')).toBe(true);
        expect(inside(el, AREAS[area]!)).toBe(true);
      }
      for (const b of root.querySelectorAll('button')) expect(b.closest('[data-area]')).not.toBeNull();
      // (no box of their own: each exit is a clear painted button at the original's rectangle)
      expect(root.querySelector('.au-ship-bar')!.hasAttribute('data-area')).toBe(false);
      const tactical = root.querySelector<HTMLElement>('[data-painted="exit-tactical"]')!;
      expect(tactical.getAttribute('aria-label')).toBe('Tactical');
      expect(tactical.parentElement!.style.top).toBe(areaStyle([490, 434, 112, 30]).top);
    });

    it('is the flat panel without a plate, and keeps the handlers with one', async () => {
      show(view, null);
      expect(root.querySelector('.au-ship-screen')).toBeNull();
      expect(root.querySelector('[data-area]')).toBeNull();
      render(null, root);
      root.remove();
      const calls = show(view, AREAS);
      await act(async () => { root.querySelector<HTMLButtonElement>('[data-row="1"]')!.click(); });
      await act(async () => { button('Down').click(); });
      await act(async () => { button('Astrogation').click(); });
      expect(calls).toEqual(['box on', 'row 1', 'scroll 1', 'leave astrogation']);
    });

    it('puts the four scroll halves over the painted round arrows, and the text halves scroll the entry', async () => {
      const calls = show(view, AREAS);
      const at = (which: string) => root.querySelector<HTMLButtonElement>(`[data-painted="${which}"]`)!;
      expect(at('list-up').parentElement!.style.left).toBe(areaStyle([61, 412, 57, 28]).left);
      expect(at('text-down').parentElement!.style.top).toBe(areaStyle([217, 440, 57, 28]).top);
      const entry = root.querySelector('article')!;
      entry.scrollTop = 100;
      await act(async () => { at('text-up').click(); });
      expect(entry.scrollTop).toBeLessThan(100);
      await act(async () => { at('text-down').click(); });
      expect(calls).toEqual(['box on']);
    });
  });
});
