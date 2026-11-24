// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CourseError } from '../../sim/astro';
import type { AstroSelection, ShipPort } from '../../web/shipPort';
import { AstrogationPanel, formatTime } from './astrogation';
import { ASTRO_SPRITES } from '../faces';
import { BitmapFont } from '../../view/indexed';
import { displayOn, moveCursor, newMapCamera, padClick, toggleDisplay } from '../../sim/astroCamera';
import type { MapPanel, MapView } from '../../sim/astroCamera';

const NO_TIME = { years: 0, months: 0, days: 0, hours: 0, minutes: 0, seconds: 0 };

type Areas = Record<string, [number, number, number, number]>;

function fakePort(areas: Areas | null = null) {
  const calls: string[] = [];
  const listeners = new Set<() => void>();
  const notify = () => { for (const l of listeners) l(); };
  const port = {
    engaged: [] as unknown[],
    refusal: null as CourseError | null,
    selected: null as AstroSelection | null,
    sprites: null as ReturnType<ShipPort['astroSprites']>,
    astroSprites: () => port.sprites,
    transitNow: null as { progress: number; eta: typeof NO_TIME } | null,
    sectors: () => [{ index: 3, label: '-Alpha-', charted: true }, { index: 5, label: 'Sector 5', charted: false }],
    stars: (sector: number) => (sector === 3
      ? [{ index: 0, label: '-One-', planets: 2 }, { index: 1, label: 'Star 2', planets: 0 }]
      : []),
    selection: () => port.selected,
    select: (s: AstroSelection | null) => { port.selected = s; notify(); },
    stopped: 0,
    stopTransit: async () => { port.stopped++; },
    // (the screen opens on the Info tab; most of these look at the Course tab, where Engage is)
    cam: { ...newMapCamera(), panel: 'course' as MapPanel },
    mapCamera: () => ({ ...port.cam, display: Array.from({ length: 9 }, (_, i) => displayOn(port.cam, i)) }),
    mapPad: (b: number) => { calls.push(`pad ${b}`); padClick(port.cam, b, 1e6 + calls.length * 1e4); notify(); },
    mapCursor: (axis: number, step: number) => { calls.push(`cursor ${axis} ${step}`); moveCursor(port.cam, axis, step); notify(); },
    mapView: (v: MapView) => { port.cam.view = v; notify(); },
    mapPanel: (p: MapPanel) => { port.cam.panel = p; notify(); },
    mapDisplay: (i: number) => { toggleDisplay(port.cam, i); notify(); },
    selectionInfo: () => ({ title: '-Alpha-', lines: ['a line'] }),
    messages: null as readonly string[] | null,
    astroText: () => ({ title: 'ALPHA 1-2-3', cursor: [1, 2, 3] as [number, number, number], ship: [4, 5, 6] as [number, number, number], labels: null as readonly string[] | null, messages: port.messages }),
    preview: () => ({ location: { sector: 3, star: 0, planet: -1, moon: -1, station: -1, phenomenon: -1 }, to: { x: 1, y: 2, z: 3 }, orbit: 0, time: { ...NO_TIME, days: 2, hours: 5 } }),
    engage: async (course: unknown) => { port.engaged.push(course); return port.refusal; },
    transit: () => port.transitNow,
    maxWarp: () => 940,
    exitCursor: () => 'pointer',
    fonts: null as ReturnType<ShipPort['astroFonts']>,
    astroFonts: () => port.fonts,
    impulseSteps: () => 4,
    exits: true,
    exitsEnabled: () => port.exits,
    station: async () => {},
    viewscreen: () => null,
    calls,
    shipPlate: () => (areas === null ? null : { areas }),
    screenRect: (box: unknown) => { calls.push(box === null ? 'box off' : 'box on'); },
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
  };
  return port;
}

describe('AstrogationPanel', () => {
  let root: HTMLElement;
  afterEach(() => { render(null, root); root.remove(); });
  function show(port: ReturnType<typeof fakePort>) {
    root = document.body.appendChild(document.createElement('div'));
    act(() => { render(<AstrogationPanel port={port as unknown as ShipPort} />, root); });
  }
  const select = (label: string) => [...root.querySelectorAll('label')].find(l => l.textContent?.startsWith(label))!.querySelector('select')!;
  const choose = (el: HTMLSelectElement, value: string) => act(() => { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); });
  const button = (name: string) => [...root.querySelectorAll('button')].find(b => b.textContent === name)!;

  it('lists a chosen sector\'s stars, and a star\'s planets by index', () => {
    const port = fakePort();
    show(port);
    expect(root.textContent).not.toContain('-One-');
    choose(select('Sector'), '3');
    expect([...select('Star').options].map(o => o.textContent)).toEqual(['Choose a star', '-One-', 'Star 2']);
    choose(select('Star'), '0');
    expect([...select('Planet').options].map(o => o.textContent)).toEqual(['The star', 'Planet 1', 'Planet 2']);
    expect(root.textContent).toContain('2d 5h');
  });

  it('engages the chosen course at warp 5.0, as the original starts it (setDefaults), and at the speed picked', async () => {
    const port = fakePort();
    port.selected = { sector: 3, star: 0, planet: 1 };
    show(port);
    expect(root.querySelector('[data-readout="speed"]')?.textContent).toBe('5.0');
    await act(async () => { button('Engage').click(); });
    expect(port.engaged).toEqual([{ sector: 3, star: 0, planet: 1, warp: true, speed: 500 }]);
    // (Faster steps the warp up a tenth of a factor, as the original's button does)
    for (let i = 0; i < 44; i++) await act(async () => { button('Faster').click(); });
    await act(async () => { button('Engage').click(); });
    expect(port.engaged[1]).toEqual({ sector: 3, star: 0, planet: 1, warp: true, speed: 940 });
    expect(root.querySelector('[data-readout="speed"]')?.textContent).toBe('9.4');
    for (let i = 0; i < 44; i++) await act(async () => { button('Slower').click(); });
    expect(root.querySelector('[data-readout="speed"]')?.textContent).toBe('5.0');
    // (and Impulse gives its own setting, in tenths of full: 100 percent to start, here four steps in all)
    await act(async () => { button('Impulse').click(); });
    expect(root.querySelector('[data-readout="speed"]')?.textContent).toBe('40%');
    await act(async () => { button('Faster').click(); button('Faster').click(); });
    expect(root.querySelector('[data-readout="speed"]')?.textContent).toBe('40%');
    await act(async () => { button('Slower').click(); });
    expect(root.querySelector('[data-readout="speed"]')?.textContent).toBe('30%');
  });

  it('keeps the warp buttons to 1.0 to 9.9 whatever the engines can do, and a course refused as too fast sets the speed to the most they can (checkCourse)', async () => {
    const port = fakePort();
    port.selected = { sector: 3, star: 0, planet: 1 };
    show(port);
    for (let i = 0; i < 60; i++) await act(async () => { button('Faster').click(); });
    expect(root.querySelector('[data-readout="speed"]')?.textContent).toBe('9.9');
    port.refusal = 'too fast';
    await act(async () => { button('Engage').click(); });
    expect(port.engaged).toEqual([{ sector: 3, star: 0, planet: 1, warp: true, speed: 990 }]);
    expect(root.querySelector('[data-readout="speed"]')?.textContent).toBe('9.4');
    for (let i = 0; i < 90; i++) await act(async () => { button('Slower').click(); });
    expect(root.querySelector('[data-readout="speed"]')?.textContent).toBe('1.0');
  });

  it('disables Engage and the way back while a scripted warp engages by itself', () => {
    const port = fakePort();
    port.selected = { sector: 3, star: 0 };
    port.exits = false;
    show(port);
    expect(button('Engage').disabled).toBe(true);
    expect(button('Back to the bridge').disabled).toBe(true);
  });

  it('does not engage with nothing chosen, and with only a sector chosen goes to the cursor, as startCourse does', async () => {
    const port = fakePort();
    show(port);
    expect(button('Engage').disabled).toBe(true);
    render(null, root); root.remove();
    port.selected = { sector: 3 };
    port.cam.cursorSector = [1, 2, 3];
    port.cam.cursor = [4, 5, 6];
    show(port);
    expect(button('Engage').disabled).toBe(false);
    await act(async () => { button('Engage').click(); });
    expect(port.engaged).toEqual([{ sector: 3, warp: true, speed: 500, point: { x: 24, y: 45, z: 66 } }]);
  });

  it('plots a moon, an outpost, a belt, a station or a hazard as chosen on the map, with no cursor point', async () => {
    for (const chosen of [{ sector: 3, star: 0, planet: 1, moon: 0 }, { sector: 3, star: 0, planet: 1, station: true }, { sector: 3, star: 0, planet: 1, phenomenon: 0 }, { sector: 3, station: true }, { sector: 3, phenomenon: 2 }]) {
      const port = fakePort();
      port.selected = chosen;
      show(port);
      await act(async () => { button('Engage').click(); });
      expect(port.engaged).toEqual([{ ...chosen, warp: true, speed: 500, ...(chosen.star === undefined && !chosen.station && chosen.phenomenon === undefined ? { point: { x: 0, y: 0, z: 0 } } : {}) }]);
      render(null, root); root.remove();
    }
  });

  it('shows a refusal in an alert', async () => {
    const port = fakePort();
    port.selected = { sector: 3, star: 0 };
    port.refusal = 'too fast';
    show(port);
    await act(async () => { button('Engage').click(); });
    expect(root.querySelector('[role="alert"]')!.textContent).toBe('The ship cannot go that fast.');
  });

  it('shows a rejection from the port in an alert', async () => {
    const port = fakePort();
    port.selected = { sector: 3, star: 0 };
    port.engage = async () => { throw new Error('Wait until nothing is happening, then try again.'); };
    show(port);
    await act(async () => { button('Engage').click(); await new Promise(r => setTimeout(r, 0)); });
    expect(root.querySelector('[role="alert"]')!.textContent).toContain('Wait until');
  });

  it('shows the progress in transit, and still lets a new course engage, and Stop stops it', async () => {
    const port = fakePort();
    port.selected = { sector: 3, star: 0 };
    port.transitNow = { progress: 0.25, eta: { ...NO_TIME, minutes: 3, seconds: 9 } };
    show(port);
    expect(root.querySelector<HTMLProgressElement>('progress')!.value).toBe(0.25);
    expect(root.textContent).toContain('3m 9s');
    expect(button('Engage').disabled).toBe(false);
    expect(button('Stop').disabled).toBe(false);
    return act(async () => { button('Stop').click(); }).then(() => expect(port.stopped).toBe(1));
  });

  it('goes back to the bridge', async () => {
    const port = fakePort();
    let went = '';
    port.station = async (name?: unknown) => { went = String(name); };
    show(port);
    await act(async () => { button('Back to the bridge').click(); });
    expect(went).toBe('bridge');
  });
});

describe('AstrogationPanel with a plate (R17)', () => {
  const AREAS: Areas = { map: [10, 19, 379, 348], info: [391, 90, 247, 272], controls: [491, 373, 119, 100] };
  let root: HTMLElement;
  afterEach(() => { render(null, root); root.remove(); });
  function show(port: ReturnType<typeof fakePort>) {
    root = document.body.appendChild(document.createElement('div'));
    act(() => { render(<AstrogationPanel port={port as unknown as ShipPort} />, root); });
  }
  const chosen = (areas: Areas | null) => {
    const port = fakePort(areas);
    port.selected = { sector: 3, star: 0, planet: 1 };
    return port;
  };
  const snapshot = () => [...root.querySelectorAll('label, button, select, input, output, legend, progress, h2, p')].map(el => [
    el.tagName, el.textContent, (el as HTMLButtonElement).disabled, ...el.getAttributeNames().filter(n => n.startsWith('data-') || n === 'aria-label' || n === 'type' || n === 'name').map(n => `${n}=${el.getAttribute(n)}`),
  ].join('|'));
  const inside = (el: HTMLElement, rect: [number, number, number, number]) => {
    const [l, t, w, h] = [parseFloat(el.style.left), parseFloat(el.style.top), parseFloat(el.style.width), parseFloat(el.style.height)];
    return l >= (rect[0] / 640) * 100 - 0.01 && t >= (rect[1] / 480) * 100 - 0.01 && l + w <= ((rect[0] + rect[2]) / 640) * 100 + 0.01 && t + h <= ((rect[1] + rect[3]) / 480) * 100 + 0.01;
  };

  it('renders the same controls, labels, order and data-* with a plate and without', () => {
    show(chosen(AREAS));
    const plated = snapshot();
    render(null, root);
    root.remove();
    show(chosen(null));
    expect(plated.length).toBeGreaterThan(10);
    expect(plated).toEqual(snapshot());
  });

  it('puts the selectors, mode, speed, journey and Engage in the info area and the exits over their painted places, in a 4:3 box that registers itself', () => {
    const port = chosen(AREAS);
    show(port);
    const box = root.querySelector('.au-ship-screen') as HTMLElement;
    expect(box.style.aspectRatio).toMatch(/640\s*\/\s*480/);
    expect(port.calls).toContain('box on');
    const info = root.querySelector('[data-area="info"]') as HTMLElement;
    expect(info.classList.contains('au-area')).toBe(true);
    expect(inside(info, AREAS.info!)).toBe(true);
    // (the exit block is painted: no ground over it, its three buttons at their places)
    expect(root.querySelector('[data-area="controls"]')).toBeNull();
    expect(root.querySelector<HTMLElement>('[data-area="painted-exit-computer"]')!.style.top).toBe(`${Number(((401 / 480) * 100).toFixed(4))}%`);
    expect([...info.querySelectorAll('select')].map(e => e.closest('label')?.textContent?.match(/^[A-Z][a-z]+/)?.[0])).toEqual(['Sector', 'Star', 'Planet']);
    expect(info.textContent).toContain('Journey time');
    // (the course panel's controls are painted at the original's rectangles, not in the info box)
    expect([...info.querySelectorAll('button')]).toEqual([]);
    expect(root.querySelector<HTMLElement>('[data-area="painted-engage"]')!.style.top).toBe(`${Number(((161 / 480) * 100).toFixed(4))}%`);
    for (const id of ['warp', 'impulse', 'faster', 'slower', 'engage', 'stop']) expect(root.querySelector(`[data-painted="${id}"]`)).not.toBeNull();
    // the map has no element: the session draws it
    expect(root.querySelector('[data-area="map"]')).toBeNull();
    // every control is in an area, and the heading stays in the tree, visually hidden
    for (const el of root.querySelectorAll('button, select, input')) expect(el.closest('[data-area]')).not.toBeNull();
    expect(root.querySelector('h2')?.classList.contains('au-visually-hidden')).toBe(true);
  });

  it('writes the sector at the top and the cursor\'s and the ship\'s coordinates in the plate\'s two fields, where the original does', () => {
    show(chosen(AREAS));
    const at = (id: string) => root.querySelector<HTMLElement>(`[data-readout="${id}"]`)!;
    expect(at('title').textContent).toBe('ALPHA 1-2-3');
    expect([0, 1, 2].map(i => at(`cursor-${'xyz'[i]}`).textContent)).toEqual(['01', '02', '03']);
    expect([0, 1, 2].map(i => at(`ship-${'xyz'[i]}`).textContent)).toEqual(['04', '05', '06']);
    // (x 197, 229, 261 and 318, 350, 382 of 640, y 417 of 480)
    expect(at('cursor-y').style.left).toBe(`${Number(((229 / 640) * 100).toFixed(4))}%`);
    expect(at('ship-z').style.left).toBe(`${Number(((382 / 640) * 100).toFixed(4))}%`);
    expect(at('ship-x').style.top).toBe(`${Number(((417 / 480) * 100).toFixed(4))}%`);
    expect(at('title').style.left).toBe(`${Number(((101 / 640) * 100).toFixed(4))}%`);
  });

  it('keeps the selectors in the tree but out of sight on the plate, and the info text where the original writes it', () => {
    const port = chosen(AREAS);
    port.cam.panel = 'info';
    show(port);
    const info = root.querySelector('[data-area="info"]')!;
    expect(info.querySelector('.au-visually-hidden select')).not.toBeNull();
    expect(info.querySelector('.au-astro-detail h3')?.textContent).toBe('-Alpha-');
    expect(info.querySelector('.au-astro-detail p')?.textContent).toBe('a line');
  });

  describe('the original\'s panel pictures and the engine running on them', () => {
    const PICTURES: Record<string, [number, number, number, number]> = {
      info_tab: [384, 24, 256, 66], display_tab: [389, 28, 250, 60], display_bottom: [389, 164, 250, 196], course_warp: [384, 24, 256, 342], course_impulse: [384, 24, 256, 342],
    };
    const withPictures = (port: ReturnType<typeof fakePort>, panel: MapPanel) => {
      port.cam.panel = panel;
      port.sprites = {
        sprite: (name: string) => ({ url: `/${name}.webp`, rect: [0, 0, 1, 1] as const }),
        panel: (name: string) => (PICTURES[name] ? { url: `/${name}.webp`, rect: PICTURES[name]! } : undefined),
        engine: (warp: boolean) => Array.from({ length: warp ? 6 : 5 }, (_, i) => ({ url: `/engine_${warp ? 'warp' : 'impulse'}${i}.webp`, rect: [393, 219, 243, 141] as const })),
      } as never;
      return port;
    };
    const picture = () => root.querySelector<HTMLImageElement>('img[data-panel]');
    const engine = () => root.querySelector<HTMLImageElement>('img[data-engine]');

    it('draws the tab that is open as the original does: its tab strip, and for the course the whole panel for the drive that is chosen', async () => {
      const port = withPictures(chosen(AREAS), 'info');
      show(port);
      expect(picture()?.dataset.panel).toBe('info_tab');
      expect(picture()?.style.left).toBe(`${Number(((384 / 640) * 100).toFixed(4))}%`);
      expect(engine()).toBeNull();
      render(null, root); root.remove();
      show(withPictures(chosen(AREAS), 'course'));
      expect(picture()?.dataset.panel).toBe('course_warp');
      await act(async () => { root.querySelector<HTMLButtonElement>('[data-painted="impulse"]')!.click(); });
      expect(picture()?.dataset.panel).toBe('course_impulse');
      render(null, root); root.remove();
      show(withPictures(chosen(AREAS), 'display'));
      expect(picture()?.dataset.panel).toBe('display_tab');
    });

    it('leaves Warp and Impulse clear over the panel\'s own words, and puts the journey in the engine\'s picture instead of the info box', () => {
      show(withPictures(chosen(AREAS), 'course'));
      expect(root.querySelector('[data-painted="warp"]')?.classList.contains('au-painted-art')).toBe(true);
      expect(root.querySelector('[data-area="info"] .au-astro-spacer')).toBeNull();
      expect(root.querySelector('[data-area="info"]')?.textContent).not.toContain('Journey');
      expect(root.querySelector('.au-astro-journey')?.textContent).toContain('2d 5h');
    });

    it('runs the engine\'s frames, six for warp and five for impulse, 166 milliseconds each', async () => {
      vi.useFakeTimers();
      try {
        show(withPictures(chosen(AREAS), 'course'));
        expect(engine()?.dataset.engine).toBe('0');
        expect(engine()?.style.top).toBe(`${Number(((219 / 480) * 100).toFixed(4))}%`);
        await act(async () => { vi.advanceTimersByTime(170); });
        expect(engine()?.dataset.engine).toBe('1');
        await act(async () => { vi.advanceTimersByTime(166 * 5); });
        expect(engine()?.dataset.engine).toBe('0');
        expect(engine()?.getAttribute('src')).toBe('/engine_warp0.webp');
        await act(async () => { root.querySelector<HTMLButtonElement>('[data-painted="impulse"]')!.click(); });
        expect(engine()?.getAttribute('src')).toMatch(/engine_impulse\d/);
        await act(async () => { vi.advanceTimersByTime(166 * 5); });
        expect(Number(engine()?.dataset.engine)).toBeLessThan(5);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps the CSS look without the pictures', () => {
      const port = chosen(AREAS);
      port.cam.panel = 'course';
      show(port);
      expect(picture()).toBeNull();
      expect(engine()).toBeNull();
      expect(root.querySelector('[data-painted="warp"]')?.classList.contains('au-painted-art')).toBe(false);
      expect(root.querySelector('[data-area="info"]')?.textContent).toContain('Journey');
    });
  });

  describe('the Display tab', () => {
    const display = (labels: readonly string[] | null = null) => {
      const port = chosen(AREAS);
      port.cam.panel = 'display';
      if (labels) port.astroText = () => ({ title: 'T', cursor: [0, 0, 0], ship: [0, 0, 0], labels, messages: null });
      show(port);
      return port;
    };
    const rows = () => [...root.querySelectorAll<HTMLElement>('[data-switch]')];

    it('is a bar for each of the nine switches at the original\'s tops, lit or not, over a checkbox that switches it', async () => {
      const port = display();
      expect(rows()).toHaveLength(9);
      const top = (i: number) => Number(((([102, 126, 169, 193, 217, 241, 265, 308, 332][i]!) / 480) * 100).toFixed(4));
      rows().forEach((row, i) => expect(row.style.top).toBe(`${top(i)}%`));
      // (the stars and grid from x 398, the five regions from 423, inhabited and starbases from 398)
      expect(rows().map(r => r.style.left)).toEqual([398, 398, 423, 423, 423, 423, 423, 398, 398].map(x => `${Number(((x / 640) * 100).toFixed(4))}%`));
      // (stars and grid on, the regions on, inhabited and starbases off)
      expect(rows().map(r => r.querySelector('.au-astro-bar')!.hasAttribute('data-on'))).toEqual([true, true, true, true, true, true, true, false, false]);
      const box = rows()[7]!.querySelector('input')!;
      expect(box.dataset.display).toBe('7');
      await act(async () => { box.click(); });
      expect(displayOn(port.cam, 7)).toBe(true);
      expect(rows()[7]!.querySelector('.au-astro-bar')!.hasAttribute('data-on')).toBe(true);
    });

    it('labels them with the executable\'s words when they are published, and its own otherwise', () => {
      display();
      expect(rows()[2]!.textContent).toBe('Region 1');
      render(null, root);
      root.remove();
      display(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']);
      expect(rows().map(r => r.textContent)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']);
    });

    it('draws the swatches\' picture under the bars, when it is published', () => {
      const port = chosen(AREAS);
      port.cam.panel = 'display';
      port.sprites = { sprite: () => ({ url: '/x.webp', rect: [1, 1, 1, 1] as const }), panel: (name: string) => (name === 'display_bottom' ? { url: '/bottom.webp', rect: [389, 164, 250, 196] as const } : undefined), engine: () => undefined } as never;
      show(port);
      const img = root.querySelector<HTMLImageElement>('img.au-astro-sprite');
      expect(img?.getAttribute('src')).toBe('/bottom.webp');
      expect(img?.style.top).toBe(`${Number(((164 / 480) * 100).toFixed(4))}%`);
    });

    it('has no info text, and lets a click through the info box to the bars', () => {
      display();
      expect(root.querySelector('[data-area="info"]')!.hasAttribute('data-passive')).toBe(true);
      expect(root.querySelector('.au-astro-detail')).toBeNull();
    });
  });

  describe('the original\'s sprites on the course panel (art.astro)', () => {
    const SPRITE_RECT: Record<string, [number, number, number, number]> = {
      faster_warp: [478, 93, 66, 28], faster_impulse: [478, 93, 66, 28], slower: [478, 121, 66, 29], engage: [392, 161, 245, 29], stop: [392, 189, 245, 29],
    };
    const withSprites = (port: ReturnType<typeof fakePort>) => {
      port.sprites = {
        sprite: name => {
          const base = name.replace(/_down$/, '');
          return { url: `/${name}.webp`, rect: SPRITE_RECT[base]! };
        },
        panel: () => undefined,
        engine: () => undefined,
      };
      return port;
    };
    const frame = (id: string) => root.querySelector<HTMLElement>(`[data-sprite="${id}"]`);

    it('draws Faster by the drive, Slower, Engage and Stop at the original\'s rectangles, with the button clear over them', () => {
      show(withSprites(chosen(AREAS)));
      expect(ASTRO_SPRITES).toHaveLength(10);
      for (const id of ['faster', 'slower', 'engage', 'stop']) expect(frame(id)).not.toBeNull();
      expect(frame('engage')!.querySelector('img')!.getAttribute('src')).toBe('/engage.webp');
      expect(frame('engage')!.dataset.frame).toBe('up');
      expect(frame('engage')!.style.left).toBe(`${Number(((392 / 640) * 100).toFixed(4))}%`);
      expect(frame('engage')!.style.top).toBe(`${Number(((161 / 480) * 100).toFixed(4))}%`);
      expect(frame('faster')!.querySelector('img')!.getAttribute('src')).toBe('/faster_warp.webp');
      expect(root.querySelector('[data-painted="engage"]')!.classList.contains('au-painted-art')).toBe(true);
      // Warp and Impulse are not MRG pictures: they stay as they were
      expect(frame('warp')).toBeNull();
      expect(root.querySelector('[data-painted="warp"]')!.classList.contains('au-painted-art')).toBe(false);
      // (the sprites are not areas: nothing in them but the buttons' own)
      expect(root.querySelector('[data-sprite][data-area]')).toBeNull();
    });
    it('shows the impulse Faster when impulse is chosen, and each button\'s pressed frame while the pointer is down on it', async () => {
      show(withSprites(chosen(AREAS)));
      const press = (id: string) => root.querySelector<HTMLButtonElement>(`[data-painted="${id}"]`)!;
      await act(async () => { press('impulse').click(); });
      expect(frame('faster')!.querySelector('img')!.getAttribute('src')).toBe('/faster_impulse.webp');
      await act(async () => { press('faster').dispatchEvent(new Event('pointerdown', { bubbles: true })); });
      expect(frame('faster')!.dataset.frame).toBe('down');
      expect(frame('faster')!.querySelector('img')!.getAttribute('src')).toBe('/faster_impulse_down.webp');
      await act(async () => { press('faster').dispatchEvent(new Event('pointerup', { bubbles: true })); });
      expect(frame('faster')!.dataset.frame).toBe('up');
      await act(async () => { press('slower').dispatchEvent(new Event('pointerdown', { bubbles: true })); });
      expect(frame('slower')!.querySelector('img')!.getAttribute('src')).toBe('/slower_down.webp');
      await act(async () => { press('slower').dispatchEvent(new Event('pointerleave', { bubbles: true })); });
      await act(async () => { press('engage').dispatchEvent(new Event('pointerdown', { bubbles: true })); });
      expect(frame('engage')!.querySelector('img')!.getAttribute('src')).toBe('/engage_down.webp');
    });
    it('keeps the CSS buttons without the sprites, or without a plate', () => {
      show(chosen(AREAS));
      expect(root.querySelector('[data-sprite]')).toBeNull();
      expect(root.querySelector('[data-painted="engage"]')!.classList.contains('au-painted-art')).toBe(false);
      render(null, root); root.remove();
      show(withSprites(chosen(null)));
      expect(root.querySelector('[data-sprite]')).toBeNull();
      expect(root.querySelector('[data-painted="engage"]')).not.toBeNull();
    });
  });

  it('reads out the angles of a spinning map as they change, with no event', async () => {
    vi.useFakeTimers();
    try {
      const port = fakePort();
      show(port);
      expect(root.querySelector('[data-readout="azimuth"]')?.textContent).toBe('°A: 006');
      port.cam.azimuth = 2;
      await act(async () => { vi.advanceTimersByTime(300); });
      expect(root.querySelector('[data-readout="azimuth"]')?.textContent).toBe('°A: 002');
    } finally { vi.useRealTimers(); }
  });

  it('is the flat panel without a plate: no box, no areas, a visible heading', () => {
    const port = chosen(null);
    show(port);
    expect(root.querySelector('.au-ship-screen')).toBeNull();
    expect(root.querySelector('[data-area]')).toBeNull();
    expect(root.querySelector('.au-astro-plate')).toBeNull();
    expect(root.querySelector('h2')?.classList.contains('au-visually-hidden')).toBe(false);
    expect(port.calls).not.toContain('box on');
  });

    it('has every painted button: the exits go to their stations, and the tabs, pad, views and cursor arrows drive the map camera', async () => {
      const port = chosen(AREAS);
      const went: string[] = [];
      (port as unknown as { station: (s: string) => Promise<void> }).station = async (s: string) => { went.push(s); };
      show(port);
      const painted = (id: string) => root.querySelector<HTMLButtonElement>(`[data-painted="${id}"]`)!;
      const text = (k: string) => root.querySelector(`[data-readout="${k}"]`)?.textContent;
      expect(root.querySelectorAll('[data-painted]').length).toBe(3 + 3 + 14 + 6);
      for (const id of ['exit-bridge', 'exit-computer', 'exit-engineering']) await act(async () => { painted(id).click(); });
      expect(went).toEqual(['bridge', 'computer', 'engineering']);
      expect(painted('tab-course').getAttribute('aria-pressed')).toBe('true');
      expect(text('elevation')).toBe('°E: 003');
      await act(async () => { painted('pad-up').click(); });
      expect(text('elevation')).toBe('°E: 006');
      await act(async () => { painted('pad-left').click(); });
      expect(text('azimuth')).toBe('°A: 009');
      await act(async () => { painted('view-sector').click(); });
      expect(painted('view-sector').getAttribute('aria-pressed')).toBe('true');
      expect(painted('view-galaxy').getAttribute('aria-pressed')).toBe('false');
      await act(async () => { painted('cursor-y-up').click(); painted('cursor-z-down').click(); });
      expect(port.calls).toEqual(expect.arrayContaining(['cursor 1 1', 'cursor 2 -1']));
      expect(port.cam.cursor).toEqual([0, 1, 19]);
      await act(async () => { painted('tab-info').click(); });
      expect(painted('tab-info').getAttribute('aria-pressed')).toBe('true');
      expect(root.querySelector('[aria-label="Info"]')?.textContent).toContain('a line');
      expect(root.querySelector('input[type="range"]')).toBeNull();
      await act(async () => { painted('tab-display').click(); });
      const grid = root.querySelector<HTMLInputElement>('[data-display="1"]')!;
      expect(grid.checked).toBe(true);
      await act(async () => { grid.click(); });
      expect(port.cam.grid).toBe(false);
    });

  it('keeps the handlers: Engage and Back call the same port methods', async () => {
    const port = chosen(AREAS);
    let went = '';
    port.station = async (name?: unknown) => { went = String(name); };
    show(port);
    const button = (name: string) => [...root.querySelectorAll('button')].find(b => b.textContent === name)!;
    await act(async () => { button('Engage').click(); });
    expect(port.engaged).toEqual([{ sector: 3, star: 0, planet: 1, warp: true, speed: 500 }]);
    await act(async () => { button('Back to the bridge').click(); });
    expect(went).toBe('bridge');
  });
});

describe('AstrogationPanel: the original\'s pictures of held buttons, its fonts, its opening and its pointer', () => {
  const AREAS: Areas = { map: [10, 19, 379, 348], info: [391, 90, 247, 272], controls: [491, 373, 119, 100] };
  let root: HTMLElement;
  afterEach(() => { render(null, root); root.remove(); });
  function show(port: ReturnType<typeof fakePort>) {
    root = document.body.appendChild(document.createElement('div'));
    act(() => { render(<AstrogationPanel port={port as unknown as ShipPort} />, root); });
  }
  const chosen = () => {
    const port = fakePort(AREAS);
    port.selected = { sector: 3, star: 0, planet: 1 };
    return port;
  };
  const painted = (id: string) => root.querySelector<HTMLButtonElement>(`[data-painted="${id}"]`)!;
  const frame = (id: string) => root.querySelector<HTMLElement>(`[data-sprite="${id}"]`);
  /** The panel's own pictures, by the names the publisher writes, each 4 by 3 pixels of its own. */
  const withPictures = (port: ReturnType<typeof fakePort>) => {
    port.sprites = {
      sprite: () => ({ url: '/x.webp', rect: [0, 0, 1, 1] as const }),
      panel: (name: string) => (/_down$|_lit$/.test(name) ? { url: `/${name}.webp`, rect: [0, 0, 4, 3] as const } : undefined),
      engine: () => undefined,
    } as never;
    return port;
  };

  describe('the pad, the arrows, the views and the exits', () => {
    it('are the executable\'s rotation pad rectangles, the bars of up and down over the corners of left and right', () => {
      show(chosen());
      const at = (id: string) => { const el = root.querySelector<HTMLElement>(`[data-area="painted-${id}"]`)!; return [parseFloat(el.style.left) * 6.4, parseFloat(el.style.top) * 4.8, parseFloat(el.style.width) * 6.4, parseFloat(el.style.height) * 4.8].map(Math.round); };
      expect(at('pad-up')).toEqual([9, 374, 99, 28]);
      expect(at('pad-down')).toEqual([9, 445, 99, 28]);
      expect(at('pad-left')).toEqual([9, 374, 28, 99]);
      expect(at('pad-right')).toEqual([80, 374, 28, 99]);
      expect(at('pad-stop')).toEqual([37, 402, 43, 43]);
      // (a later element is over an earlier: buttonAt tries up and down first)
      const order = [...root.querySelectorAll('[data-area^="painted-pad-"]')].map(e => e.getAttribute('data-area'));
      expect(order.indexOf('painted-pad-up')).toBeGreaterThan(order.indexOf('painted-pad-left'));
      expect(order.indexOf('painted-pad-down')).toBeGreaterThan(order.indexOf('painted-pad-right'));
    });

    it('show the original\'s picture of a pad button, a cursor arrow or an exit while it is held, at the button\'s corner and the picture\'s own size, and not otherwise', async () => {
      show(withPictures(chosen()));
      expect(frame('pad-up-held')).toBeNull();
      await act(async () => { painted('pad-up').dispatchEvent(new Event('pointerdown', { bubbles: true })); });
      const held = frame('pad-up-held')!;
      expect(held.querySelector('img')!.getAttribute('src')).toBe('/pad_up_down.webp');
      expect(held.style.left).toBe(`${Number(((9 / 640) * 100).toFixed(4))}%`);
      expect(held.style.top).toBe(`${Number(((374 / 480) * 100).toFixed(4))}%`);
      expect(held.style.width).toBe(`${Number(((4 / 640) * 100).toFixed(4))}%`);
      await act(async () => { painted('pad-up').dispatchEvent(new Event('pointerup', { bubbles: true })); });
      expect(frame('pad-up-held')).toBeNull();
      const pictures: [string, string][] = [['pad-down', 'pad_down_down'], ['pad-left', 'pad_left_down'], ['pad-right', 'pad_right_down'], ['pad-stop', 'pad_stop_down'],
        ['cursor-x-up', 'arrow_up_down'], ['cursor-z-down', 'arrow_down_down'], ['exit-bridge', 'exit_bridge_down'], ['exit-computer', 'exit_computer_down'], ['exit-engineering', 'exit_engineering_down']];
      for (const [id, name] of pictures) {
        await act(async () => { painted(id).dispatchEvent(new Event('pointerdown', { bubbles: true })); });
        expect(frame(`${id}-held`)!.querySelector('img')!.getAttribute('src'), id).toBe(`/${name}.webp`);
        await act(async () => { painted(id).dispatchEvent(new Event('pointerleave', { bubbles: true })); });
      }
    });

    it('light the view the map shows, as drawButtons does always, and move the light when the view changes', async () => {
      show(withPictures(chosen()));
      const lit = () => ['view-galaxy', 'view-sector', 'view-system'].filter(id => frame(`${id}-lit`) !== null);
      expect(lit()).toEqual(['view-galaxy']);
      expect(frame('view-galaxy-lit')!.querySelector('img')!.getAttribute('src')).toBe('/view_galaxy_lit.webp');
      await act(async () => { painted('view-system').click(); });
      expect(lit()).toEqual(['view-system']);
      expect(frame('view-system-lit')!.style.top).toBe(`${Number(((440 / 480) * 100).toFixed(4))}%`);
    });

    it('are the plate\'s own, with no pictures drawn, when they are not published', async () => {
      show(chosen());
      await act(async () => { painted('pad-up').dispatchEvent(new Event('pointerdown', { bubbles: true })); });
      expect(root.querySelector('[data-sprite$="-held"], [data-sprite$="-lit"]')).toBeNull();
    });
  });

  describe('the pointer over the exits', () => {
    it('is the port\'s (the lit use pointer) over an open exit, and the page\'s own over a closed one and everywhere else', () => {
      const port = chosen();
      port.exitCursor = () => 'url("x") 1 2, pointer';
      show(port);
      expect(painted('exit-bridge').style.cursor).toContain('url("x")');
      expect(painted('exit-computer').style.cursor).toContain('url("x")');
      expect(painted('exit-engineering').style.cursor).toContain('url("x")');
      expect(painted('tab-info').style.cursor).toBe('');
      expect(painted('pad-up').style.cursor).toBe('');
      render(null, root);
      root.remove();
      const closed = chosen();
      closed.exits = false;
      closed.exitCursor = () => 'url("x") 1 2, pointer';
      show(closed);
      expect(painted('exit-bridge').style.cursor).toBe('');
    });
  });

  describe('the screen\'s text in the game\'s own fonts', () => {
    /** Fonts of 4-wide glyphs: 8 high for the map, 16 for info, 19 for label (as font0, font2 and font4). */
    const glyphs = (height: number) => new BitmapFont(new Uint8Array([1, height, 0x20, 0x7e, (height * 4 + 1) & 0xff, (height * 4 + 1) >> 8, 0, 1, 4, ...Array.from({ length: 0x5f }, () => [4, ...Array<number>(height * 4).fill(173)]).flat()]));
    const fonts = { fonts: [glyphs(8), glyphs(8), glyphs(16), glyphs(16), glyphs(19)], palette: new Uint8Array(768).fill(100) };
    const canvases = () => [...root.querySelectorAll<HTMLElement>('canvas.au-bt')].map(c => [c.getAttribute('data-bitmap-text'), c.style.left, c.style.top]);
    const where = (x: number, y: number) => [`${Number(((x / 640) * 100).toFixed(4))}%`, `${Number(((y / 480) * 100).toFixed(4))}%`];

    it('draws each readout where the original draws it, in the font the original uses, and keeps the words in the page', async () => {
      const port = chosen();
      port.fonts = fonts;
      show(port);
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(root.querySelector('.au-astro')!.hasAttribute('data-bitmap')).toBe(true);
      const all = canvases();
      const find = (text: string) => all.find(c => c[0] === text);
      expect(find('ALPHA 1-2-3')).toEqual(['ALPHA 1-2-3', ...where(101, 1)]);
      expect(find('@E: 003')).toEqual(['@E: 003', ...where(16, 344)]);
      expect(find('@A: 006')).toEqual(['@A: 006', ...where(325, 344)]);
      // (the coordinates: the cursor's from x 197 and the ship's from x 318, 32 apart, y 417)
      expect(all.filter(c => c[2] === where(0, 417)[1]).map(c => c[1])).toEqual([197, 229, 261, 318, 350, 382].map(x => where(x, 0)[0]));
      expect(root.querySelector('[data-readout="title"]')!.textContent).toBe('ALPHA 1-2-3');
      expect(root.querySelector('[data-readout="elevation"]')!.textContent).toBe('°E: 003');
    });

    it('draws the speed at 425 for warp and 578 for impulse, in the label font', async () => {
      const port = chosen();
      port.fonts = fonts;
      show(port);
      expect(canvases().find(c => c[0] === '5.0')).toEqual(['5.0', ...where(425, 97)]);
      await act(async () => { painted('impulse').click(); });
      expect(canvases().find(c => c[0] === '40%')).toEqual(['40%', ...where(578, 97)]);
    });

    it('draws the info panel\'s title at 399, 98 and its text wrapped to 223 pixels from y 134, 18 apart, twenty lines at most', async () => {
      const port = chosen();
      port.fonts = fonts;
      port.cam.panel = 'info';
      port.selectionInfo = () => ({ title: 'ALPHA', lines: [Array.from({ length: 30 }, () => 'word').join(' ')] });
      show(port);
      const lines = canvases().filter(c => c[1] === where(399, 0)[0]);
      expect(lines[0]).toEqual(['ALPHA', ...where(399, 98)]);
      // (4 pixels a letter: 223 holds 55 letters, so eleven 4-letter words and their spaces, 54, a line)
      expect(lines[1]![0]).toBe(Array.from({ length: 11 }, () => 'word').join(' '));
      expect(lines[1]![2]).toBe(where(0, 134)[1]);
      expect(lines[2]![2]).toBe(where(0, 134 + 18)[1]);
      expect(lines.length).toBeLessThanOrEqual(21);
    });

    it('draws the Display tab\'s labels at 528 beside their bars', async () => {
      const port = chosen();
      port.fonts = fonts;
      port.cam.panel = 'display';
      show(port);
      const labels = canvases().filter(c => c[1] === where(528, 0)[0]);
      expect(labels).toHaveLength(9);
      expect(labels[0]).toEqual(['Stars', ...where(528, 102)]);
      expect(labels[8]![2]).toBe(where(0, 332)[1]);
    });

    it('keeps the CSS text without them', async () => {
      show(chosen());
      expect(root.querySelector('canvas.au-bt')).toBeNull();
      expect(root.querySelector('.au-astro')!.hasAttribute('data-bitmap')).toBe(false);
    });
  });

  describe('the screen\'s opening (start: the charts\' messages)', () => {
    it('shows its first opening message for a frame, then its third for a frame, then neither', async () => {
      // (the frames are stepped by hand)
      const frames: (() => void)[] = [];
      vi.stubGlobal('requestAnimationFrame', (cb: () => void) => frames.push(cb));
      vi.stubGlobal('cancelAnimationFrame', () => {});
      try {
        const port = chosen();
        port.messages = ['CALIBRATING STAR MAPS', 'EMPTY SKY', 'SYNCING THE NAVIGATION LOG', 'UNCHARTED SUN'];
        show(port);
        const said = () => root.querySelector<HTMLElement>('[data-opening]')?.textContent ?? null;
        expect(said()).toBe('CALIBRATING STAR MAPS');
        expect(root.querySelector<HTMLElement>('.au-astro-opening')!.style.left).toBe(`${Number(((80 / 640) * 100).toFixed(4))}%`);
        await act(async () => { frames.shift()!(); });
        expect(said()).toBe('SYNCING THE NAVIGATION LOG');
        expect(root.querySelector<HTMLElement>('.au-astro-opening')!.style.left).toBe(`${Number(((73 / 640) * 100).toFixed(4))}%`);
        await act(async () => { frames.shift()!(); });
        expect(said()).toBeNull();
      } finally {
        vi.unstubAllGlobals();
      }
    });
    it('says nothing without the executable\'s messages', async () => {
      show(chosen());
      expect(root.querySelector('[data-opening]')).toBeNull();
    });
  });
});

describe('formatTime', () => {
  it('leaves out leading zero units', () => {
    expect(formatTime({ ...NO_TIME, months: 1, days: 16, hours: 14 })).toBe('1mo 16d 14h');
    expect(formatTime(NO_TIME)).toBe('0s');
  });
});
