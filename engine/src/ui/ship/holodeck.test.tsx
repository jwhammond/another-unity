// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { layoutChoices } from '../../view/dialogLayout';
import type { LoadedHolodeckArt } from '../../view/holodeckArt';
import { BitmapFont, Palette } from '../../view/indexed';
import type { ShipPort } from '../../web/shipPort';
import { HolodeckPanel } from './holodeck';

const font = (colour: number) => new BitmapFont(new Uint8Array([1, 16, 0x20, 0x7e, 65, 0, 0, 1, 4, ...Array.from({ length: 0x5f }, () => [4, ...Array<number>(64).fill(colour)]).flat()]));
function art(): LoadedHolodeckArt {
  return {
    background: { width: 640, height: 480, pixels: new Uint8Array(640 * 480) },
    frames: Array.from({ length: 31 }, (_, i) => ({ width: i === 11 || i === 13 || i === 14 || i === 16 ? 20 : 4, height: i === 11 || i === 13 || i === 14 || i === 16 ? 18 : 4, pixels: new Uint8Array(i === 11 || i === 13 || i === 14 || i === 16 ? 360 : 16).fill(1) })),
    normal: font(55), highlight: font(66), palette: new Palette(),
  };
}

describe('HolodeckPanel', () => {
  let root: HTMLElement;
  afterEach(() => { render(null, root); root.remove(); });

  const MOVIES = [{ stem: 'shiptour', title: 'Tour' }, { stem: 'labarriv', title: 'Lab' }];
  function show(opts: { movies?: { stem: string; title: string }[] | null; art?: LoadedHolodeckArt | null } = {}) {
    const calls: string[] = [];
    const movies = opts.movies === undefined ? MOVIES : opts.movies;
    const port = {
      holodeck: () => (movies === null ? null : { movies }),
      holodeckArt: () => (opts.art === undefined ? null : opts.art),
      holodeckPlay: async (stem: string) => { calls.push(`play ${stem}`); },
      holodeckLeave: async () => { calls.push('leave'); },
      screenRect: () => {}, subscribe: () => () => {},
    } as unknown as ShipPort;
    root = document.body.appendChild(document.createElement('div'));
    act(() => { render(<HolodeckPanel port={port} />, root); });
    return calls;
  }

  describe('with the original\'s pictures', () => {
    it('draws holodeck.rm and the dialog on a canvas, with a clear button over each movie and the Bridge button over the painted one', () => {
      show({ art: art() });
      expect(root.querySelector('canvas.au-eng-canvas')).not.toBeNull();
      expect([...root.querySelectorAll('[data-movie]')].map(b => b.getAttribute('data-movie'))).toEqual(['shiptour', 'labarriv']);
      expect(root.querySelector('[data-holodeck]')).not.toBeNull();
      const bridge = root.querySelector<HTMLElement>('.au-painted[data-area="painted-bridge"]')!;
      // (484, 426 to 605, 468 of 640 by 480)
      expect(parseFloat(bridge.style.left)).toBeCloseTo((484 / 640) * 100, 2);
      expect(parseFloat(bridge.style.top)).toBeCloseTo((426 / 480) * 100, 2);
      expect(parseFloat(bridge.style.width)).toBeCloseTo((121 / 640) * 100, 2);
      expect(bridge.querySelector('[data-holodeck-bridge]')).not.toBeNull();
    });

    it('puts each movie over its row in the dialog', () => {
      show({ art: art() });
      const layout = layoutChoices(art(), ['Tour', 'Lab'], 0);
      const li = [...root.querySelectorAll<HTMLElement>('.au-holo-movies > li')];
      expect(li).toHaveLength(2);
      li.forEach((el, i) => {
        const r = layout.rects[i]!;
        expect(parseFloat(el.style.left)).toBeCloseTo((r[0] / 640) * 100, 2);
        expect(parseFloat(el.style.top)).toBeCloseTo((r[1] / 480) * 100, 2);
      });
    });

    it('plays a movie again on a click and leaves by Bridge', async () => {
      const calls = show({ art: art() });
      await act(async () => { root.querySelector<HTMLButtonElement>('[data-movie="labarriv"]')!.click(); });
      await act(async () => { root.querySelector<HTMLButtonElement>('[data-holodeck-bridge]')!.click(); });
      expect(calls).toEqual(['play labarriv', 'leave']);
    });

    it('lights the movie pointed at or focused (the highlighted font) and not when the pointer goes', () => {
      show({ art: art() });
      const first = root.querySelector<HTMLElement>('[data-movie="shiptour"]')!;
      act(() => { first.dispatchEvent(new MouseEvent('pointerenter')); });
      expect(first.hasAttribute('data-selected')).toBe(true);
      act(() => { root.querySelector<HTMLElement>('.au-eng-screen')!.dispatchEvent(new MouseEvent('pointerleave')); });
      expect(first.hasAttribute('data-selected')).toBe(false);
      act(() => { first.dispatchEvent(new FocusEvent('focus')); });
      expect(first.hasAttribute('data-selected')).toBe(true);
      act(() => { first.dispatchEvent(new FocusEvent('blur')); });
      expect(first.hasAttribute('data-selected')).toBe(false);
    });

    it('has both round scroll buttons greyed (disabled) while everything fits, and scrolls a line at a time when it does not', () => {
      show({ art: art(), movies: Array.from({ length: 9 }, (_, i) => ({ stem: `m${i}`, title: `Movie ${i}` })) });
      const up = root.querySelector<HTMLButtonElement>('[data-scroll="up"]')!;
      const down = root.querySelector<HTMLButtonElement>('[data-scroll="down"]')!;
      expect(up.disabled).toBe(true);
      expect(down.disabled).toBe(false);
      const before = root.querySelectorAll('[data-movie]').length;
      act(() => { down.click(); });
      expect(up.disabled).toBe(false);
      expect(root.querySelector('[data-movie="m0"]')).not.toBeNull();
      // (two lines a choice, so the first choice's gap and name are scrolled past in two steps)
      act(() => { down.click(); });
      expect(root.querySelector('[data-movie="m0"]')).toBeNull();
      expect(root.querySelectorAll('[data-movie]').length).toBeLessThanOrEqual(before);
      act(() => { up.click(); });
      act(() => { up.click(); });
      expect(root.querySelector('[data-movie="m0"]')).not.toBeNull();
    });

    it('says when nothing has been seen, and still has Bridge', () => {
      show({ art: art(), movies: [] });
      expect(root.textContent).toContain('Nothing has been seen yet.');
      expect(root.querySelector('[data-holodeck-bridge]')).not.toBeNull();
    });
  });

  describe('without them', () => {
    it('is the plain panel: the movies as buttons, and Bridge', async () => {
      const calls = show();
      expect(root.querySelector('canvas')).toBeNull();
      expect(root.querySelector('.au-ship-holodeck')).not.toBeNull();
      await act(async () => { root.querySelector<HTMLButtonElement>('[data-movie="shiptour"]')!.click(); });
      await act(async () => { root.querySelector<HTMLButtonElement>('[data-holodeck-bridge]')!.click(); });
      expect(calls).toEqual(['play shiptour', 'leave']);
    });
  });

  it('shows nothing when the ship is not at the holodeck', () => {
    show({ movies: null });
    expect(root.innerHTML).toBe('');
  });
});
