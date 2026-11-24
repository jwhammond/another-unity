// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import type { TransporterRoom } from '../../sim/transporter';
import type { ShipPort } from '../../web/shipPort';
import type { TransporterMapView } from '../../web/transporterDirector';
import { TransporterPanel } from './transporter';

type Areas = Record<string, [number, number, number, number]>;

function fakePort(target: string | null = 'x', areas: Areas | null = null) {
  const listeners = new Set<() => void>();
  const calls: string[] = [];
  const room: TransporterRoom = {
    target, world: 4, pads: [null, null, null, null], crew: ['a', 'b'], equipment: ['hypo'], kit: ['phaser'],
    movedByHand: { medkit: false, medicalTricorder: false }, roles: {},
  };
  const change = () => { for (const l of listeners) l(); };
  const sounds: string[] = [];
  // (the lists up: the map is what the sessions open on, these tests start from the lists)
  const map: TransporterMapView = { showing: false, hasTarget: target !== null, world: target !== null ? 4 : 0, locked: false, across: [51, 297, 366, 2], down: null, blip: null, blipTime: 0 };
  let walkingPads: number[] = [];
  const walking = () => walkingPads;
  const port = {
    calls, room, sounds, map, change, walk: (pads: number[]) => { walkingPads = pads; },
    transporterShowMap: (show: boolean) => { calls.push(`map ${show}`); map.showing = show; change(); },
    sprites: null as null | { sprite: (name: string) => { url: string; rect: readonly [number, number, number, number] }; map?: () => unknown },
    icons: {} as Record<string, string>,
    transporterSprites: () => port.sprites,
    itemIcon: (id: string) => port.icons[id],
    sound: (name: string) => { sounds.push(name); },
    transporter: () => ({ room, map, walking: walking(), name: (id: string) => `-${id}-`, canEnergize: room.target !== null && room.pads.some(p => p !== null), exits: [{ code: 0, label: '-Bridge-' }] }),
    recommend: async () => { calls.push('recommend'); room.pads[0] = 'a'; room.crew = ['b']; change(); },
    pad: async (c: string) => { calls.push(`pad ${c}`); },
    unpad: async (i: number) => { calls.push(`unpad ${i}`); room.pads[i] = null; change(); },
    kit: async (i: string) => { calls.push(`kit ${i}`); },
    unkit: async (i: string) => { calls.push(`unkit ${i}`); },
    energize: async () => { calls.push('energize'); },
    leave: async (code: number) => { calls.push(`leave ${code}`); },
    shipPlate: () => (areas === null ? null : { areas }),
    transporterPads: () => room.pads.map((crew, pad) => ({ pad, rect: [225 + 51 * pad, 85, 276 + 51 * pad, 231] as [number, number, number, number], stand: [250 + 51 * pad, 231] as [number, number], scale: 240, crew })),
    screenRect: (box: unknown) => { calls.push(box === null ? 'box off' : 'box on'); },
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
  };
  return port;
}

describe('TransporterPanel', () => {
  let root: HTMLElement;
  afterEach(() => {
    render(null, root);
    root.remove();
  });
  function show(port: ReturnType<typeof fakePort>) {
    root = document.body.appendChild(document.createElement('div'));
    act(() => { render(<TransporterPanel port={port as unknown as ShipPort} />, root); });
  }
  const button = (text: string) => [...root.querySelectorAll('button')].find(b => b.textContent === text) as HTMLButtonElement;
  const click = (el: Element) => act(() => { (el as HTMLElement).click(); });

  it('Recommended fills the pads', () => {
    const port = fakePort();
    show(port);
    expect(root.querySelectorAll('[data-pad]').length).toBe(0);
    click(button('Recommended'));
    expect(port.calls).toEqual(['recommend']);
    expect(root.querySelector('[data-pad="0"]')?.textContent).toBe('-a-');
  });

  it('clicking a crew member on a pad removes them', () => {
    const port = fakePort();
    port.room.pads[0] = 'a';
    show(port);
    click(root.querySelector('[data-pad="0"]')!);
    expect(port.calls).toEqual(['unpad 0']);
    expect(root.querySelector('[data-pad="0"]')).toBeNull();
  });

  it('puts crew on pads and items in the kit by clicking them', () => {
    const port = fakePort();
    show(port);
    click(root.querySelector('[data-crew="b"]')!);
    click(root.querySelector('[data-item="hypo"]')!);
    click(root.querySelector('[data-kit="phaser"]')!);
    expect(port.calls).toEqual(['pad b', 'kit hypo', 'unkit phaser']);
  });

  it('Energize is disabled until someone is on a pad', () => {
    const port = fakePort();
    show(port);
    expect(button('Energize').disabled).toBe(true);
    click(button('Recommended'));
    expect(button('Energize').disabled).toBe(false);
    click(button('Energize'));
    expect(port.calls).toEqual(['recommend', 'energize']);
  });

  it('says so with no target, and a transporter exit calls leave', () => {
    const port = fakePort(null);
    port.room.pads[0] = 'a';
    show(port);
    expect(root.textContent).toContain('No transporter target');
    expect(button('Energize').disabled).toBe(true);
    click(button('-Bridge-'));
    expect(port.calls).toEqual(['leave 0']);
  });

  describe('with a plate (R16)', () => {
    const AREAS: Areas = { equipment: [50, 300, 150, 115], crew: [267, 300, 151, 115], kit: [71, 424, 503, 48], controls: [419, 291, 124, 124], exits: [545, 297, 94, 40] };
    const inside = (el: HTMLElement, rect: [number, number, number, number]) => {
      const pct = (v: string) => parseFloat(v);
      const [l, t, w, h] = [pct(el.style.left), pct(el.style.top), pct(el.style.width), pct(el.style.height)];
      return l >= (rect[0] / 640) * 100 - 0.01 && t >= (rect[1] / 480) * 100 - 0.01 && l + w <= ((rect[0] + rect[2]) / 640) * 100 + 0.01 && t + h <= ((rect[1] + rect[3]) / 480) * 100 + 0.01;
    };
    const snapshot = () => [...root.querySelectorAll('button')].map(b => [b.textContent, b.disabled, ...b.getAttributeNames().filter(n => n.startsWith('data-')).map(n => `${n}=${b.getAttribute(n)}`)].join('|'));
    const withPads = () => {
      const port = fakePort('x', AREAS);
      port.room.pads[0] = 'a';
      port.room.pads[2] = 'b';
      return port;
    };

    it('renders the same buttons, labels, order and data-* with a plate and without', () => {
      show(withPads());
      const plated = snapshot();
      render(null, root);
      root.remove();
      const flatPort = fakePort('x', null);
      flatPort.room.pads[0] = 'a';
      flatPort.room.pads[2] = 'b';
      show(flatPort);
      expect(plated.length).toBeGreaterThan(5);
      expect(plated).toEqual(snapshot());
    });

    it('puts each section inside its area, over an opaque ground, in a 4:3 box that registers itself', () => {
      const port = withPads();
      show(port);
      const box = root.querySelector('.au-ship-screen') as HTMLElement;
      expect(box.style.aspectRatio).toMatch(/640\s*\/\s*480/);
      expect(port.calls).toContain('box on');
      const sectionArea = (label: string) => root.querySelector(`[aria-label="${label}"]`) as HTMLElement;
      const want: Record<string, string> = { Equipment: 'equipment', Crew: 'crew', Kit: 'kit', Exits: 'exits' };
      for (const [label, area] of Object.entries(want)) {
        const el = sectionArea(label);
        expect(el.dataset.area).toBe(area);
        expect(el.classList.contains('au-area')).toBe(true);
        expect(inside(el, AREAS[area]!)).toBe(true);
      }
      // (the console's sliders show: Energize is a clear button over them, each pad's crew a clear button over the pad, Recommended under the exits)
      expect(root.querySelector('[data-area="controls"]')).toBeNull();
      const energize = root.querySelector<HTMLElement>('[data-painted="sliders"]')!;
      expect(energize.getAttribute('aria-label')).toBe('Energize');
      expect(energize.parentElement!.style.left).toBe(`${Number(((418 / 640) * 100).toFixed(4))}%`);
      const pad = root.querySelector<HTMLElement>('[data-pad="0"]')!;
      expect(pad.parentElement!.dataset.area).toBe('pad-0');
      expect(pad.parentElement!.style.top).toBe(`${Number(((85 / 480) * 100).toFixed(4))}%`);
      expect(button('Recommended').parentElement!.dataset.area).toBe('recommended');
      // every button is in an area, but the painted ones, which sit at their own places
      for (const b of root.querySelectorAll('button')) if (!b.dataset.painted) expect(b.closest('[data-area]')).not.toBeNull();
      // the headings stay in the tree, visually hidden
      expect([...root.querySelectorAll('h2, h3')].map(h => h.textContent)).toEqual(['Transporter room', 'Pads', 'Crew', 'Equipment', 'Kit']);
      for (const h of root.querySelectorAll('h2, h3')) expect(h.classList.contains('au-visually-hidden')).toBe(true);
    });

    it('is the flat panel without a plate: no box, no areas, visible headings; a plate without the areas stays flat for those sections', () => {
      const port = fakePort('x', null);
      show(port);
      expect(root.querySelector('.au-ship-screen')).toBeNull();
      expect(root.querySelector('[data-area]')).toBeNull();
      expect(root.querySelector('h3')?.classList.contains('au-visually-hidden')).toBe(false);
      expect(port.calls).not.toContain('box on');
    });

    it('cannot take a crew member off a pad while they are walking on or off it', () => {
      const port = withPads();
      port.walk([2]);
      show(port);
      expect(root.querySelector<HTMLButtonElement>('[data-pad="0"]')!.disabled).toBe(false);
      expect(root.querySelector<HTMLButtonElement>('[data-pad="2"]')!.disabled).toBe(true);
    });

    it('keeps the handlers: a click on a plated button calls the same port method', () => {
      const port = withPads();
      show(port);
      click(root.querySelector('[data-pad="0"]')!);
      click(root.querySelector('[data-crew="b"]')!);
      click(button('Recommended'));
      expect(port.calls).toEqual(['box on', 'unpad 0', 'pad b', 'recommend']);
    });

    it('puts the painted buttons at their places: Map and Lists switch the view, the door offers the exits, the arrows scroll', async () => {
      const port = fakePort('x', AREAS);
      show(port);
      const painted = (id: string) => root.querySelector<HTMLButtonElement>(`[data-painted="${id}"]`)!;
      expect(painted('door').parentElement!.style.left).toBe(`${Number(((63 / 640) * 100).toFixed(4))}%`);
      expect(painted('kitRight').parentElement!.style.top).toBe(`${Number(((424 / 480) * 100).toFixed(4))}%`);
      expect(painted('lists').getAttribute('aria-pressed')).toBe('true');
      click(painted('map'));
      expect(port.calls).toEqual(['box on', 'map true']);
      click(painted('lists'));
      const equipment = root.querySelector<HTMLElement>('section[aria-label="Equipment"] ul')!;
      click(root.querySelector('section[aria-label="Equipment"]')!);
      equipment.scrollTop = 50;
      click(painted('listUp'));
      expect(equipment.scrollTop).toBeLessThan(50);
      click(painted('door'));
      // (the door opens with its list, transporter.cpp:300)
      expect(port.sounds).toEqual(['doorOpen']);
      await act(async () => { root.querySelector<HTMLButtonElement>('[data-door-code="0"]')!.click(); });
      expect(root.querySelector('[data-door-code]')).toBeNull();
      expect(port.calls).toEqual(['box on', 'map true', 'map false', 'leave 0']);
    });

    describe('with the original\'s pictures (art.transporter) and the items\' icons', () => {
      const SIZES: Record<string, [number, number]> = { kit_slot: [52, 48], up: [48, 23], down: [48, 23], left: [25, 49], right: [25, 49] };
      const X: Record<string, number> = { up: 210, down: 210, left: 297, right: 321, kit_slot: 71 };
      const spritesFor = () => ({
        map: () => undefined as undefined | { world: (n: number) => { url: string; rect: readonly [number, number, number, number] } | undefined; across: { url: string; rect: readonly [number, number, number, number] }; down: { url: string; rect: readonly [number, number, number, number] }; blip: { frames: { url: string; rect: readonly [number, number, number, number] }[]; ms: number } },
        sprite: (name: string) => {
          const base = name.replace('_grey', '');
          const [w, h] = SIZES[base] ?? [42, 58];
          return { url: `/s/${name}.webp`, rect: [X[base] ?? 7, base === 'down' ? 383 : base === 'up' ? 359 : 424, w, h] as const };
        },
      });
      /** Gives the three scrolling lists a height and a scroll position, as a browser would have laid them out. */
      const laidOut = (heights: { scrollHeight: number; clientHeight: number }) => {
        for (const el of root.querySelectorAll<HTMLElement>('section ul')) {
          Object.defineProperty(el, 'scrollHeight', { configurable: true, value: heights.scrollHeight });
          Object.defineProperty(el, 'clientHeight', { configurable: true, value: heights.clientHeight });
        }
      };
      const sprite = (id: string) => root.querySelector<HTMLElement>(`[data-sprite="${id}"] img`)?.getAttribute('src');

      it('draws the eight kit slots at the original\'s places, and the Lists and Map buttons and the arrows at theirs', () => {
        const port = fakePort('x', AREAS);
        port.sprites = spritesFor();
        show(port);
        const slots = [...root.querySelectorAll<HTMLElement>('[data-sprite="kit_slot"]')];
        expect(slots.map(el => Math.round((parseFloat(el.style.left) / 100) * 640))).toEqual([71, 125, 179, 233, 357, 411, 465, 519]);
        expect(slots.every(el => Math.round((parseFloat(el.style.top) / 100) * 480) === 424)).toBe(true);
        // (the lists are the ones shown, so Lists is lit; the map is not built, so Map is not)
        expect(sprite('lists')).toBe('/s/lists_on.webp');
        expect(sprite('map')).toBe('/s/map.webp');
        // (the painted buttons still do their work, over the pictures)
        expect(root.querySelector('[data-painted="lists"]')!.getAttribute('aria-pressed')).toBe('true');
      });

      it('greys an arrow where its list has no more, and lights it where it has', () => {
        const port = fakePort('x', AREAS);
        port.sprites = spritesFor();
        show(port);
        // (nothing to scroll: all four grey)
        expect([sprite('listUp'), sprite('listDown'), sprite('kitLeft'), sprite('kitRight')]).toEqual(['/s/up_grey.webp', '/s/down_grey.webp', '/s/left_grey.webp', '/s/right_grey.webp']);
        // (more below: down and right light; scrolled a little: up and left too)
        act(() => { laidOut({ scrollHeight: 200, clientHeight: 100 }); });
        act(() => { for (const el of root.querySelectorAll('section ul')) el.dispatchEvent(new Event('scroll')); });
        expect([sprite('listDown'), sprite('kitRight')]).toEqual(['/s/down.webp', '/s/right.webp']);
        const equipment = root.querySelector<HTMLElement>('section[aria-label="Equipment"] ul')!;
        click(root.querySelector('section[aria-label="Equipment"]')!);
        equipment.scrollTop = 40;
        act(() => { equipment.dispatchEvent(new Event('scroll')); });
        expect(sprite('listUp')).toBe('/s/up.webp');
      });

      it('shows the kit\'s items as their icons (the name kept for the screen reader), and the equipment pointed at in the preview box', () => {
        const port = fakePort('x', AREAS);
        port.sprites = spritesFor();
        port.icons = { phaser: '/i/phaser.webp', hypo: '/i/hypo.webp' };
        show(port);
        const kit = root.querySelector<HTMLButtonElement>('[data-kit="phaser"]')!;
        expect(kit.querySelector('img')!.getAttribute('src')).toBe('/i/phaser.webp');
        expect(kit.textContent).toBe('-phaser-');
        expect(kit.querySelector('.au-visually-hidden')!.textContent).toBe('-phaser-');
        // (nothing pointed at yet: the socket is empty, as the original's is until an equipment row is chosen)
        expect(root.querySelector('[data-preview]')).toBeNull();
        act(() => { root.querySelector('[data-item="hypo"]')!.dispatchEvent(new Event('pointerenter')); });
        const preview = root.querySelector<HTMLElement>('[data-preview="hypo"]')!;
        expect(preview.querySelector('img')!.getAttribute('src')).toBe('/i/hypo.webp');
        expect(Math.round((parseFloat(preview.style.left) / 100) * 640)).toBe(208);
      });

      it('has no preview for an item without an icon, and the kit item is its name', () => {
        const port = fakePort('x', AREAS);
        port.sprites = spritesFor();
        show(port);
        act(() => { root.querySelector('[data-item="hypo"]')!.dispatchEvent(new Event('pointerenter')); });
        expect(root.querySelector('[data-preview]')).toBeNull();
        expect(root.querySelector('[data-kit="phaser"]')!.querySelector('img')).toBeNull();
      });

      describe('the map (transporter.cpp showMap and updateLock)', () => {
        const at = (id: string) => root.querySelector<HTMLElement>(`[data-map="${id}"]`);
        const px = (el: HTMLElement) => [parseFloat(el.style.left) / 100 * 640, parseFloat(el.style.top) / 100 * 480, parseFloat(el.style.width) / 100 * 640, parseFloat(el.style.height) / 100 * 480].map(Math.round);
        const mapArt = () => ({
          world: (n: number) => (n < 9 ? { url: `/s/map_world_${n}.webp`, rect: [50, 294, 368, 120] as const } : undefined),
          across: { url: '/s/scan_across.webp', rect: [51, 297, 366, 2] as const },
          down: { url: '/s/scan_down.webp', rect: [51, 296, 2, 118] as const },
          blip: { frames: [0, 1, 2].map(i => ({ url: `/s/blip_${i}.webp`, rect: [0, 0, 38, 38] as const })), ms: 100 },
        });

        it('puts the lists, their arrow and the preview away while it is up, and the Lists button is the one not lit', () => {
          const port = fakePort('x', AREAS);
          port.sprites = { ...spritesFor(), map: mapArt };
          port.icons = { hypo: '/i/hypo.webp' };
          port.map.showing = true;
          show(port);
          expect(root.querySelector<HTMLElement>('section[aria-label="Crew"]')!.hidden).toBe(true);
          expect(root.querySelector<HTMLElement>('section[aria-label="Equipment"]')!.hidden).toBe(true);
          expect(root.querySelector('[data-painted="listUp"], [data-painted="listDown"], [data-sprite="listUp"]')).toBeNull();
          // (the kit stays; Lists is the crew figure unlit, Map the planet lit)
          expect(root.querySelector<HTMLElement>('section[aria-label="Kit"]')!.hidden).toBe(false);
          expect(sprite('lists')).toBe('/s/lists.webp');
          expect(sprite('map')).toBe('/s/map_on.webp');
          expect(root.querySelector('[data-painted="map"]')!.getAttribute('aria-pressed')).toBe('true');
          click(root.querySelector('[data-painted="lists"]')!);
          expect(port.calls).toEqual(['box on', 'map false']);
          expect(root.querySelector<HTMLElement>('section[aria-label="Crew"]')!.hidden).toBe(false);
          expect(sprite('lists')).toBe('/s/lists_on.webp');
          expect(sprite('map')).toBe('/s/map.webp');
          expect(root.querySelector('[data-map]')).toBeNull();
        });

        it('draws the world\'s picture over the lists, the row line, and once found the column line and the blip\'s frame', () => {
          const port = fakePort('x', AREAS);
          port.sprites = { ...spritesFor(), map: mapArt };
          port.map.showing = true;
          show(port);
          expect(at('picture')!.querySelector('img')!.getAttribute('src')).toBe('/s/map_world_4.webp');
          expect(px(at('picture')!)).toEqual([50, 294, 368, 120]);
          expect(px(at('across')!)).toEqual([51, 297, 366, 2]);
          expect(at('down')).toBeNull();
          expect(at('blip')).toBeNull();
          port.map.across = [51, 339, 366, 2];
          port.map.down = [51, 296, 2, 118];
          act(() => port.change());
          expect(px(at('across')!)).toEqual([51, 339, 366, 2]);
          expect(px(at('down')!)).toEqual([51, 296, 2, 118]);
          Object.assign(port.map, { down: [213, 296, 2, 118], blip: [194, 320, 38, 38], locked: true, blipTime: 250 });
          act(() => port.change());
          expect(px(at('blip')!)).toEqual([194, 320, 38, 38]);
          expect(at('blip')!.querySelector('img')!.getAttribute('src')).toBe('/s/blip_2.webp');
          expect(root.querySelector('section[aria-label="Map"]')!.getAttribute('data-map-state')).toBe('locked');
          expect(root.querySelector('section[aria-label="Map"] [role="status"]')!.textContent).toBe('Target locked.');
        });

        it('has the picture for world 0 when there is no target, and no scan state to wait for', () => {
          const port = fakePort(null, AREAS);
          port.sprites = { ...spritesFor(), map: mapArt };
          port.map.showing = true;
          show(port);
          expect(at('picture')!.querySelector('img')!.getAttribute('src')).toBe('/s/map_world_0.webp');
          expect(root.querySelector('section[aria-label="Map"]')!.getAttribute('data-map-state')).toBe('none');
        });

        it('is a panel with CSS lines and a ring when the map\'s pictures are not published, and text on a flat panel', () => {
          const port = fakePort('x', AREAS);
          port.sprites = spritesFor();
          port.map.showing = true;
          port.map.down = [213, 296, 2, 118];
          port.map.blip = [194, 320, 38, 38];
          show(port);
          expect(root.querySelector('[data-map="picture"]')).toBeNull();
          expect(px(at('css')!)).toEqual([50, 294, 368, 120]);
          expect(at('css')!.textContent).toBe('Scanning for the target.');
          expect(px(at('down')!)).toEqual([213, 296, 2, 118]);
          expect(at('blip')!.querySelector('img')).toBeNull();
          render(null, root);
          root.remove();
          const flat = fakePort('x', null);
          flat.map.showing = true;
          show(flat);
          expect(root.querySelector('[data-map]')).toBeNull();
          expect(root.querySelector('section[aria-label="Map"] [role="status"]')!.textContent).toBe('Scanning for the target.');
        });
      });

      it('draws none of it without the pictures published, or without a plate', () => {
        const port = fakePort('x', AREAS);
        port.icons = { phaser: '/i/phaser.webp' };
        show(port);
        expect(root.querySelector('[data-sprite]')).toBeNull();
        // (the icons are still the kit's faces with a plate: they are a different art than the console's)
        expect(root.querySelector('[data-kit="phaser"] img')).not.toBeNull();
        render(null, root);
        root.remove();
        const flat = fakePort('x', null);
        flat.sprites = spritesFor();
        flat.icons = { phaser: '/i/phaser.webp' };
        show(flat);
        expect(root.querySelector('[data-sprite]')).toBeNull();
        expect(root.querySelector('img')).toBeNull();
        expect(root.querySelector('[data-kit="phaser"]')!.textContent).toBe('-phaser-');
      });
    });

  });
});
