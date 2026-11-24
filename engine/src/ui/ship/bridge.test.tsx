// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { miniShipContent } from '../../testing/ship';
import { newShipState, type ShipState, type Station } from '../../sim/ship';
import type { ShipPort } from '../../web/shipPort';
import { UiStore } from '../store';
import { bindSkipClick } from '../skipClick';
import { setHotspotLabels } from '../hotspotLabels';
import { fitStripLabel, labelScale, menuPlace, ShipPanel } from './bridge';
import type { SensorArt } from '../faces';
import { existsSync, readFileSync } from 'node:fs';

function fakePort() {
  const listeners = new Set<() => void>();
  const ship: ShipState = newShipState(miniShipContent());
  const calls: string[] = [];
  const port = {
    calls,
    away: false,
    ship: () => (port.away ? null : ship),
    over: null as number | null,
    refuse: false,
    station: async (name: Station) => {
      calls.push(`station ${name}`);
      if (port.refuse) throw new Error('Wait until nothing is happening, then try again.');
      ship.station = name;
      for (const l of listeners) l();
    },
    screen: async (code: number) => { calls.push(`screen ${code}`); },
    bridgeItems: () => [
      { object: 'a', label: 'Alpha', action: 'astrogation' as const, x: 64, y: 48, width: 32, height: 24 },
      { object: 'b', label: 'Beta', action: 'later' as const, x: 0, y: 0, width: 10, height: 10 },
      { object: 'c', label: 'Gamma', action: 'talk' as const, x: 320, y: 240, width: 64, height: 48 },
      { object: 'd', label: 'Lift', action: 'turbolift' as const, x: 560, y: 56, width: 70, height: 100 },
      { object: 'e', label: 'Console', action: 'computer' as const, x: 400, y: 200, width: 100, height: 30 },
      { object: 'f', label: 'Weapons', action: 'tactical' as const, x: 300, y: 140, width: 100, height: 50 },
      { object: 'g', label: 'Hail', action: 'comms' as const, x: 230, y: 140, width: 60, height: 50 },
      { object: 'h', label: 'Lounge door', action: 'lounge' as const, x: 0, y: 70, width: 50, height: 140 },
      { object: 'i', label: 'Again', action: 'replay' as const, x: 58, y: 423, width: 52, height: 48 },
    ],
    sectorName: () => '-Alpha-',
    readout: { transit: null, dest: null } as import('../../web/shipPort').StripReadout,
    stripReadout: () => port.readout,
    sectors: () => [],
    stars: () => [],
    selection: () => null,
    select: () => {},
    mapCamera: () => ({ view: 'galaxy' as const, panel: 'course' as const, azimuth: 0, elevation: 0, spinning: false, cursorSector: [0, 0, 0] as [number, number, number], cursor: [0, 0, 0] as [number, number, number], display: [] }),
    stopTransit: async () => {},
    mapPad: () => {}, mapCursor: () => {}, mapView: () => {}, mapPanel: () => {}, mapDisplay: () => {},
    selectionInfo: () => ({ title: '', lines: [] }),
    astroText: () => ({ title: '', cursor: [0, 0, 0] as [number, number, number], ship: [0, 0, 0] as [number, number, number], labels: null }),
    records: ['-One-', '-Two-'] as string[],
    scrolled: { up: false, down: true },
    sensor: null as SensorArt | null,
    sensorSprites: () => port.sensor,
    sensorRecords: () => ({ rows: port.records, up: port.scrolled.up, down: port.scrolled.down }),
    sensorScroll: (d: number) => { calls.push(`sensor scroll ${d}`); },
    sensorGo: async (row: number) => { calls.push(`sensor go ${row}`); },
    preview: () => 'nothing there' as const,
    engage: async () => null,
    transit: () => null,
    maxWarp: () => 940,
    impulseSteps: () => 4,
    exitsEnabled: () => true,
    turbolift: () => [{ code: 1, label: 'Down' }, { code: 0x66, label: 'Odd' }],
    held: false,
    preloaded: [] as string[][],
    shipHeld: () => port.held,
    preloadStations: (stations: string[]) => { port.preloaded.push(stations); },
    talk: async (object: string) => { calls.push(`talk ${object}`); },
    gameOver: () => port.over,
    ending: (reason: number) => (reason === 3 ? { won: true as const } : { won: false as const, text: '-Lost-' }),
    restart: async () => { calls.push('restart'); },
    view: null as { target: string | null; label: string } | null,
    viewscreen: () => port.view,
    transporter: () => (ship.station !== 'transporter' ? null : {
      room: { target: null, world: 0, pads: [null, null, null, null], crew: [], equipment: [], kit: [], movedByHand: { medkit: false, medicalTricorder: false }, roles: {} },
      walking: [] as number[],
      map: { showing: false, hasTarget: false, world: 0, locked: false, across: [51, 297, 366, 2] as [number, number, number, number], down: null, blip: null, blipTime: 0 },
      name: (id: string) => id, canEnergize: false, exits: [{ code: 0, label: 'Back to the bridge' }],
    }),
    transporterShowMap: () => {},
    recommend: async () => {}, pad: async () => {}, unpad: async () => {}, kit: async () => {}, unkit: async () => {},
    energize: async () => {},
    movies: [{ stem: 'a', title: '-Tour-' }, { stem: 'b', title: '-Warp-' }] as { stem: string; title: string }[],
    holodeck: () => (ship.station !== 'holodeck' ? null : { movies: port.movies }),
    holodeckPlay: async (stem: string) => { calls.push(`holodeck play ${stem}`); },
    holodeckLeave: async () => { calls.push('holodeck leave'); ship.station = 'bridge'; for (const l of listeners) l(); },
    engineering: () => null, engineeringSlider: () => {}, engineeringDelegate: () => {}, holodeckArt: () => null, exitCursor: () => 'pointer', astroFonts: () => null,
    leave: async () => { ship.station = 'bridge'; for (const l of listeners) l(); },
    comp: null as null | { rows: { entry: number; child: boolean; title: string; selected: boolean }[]; heading: string; text: string; canScrollUp: boolean; canScrollDown: boolean },
    computer: () => port.comp,
    computerRow: async () => {}, computerScroll: async () => {}, computerLeave: async () => {},
    pickable: [{ object: 'x', label: '-Zap-' }] as { object: string; label: string }[],
    contacts: (_which: 'comms' | 'lounge') => port.pickable,
    comms: async (o: string | null) => { calls.push(`comms ${o}`); },
    lounge: async (o: string | null) => { calls.push(`lounge ${o}`); },
    combat: () => null, resolve: async () => {}, answerHail: async () => {},
    up: false,
    crewOnBridge: () => [] as string[],
    screenRect: (box: (() => DOMRect | null) | null) => { port.box = box; },
    box: null as (() => DOMRect | null) | null,
    art: false,
    shipArt: (_station: string) => port.art,
    shipPlate: (_station: string) => (port.art ? { areas: {} } : null),
    hotspots: () => false,
    astroSprites: () => null,
    transporterSprites: () => null,
    itemIcon: (_id: string) => undefined,
    viewscreenUp: () => port.up,
    viewscreenImage: () => ({ kind: 'space' as const }),
    transporterPads: () => [],
    adminMenu: () => { calls.push('admin'); },
    sounds: [] as string[],
    sound: (name: string) => { port.sounds.push(name); },
    toggleViewscreen: () => { port.up = !port.up; for (const l of listeners) l(); },
    conversationLog: () => [] as { speaker: string; text: string }[][],
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
  };
  return port;
}

const shipCss = readFileSync([`${process.cwd()}/engine/src/ui/ship/ship.css`, `${process.cwd()}/src/ui/ship/ship.css`].find(existsSync)!, 'utf8');

describe('ShipPanel', () => {
  let root: HTMLElement;
  afterEach(() => {
    render(null, root);
    root.remove();
  });
  function show(port: ShipPort) {
    root = document.body.appendChild(document.createElement('div'));
    act(() => { render(<ShipPanel port={port} />, root); });
  }
  const button = (name: string) => [...root.querySelectorAll('button')].find(b => b.textContent === name)!;

  it('shows the viewscreen in place of the station while a hail runs', () => {
    const port = fakePort();
    port.view = { target: 'a', label: '-Zap-' };
    show(port as unknown as ShipPort);
    expect(root.querySelector('[data-station="viewscreen"]')?.textContent).toBe('-Zap-');
    expect(root.querySelector('.au-ship-bridge')).toBeNull();
  });

  it('draws the bridge items at their rectangles', () => {
    show(fakePort());
    const a = root.querySelector<HTMLElement>('[data-object="a"]')!;
    expect(a.style.left).toBe('10%');
    expect(a.style.top).toBe('10%');
    expect(a.style.width).toBe('5%');
    expect(a.style.height).toBe('5%');
    expect(a.textContent).toBe('Alpha');
  });

  describe('a click while a line is spoken', () => {
    // a real click: the press, then the click on the same button
    const tap = (el: HTMLElement) => {
      const press = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 });
      el.dispatchEvent(press);
      el.click();
      return press;
    };

    it('skips the line and presses nothing; the next click presses the button', async () => {
      const port = fakePort();
      show(port as unknown as ShipPort);
      const store = new UiStore();
      let skipped = 0;
      const off = bindSkipClick(root, store, () => { skipped++; store.endSay(); });
      try {
        store.say({ who: 'someone', name: 'Someone', text: 'A synthetic line.' });
        const item = root.querySelector<HTMLButtonElement>('[data-object="a"]')!;
        let press!: MouseEvent;
        await act(async () => { press = tap(item); });
        expect(skipped).toBe(1);
        expect(press.defaultPrevented).toBe(true);
        expect(port.calls).toEqual([]);
        await act(async () => { tap(item); });
        expect(skipped).toBe(1);
        expect(port.calls).toEqual(['station astrogation']);
        // (a voiced line with text off has no box, and is skipped all the same)
        store.say({ who: 'someone', name: 'Someone', text: 'A synthetic line.' }, false);
        await act(async () => { tap(root.querySelector<HTMLElement>('button')!); });
        expect([skipped, port.calls.length]).toEqual([2, 1]);
      } finally {
        off();
      }
    });

    it('lets a press through when no line is up, and stops listening when taken off', async () => {
      const port = fakePort();
      show(port as unknown as ShipPort);
      const store = new UiStore();
      let skipped = 0;
      const off = bindSkipClick(root, store, () => { skipped++; });
      await act(async () => { tap(root.querySelector<HTMLButtonElement>('[data-object="c"]')!); });
      expect(port.calls).toEqual(['talk c']);
      store.say({ who: 'someone', name: 'Someone', text: 'Another.' });
      off();
      await act(async () => { tap(root.querySelector<HTMLButtonElement>('[data-object="c"]')!); });
      expect(skipped).toBe(0);
      expect(port.calls).toEqual(['talk c', 'talk c']);
    });
  });

  it('shows nothing while the team is away', () => {
    const port = fakePort();
    port.away = true;
    show(port);
    expect(root.textContent).toBe('');
  });

  it('goes to astrogation from its item, and shows the station', async () => {
    const port = fakePort();
    show(port);
    await act(async () => { root.querySelector<HTMLButtonElement>('[data-object="a"]')!.click(); });
    expect(port.calls).toEqual(['station astrogation']);
    expect(root.querySelector('[data-station="astrogation"]')).not.toBeNull();
    expect(root.textContent).toContain('Astrogation');
    await act(async () => { button('Back to the bridge').click(); });
    expect(root.querySelector('[data-station="bridge"]')).not.toBeNull();
  });

  it("with a plate drawn, keeps every item button's style percentages and handlers; adds au-ship-art only when a set is drawn", async () => {
    const flat = fakePort();
    show(flat);
    const style = (r: HTMLElement) => [...r.querySelectorAll<HTMLButtonElement>('.au-ship-item')].map(b => b.getAttribute('style'));
    const before = style(root);
    expect(root.querySelector('.au-ship-art')).toBeNull();
    // (the box registers its rect with the port while the bridge is up, and unregisters when it goes)
    expect(flat.box).not.toBeNull();
    const art = fakePort();
    art.art = true;
    act(() => { render(<ShipPanel port={art} />, root); });
    expect(root.querySelector('.au-ship.au-ship-art')).not.toBeNull();
    expect(style(root)).toEqual(before);
    expect(before[0]).toContain('left: 10%');
    await act(async () => { root.querySelector<HTMLButtonElement>('[data-object="c"]')!.click(); });
    expect(art.calls).toEqual(['talk c']);
    await act(async () => { root.querySelector<HTMLButtonElement>('[data-object="a"]')!.click(); });
    expect(art.calls.at(-1)).toBe('station astrogation');
    // (astrogation with a plate is `au-ship au-ship-art` too, not `au-ship-map`, and its box registers; with no plate it is the flat map panel)
    expect(root.querySelector('[data-station="astrogation"].au-ship.au-ship-art')).not.toBeNull();
    expect(root.querySelector('.au-ship-map')).toBeNull();
    expect(art.box).not.toBeNull();
    art.art = false;
    act(() => { render(<ShipPanel port={art} />, root); });
    expect(root.querySelector('[data-station="astrogation"].au-ship.au-ship-map')).not.toBeNull();
    expect(root.querySelector('.au-ship-art')).toBeNull();
    expect(art.box).toBeNull();
  });

  it('talks to a crew item through the port', async () => {
    const port = fakePort();
    show(port);
    await act(async () => { root.querySelector<HTMLButtonElement>('[data-object="c"]')!.click(); });
    expect(port.calls).toEqual(['talk c']);
  });

  it('makes the door sound as the turbolift list opens and shuts, and the replay\'s sound (bridge.cpp:387-440)', async () => {
    const port = fakePort();
    show(port);
    await act(async () => { button('Lift').click(); });
    await act(async () => { button('Lift').click(); });
    await act(async () => { button('Again').click(); });
    expect(port.sounds).toEqual(['doorOpen', 'doorClose', 'advice']);
  });

  it('opens the lounge door as the list comes up and closes it on Cancel', async () => {
    const port = fakePort();
    show(port);
    await act(async () => { button('Lounge door').click(); });
    await act(async () => { button('Cancel').click(); });
    expect(port.sounds).toEqual(['doorOpen', 'doorClose']);
  });

  it('shows the holodeck with the movies seen, plays one again on a click, and its Bridge button leaves', async () => {
    const port = fakePort();
    port.station('holodeck');
    show(port);
    expect(root.querySelector('[data-station="holodeck"]')).not.toBeNull();
    expect(root.querySelector('.au-ship-bridge')).toBeNull();
    expect([...root.querySelectorAll('.au-ship-movies button')].map(b => b.textContent)).toEqual(['-Tour-', '-Warp-']);
    await act(async () => { button('-Warp-').click(); });
    expect(port.calls).toContain('holodeck play b');
    await act(async () => { button('Bridge').click(); });
    expect(port.calls.at(-1)).toBe('holodeck leave');
    expect(root.querySelector('.au-ship-bridge')).not.toBeNull();
  });

  it('says so when nothing has been seen, and still offers the way out', () => {
    const port = fakePort();
    port.movies = [];
    port.station('holodeck');
    show(port);
    expect(root.textContent).toContain('Nothing has been seen yet.');
    expect(button('Bridge')).toBeTruthy();
  });

  it('opens the turbolift list by the pointer that clicked the door, not in a corner (runChoice)', async () => {
    const port = fakePort();
    show(port);
    await act(async () => { button('Lift').dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 300, clientY: 200, detail: 1 })); });
    const list = root.querySelector<HTMLElement>('[aria-label="Turbolift"]')!;
    expect(list.style.left).toBe('310px');
    expect(list.style.top).toBe('210px');
    // (no corner-pinning rule is left in the stylesheet for it)
    expect(shipCss).not.toMatch(/\.au-ship-lift \{[^}]*(right|bottom):/);
  });

  it('keeps a menu inside the box: back from the right and bottom edges, and never past the top left margin', () => {
    const box = { width: 640, height: 480 };
    const size = { width: 120, height: 100 };
    expect(menuPlace({ x: 100, y: 100 }, size, box)).toEqual({ x: 110, y: 110 });
    expect(menuPlace({ x: 630, y: 470 }, size, box)).toEqual({ x: 640 - 120 - 4, y: 480 - 100 - 4 });
    expect(menuPlace({ x: -50, y: -50 }, size, box)).toEqual({ x: 4, y: 4 });
    // (a box too small for it: the margin wins, it does not go negative)
    expect(menuPlace({ x: 10, y: 10 }, size, { width: 50, height: 50 })).toEqual({ x: 4, y: 4 });
  });

  it('starts loading the stations the turbolift goes to as its list opens, not as it shuts (B5)', async () => {
    const port = fakePort();
    show(port);
    await act(async () => { button('Lift').click(); });
    expect(port.preloaded).toEqual([['transporter']]);
    await act(async () => { button('Lift').click(); });
    expect(port.preloaded).toHaveLength(1);
  });

  it("keeps the last station's panel, still and inert, over the new one while its picture is held, and swaps them together (B5)", async () => {
    const port = fakePort();
    show(port);
    expect(root.querySelector('.au-ship-frozen')).toBeNull();
    port.held = true;
    await act(async () => { await port.station('transporter'); });
    const frozen = root.querySelector<HTMLElement>('.au-ship-frozen')!;
    const copy = frozen.firstElementChild as HTMLElement;
    // (the bridge as it was, inert, and named nothing; the new station's panel hidden under it)
    expect(copy.querySelector('.au-ship-bridge')).not.toBeNull();
    expect([copy.hasAttribute('inert'), copy.hasAttribute('data-station'), copy.getAttribute('role'), frozen.getAttribute('aria-hidden')]).toEqual([true, false, null, 'true']);
    expect(copy.querySelectorAll('[id], [for], [aria-label], [aria-pressed]')).toHaveLength(0);
    expect(root.querySelector('[data-station="transporter"]')!.classList.contains('au-ship-held')).toBe(true);
    expect(root.querySelectorAll('[data-station]')).toHaveLength(1);
    expect(shipCss).toMatch(/\.au-ship\.au-ship-held \{ visibility: hidden; \}/);
    // (a click on the copy does nothing)
    await act(async () => { (copy.querySelector('[data-object="d"]') as HTMLElement | null)?.click(); });
    expect(root.querySelector('[aria-label="Turbolift"]')).toBeNull();
    // (the picture is in: the copy goes and the panel shows, in the same render)
    port.held = false;
    await act(async () => { await port.station('transporter'); });
    expect(root.querySelector('.au-ship-frozen')).toBeNull();
    expect(root.querySelector('[data-station="transporter"]')!.classList.contains('au-ship-held')).toBe(false);
  });

  it('the held copy has no data-strip or data-object, and its strip buttons keep their size', async () => {
    const port = fakePort();
    port.art = true;
    port.sensor = { sprite: name => ({ url: `/s/${name}.webp`, rect: [484, 426, 129, 49] as const }) };
    show(port as unknown as ShipPort);
    port.held = true;
    await act(async () => { await port.station('transporter'); });
    const copy = root.querySelector<HTMLElement>('.au-ship-frozen > *')!;
    // (the live panel's strip and objects are the only ones a locator or a style by them finds)
    expect(copy.querySelectorAll('[data-strip], [data-strip-readout], [data-object]')).toHaveLength(0);
    const view = copy.querySelector<HTMLElement>('.au-ship-strip-btn.au-ship-strip-viewscreen')!;
    expect([view.classList.contains('au-ship-strip-pic'), view.classList.contains('au-ship-strip-copy')]).toEqual([true, true]);
    expect(view.style.width).toBe(`${(121 / 640) * 100}%`);
    expect(copy.querySelectorAll('.au-ship-strip-btn').length).toBe(copy.querySelectorAll('.au-ship-strip-copy').length);
    // (the rule that lays the picture button out as a block, with no border, still takes the copy's button)
    const selector = shipCss.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map(r => r.trim()).find(r => r.includes('.au-ship-strip-pic') && r.includes('display: block'))!.split('{')[0].trim();
    expect(view.matches(selector)).toBe(true);
  });

  it("a turbolift move's held copy shows no open list", async () => {
    const port = fakePort();
    show(port);
    await act(async () => { button('Lift').click(); });
    // (the move's picture is held from the choice on)
    port.held = true;
    await act(async () => { button('Down').click(); });
    expect(port.calls).toEqual(['station transporter']);
    const copy = root.querySelector<HTMLElement>('.au-ship-frozen > *')!;
    expect(copy.querySelector('.au-ship-bridge')).not.toBeNull();
    expect(copy.querySelector('.au-ship-choice, [data-code]')).toBeNull();
  });

  it("calls station for a turbolift entry that is a station, and screen for one that isn't", async () => {
    const port = fakePort();
    show(port);
    expect(root.querySelector('[aria-label="Turbolift"]')).toBeNull();
    await act(async () => { button('Lift').click(); });
    await act(async () => { button('Down').click(); });
    expect(port.calls).toEqual(['station transporter']);
    expect(root.querySelector('[aria-label="Turbolift"]')).toBeNull();
    await act(async () => { button('Back to the bridge').click(); });
    await act(async () => { button('Lift').click(); });
    await act(async () => { button('Odd').click(); });
    expect(port.calls.at(-1)).toBe('screen 102');
  });

  it('opens the computer from its item, and shows its panel in place of the bridge while it is open', async () => {
    const port = fakePort();
    show(port as unknown as ShipPort);
    await act(async () => { button('Console').click(); });
    expect(port.calls.at(-1)).toBe('station computer');
    port.comp = { rows: [{ entry: 0, child: false, title: '-Root-', selected: true }], heading: '', text: '', canScrollUp: false, canScrollDown: false };
    act(() => { render(<ShipPanel port={port as unknown as ShipPort} />, root); });
    expect(root.querySelector('[data-station="computer"]')).not.toBeNull();
    expect(root.querySelector('.au-ship-bridge')).toBeNull();
  });

  it('goes to tactical from its item', async () => {
    const port = fakePort();
    show(port as unknown as ShipPort);
    await act(async () => { button('Weapons').click(); });
    expect(port.calls).toEqual(['station tactical']);
  });

  it('opens Replay from its item', async () => {
    const port = fakePort();
    show(port as unknown as ShipPort);
    await act(async () => { button('Again').click(); });
    expect(root.querySelector('[aria-label="Replay"]')?.textContent).toContain('No records');
  });

  it('does nothing for an item that is not built', async () => {
    const port = fakePort();
    show(port);
    await act(async () => { root.querySelector<HTMLButtonElement>('[data-object="b"]')!.click(); });
    expect(port.calls).toEqual([]);
  });

  it('names the plate\'s items as hotspots only while labels are on', async () => {
    const art = fakePort();
    art.art = true;
    show(art as unknown as ShipPort);
    expect(root.querySelector('.au-ship-hotspots')).toBeNull();
    act(() => setHotspotLabels(true));
    expect(root.querySelector('.au-ship.au-ship-art.au-ship-hotspots')).not.toBeNull();
    act(() => setHotspotLabels(false));
    expect(root.querySelector('.au-ship-hotspots')).toBeNull();
  });

  it('has no bar of stations: the tableau and the turbolift reach them', () => {
    show(fakePort());
    expect(root.querySelector('.au-ship-bar')).toBeNull();
    for (const name of ['Astrogation', 'Transporter room', 'Turbolift', 'Computer', 'Replay', 'Comms', 'Lounge', 'Tactical', 'Engineering', 'Log']) {
      expect(button(name)).toBeUndefined();
    }
  });

  it("puts the original's own strip buttons in the strip, at their places in its box", async () => {
    const port = fakePort();
    show(port as unknown as ShipPort);
    const strip = root.querySelector<HTMLElement>('.au-ship-strip[data-area="strip"]')!;
    expect(strip.style.top).toBe('75.8333%');
    expect(strip.style.height).toBe('24.1667%');
    const view = strip.querySelector<HTMLButtonElement>('[data-strip="viewscreen"]')!;
    const admin = strip.querySelector<HTMLButtonElement>('[data-strip="admin"]')!;
    expect(view.textContent).toBe('Viewscreen');
    expect(view.style.left).toBe(`${(484 / 640) * 100}%`);
    expect(view.style.top).toBe(`${((426 - 364) / 116) * 100}%`);
    expect(admin.style.left).toBe(`${(3 / 640) * 100}%`);
    await act(async () => { admin.click(); });
    expect(port.calls).toEqual(['admin']);
  });

  it('has the sensor records\' painted arrows and rows, showing the records and greying the arrows at the ends', async () => {
    const port = fakePort();
    show(port as unknown as ShipPort);
    const up = root.querySelector<HTMLButtonElement>('[data-strip="sensor-up"]')!;
    const down = root.querySelector<HTMLButtonElement>('[data-strip="sensor-down"]')!;
    expect(up.style.left).toBe(`${(117 / 640) * 100}%`);
    expect(root.querySelector<HTMLElement>('[data-strip="sensor-row-2"]')!.style.top).toBe(`${((463 - 364) / 116) * 100}%`);
    expect(root.querySelector('[data-strip-readout="record-0"]')?.textContent).toBe('-One-');
    expect(root.querySelector('[data-strip-readout="record-1"]')?.textContent).toBe('-Two-');
    expect(root.querySelector('[data-strip-readout="record-2"]')).toBeNull();
    expect(up.hasAttribute('data-end')).toBe(true);
    expect(down.hasAttribute('data-end')).toBe(false);
    await act(async () => { up.click(); down.click(); root.querySelector<HTMLButtonElement>('[data-strip="sensor-row-1"]')!.click(); });
    expect(port.calls).toEqual(['sensor scroll 1', 'sensor scroll -1', 'sensor go 1']);
  });

  it('draws what the original draws over the strip, visible with the hotspots off', () => {
    const port = fakePort();
    port.art = true;
    show(port as unknown as ShipPort);
    expect(root.querySelector('.au-ship-hotspots')).toBeNull();
    const view = root.querySelector<HTMLButtonElement>('[data-strip="viewscreen"]')!;
    // (the name stays for assistive tech, and the face shows it as a word)
    expect(view.textContent).toBe('Viewscreen');
    expect(view.getAttribute('aria-pressed')).toBe('false');
    expect(view.classList.contains('au-ship-strip-viewscreen')).toBe(true);
    // (the stylesheet blanks the other plate controls' labels with the hotspots off; the Viewscreen face is a later, more specific rule that sets its own colour)
    const rule = (selector: string) => shipCss.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map(r => r.trim()).filter(r => r.startsWith(selector)).map(r => r.slice(r.indexOf('{') + 1)).join(';');
    const blank = rule('.au-ship.au-ship-art:not(.au-ship-hotspots) .au-ship-item');
    expect(blank).toContain('color: transparent');
    const face = rule('.au-ship.au-ship-art .au-ship-strip-viewscreen, .au-ship.au-ship-art:not(.au-ship-hotspots) .au-ship-strip-viewscreen');
    expect(face).toMatch(/color: #[0-9a-f]{3,6}/);
    expect(face).not.toContain('transparent');
    expect(shipCss.indexOf('.au-ship-strip-viewscreen {')).toBeGreaterThan(shipCss.indexOf('.au-ship-strip-btn { color: transparent'));
    expect(root.querySelector('[data-strip-readout="sector"]')?.textContent).toBe('SECTOR: -Alpha-');
  });

  it('draws the Viewscreen button as the original\'s picture, pressed while the viewscreen is up, with its name kept but hidden', () => {
    const port = fakePort();
    port.art = true;
    port.sensor = { sprite: name => ({ url: `/s/${name}.webp`, rect: [484, 426, 129, 49] as const }) };
    show(port as unknown as ShipPort);
    const view = () => root.querySelector<HTMLButtonElement>('[data-strip="viewscreen"]')!;
    expect(view().classList.contains('au-ship-strip-pic')).toBe(true);
    const art = () => view().querySelector<HTMLElement>('.au-ship-strip-art')!;
    expect(art().style.backgroundImage).toContain('/s/viewscreen.webp');
    // (the button keeps the original's 121 x 42 hit rect; the picture is its own 129 x 49 and takes no clicks)
    expect(view().style.width).toBe(`${(121 / 640) * 100}%`);
    expect(view().style.height).toBe(`${(42 / 116) * 100}%`);
    expect(art().style.width).toBe(`${(129 / 121) * 100}%`);
    expect(art().style.height).toBe(`${(49 / 42) * 100}%`);
    expect(shipCss).toMatch(/\.au-ship-strip-art \{[^}]*pointer-events: none/);
    expect(view().getAttribute('aria-label')).toBe('Viewscreen');
    const name = view().querySelector('.au-visually-hidden')!;
    expect(name.textContent).toBe('Viewscreen');
    expect(view().querySelector('.au-ship-strip-label')).toBeNull();
    expect(shipCss).toMatch(/\.au-visually-hidden \{[^}]*clip: rect\(0 0 0 0\)/);
    act(() => { view().click(); });
    expect(view().getAttribute('aria-pressed')).toBe('true');
    expect(art().style.backgroundImage).toContain('/s/viewscreenDown.webp');
    // (the other strip buttons stay as they were)
    expect(root.querySelector('[data-strip="admin"] .au-ship-strip-art')).toBeNull();
  });

  it('draws the Viewscreen button\'s word, fitted to the box, when there is no picture', () => {
    const port = fakePort();
    port.art = true;
    show(port as unknown as ShipPort);
    const view = root.querySelector<HTMLButtonElement>('[data-strip="viewscreen"]')!;
    expect(view.style.backgroundImage).toBe('');
    expect(view.querySelector('.au-ship-strip-label')?.textContent).toBe('Viewscreen');
    expect(shipCss).toMatch(/\.au-ship-strip-label \{[^}]*white-space: nowrap/);
  });

  it('keeps the fallback word inside the button with Arial\'s width (about 7.02 em against the 6.40 em the box has)', () => {
    // (the investigation's measurements, b3-button-arial.png: Arial 7.02 em, Arial Narrow 5.81 em, the room (121/640 - 2 x 0.005) / 0.028)
    const room = (121 / 640 - 2 * 0.005) / 0.028;
    expect(room).toBeCloseTo(6.40, 1);
    const arial = labelScale(7.02, room);
    expect(arial).toBeLessThan(1);
    expect(7.02 * arial).toBeLessThanOrEqual(room + 1e-9);
    expect(labelScale(5.81, room)).toBe(1);
    expect(labelScale(0, room)).toBe(1);
    // (and measured through the elements: a 10px font, the word 70.2px wide in a 64px box)
    const box = document.createElement('button');
    const label = document.createElement('span');
    label.style.fontSize = '10px';
    box.append(label);
    document.body.append(box);
    Object.defineProperty(box, 'clientWidth', { value: 64 });
    // (the width follows the size it is set to, and rounds up a little: 1px)
    label.getBoundingClientRect = () => ({ width: label.style.fontSize === '' ? 70.2 : 70.2 * parseFloat(label.style.fontSize) + 1 } as DOMRect);
    fitStripLabel(label, box);
    expect(parseFloat(label.style.fontSize)).toBeLessThan(1);
    expect(label.style.fontSize.endsWith('em')).toBe(true);
    expect(parseFloat(label.style.fontSize) * 70.2).toBeLessThanOrEqual(64.01 - 1);
    // (a word that fits is left alone)
    label.getBoundingClientRect = () => ({ width: 58.1 } as DOMRect);
    fitStripLabel(label, box);
    expect(label.style.fontSize).toBe('');
    box.remove();
  });

  it('shows the journey readouts only while travelling or arrived, and names the item under the pointer', () => {
    const port = fakePort();
    show(port);
    const text = (k: string) => root.querySelector(`[data-strip-readout="${k}"]`)?.textContent;
    expect(text('speed')).toBeUndefined();
    expect(text('dest')).toBeUndefined();
    expect(text('hover')).toBe('');
    render(null, root);
    port.readout = { transit: { warp: true, speed: 450, lightYears: 12.34 }, dest: { arriving: true, name: '-Star-' } };
    show(port);
    expect(text('speed')).toMatch(/^(WARP: 4\.5|LY: {1,2}12\.3)$/);
    expect(text('dest')).toBe('DEST: -Star-');
    render(null, root);
    port.readout = { transit: null, dest: { arriving: false, name: '-Star-' } };
    show(port);
    expect(text('dest')).toBe('ARR: -Star-');
    const a = root.querySelector<HTMLElement>('[data-object="a"]')!;
    act(() => { a.dispatchEvent(new Event('pointerover')); a.dispatchEvent(new Event('pointerenter')); });
    expect(text('hover')).toBe('Alpha');
    act(() => { a.dispatchEvent(new Event('pointerleave')); });
    expect(text('hover')).toBe('');
  });

  it('says so when a station change is refused, and stays on the bridge', async () => {
    const port = fakePort();
    port.refuse = true;
    show(port);
    await act(async () => { button('Alpha').click(); });
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('Wait until nothing is happening');
    expect(root.querySelector('[data-station="bridge"]')).not.toBeNull();
  });

  it('ends the game with its reason and offers a new one', async () => {
    const port = fakePort();
    port.over = 2;
    show(port);
    expect(root.querySelector('[aria-label="Game over"]')).not.toBeNull();
    expect(root.textContent).toContain('-Lost-');
    await act(async () => { button('Start a new game').click(); });
    expect(port.calls).toEqual(['restart']);
  });

  it('opens a picker of names for Comms and for the lounge, and chooses through the port', async () => {
    const port = fakePort();
    show(port as unknown as ShipPort);
    await act(async () => { button('Hail').click(); });
    expect(root.querySelector('[aria-label="Comms"]')?.textContent).toContain('-Zap-');
    await act(async () => { button('-Zap-').click(); });
    expect(port.calls.at(-1)).toBe('comms x');
    expect(root.querySelector('[aria-label="Comms"]')).toBeNull();
    await act(async () => { button('Lounge door').click(); });
    await act(async () => { button('-Zap-').click(); });
    expect(port.calls.at(-1)).toBe('lounge x');
  });

  it('has the port say so at once when there is nobody to choose', async () => {
    const port = fakePort();
    port.pickable = [];
    show(port as unknown as ShipPort);
    await act(async () => { button('Hail').click(); });
    expect(port.calls.at(-1)).toBe('comms null');
    expect(root.querySelector('[aria-label="Comms"]')).toBeNull();
  });

  it("toggles the viewscreen, and with it up only the replay works", async () => {
    const port = fakePort();
    show(port as unknown as ShipPort);
    expect((root.querySelector('[data-object="a"]') as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { root.querySelector<HTMLButtonElement>('[data-strip="viewscreen"]')!.click(); });
    expect(port.up).toBe(true);
    expect((root.querySelector('[data-object="a"]') as HTMLButtonElement).disabled).toBe(true);
    expect(button('Hail').hasAttribute('disabled')).toBe(true);
    expect(button('Again').hasAttribute('disabled')).toBe(false);
    expect(button('Viewscreen').getAttribute('aria-pressed')).toBe('true');
  });
});
