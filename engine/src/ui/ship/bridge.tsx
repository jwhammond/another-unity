// SPDX-License-Identifier: GPL-3.0-or-later
import type { ComponentChildren, JSX } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { STATION_CODE, type Station } from '../../sim/ship';
import type { BattlePort } from '../../web/battlePort';
import type { BridgeItemView, ShipPort } from '../../web/shipPort';
import { Viewscreen } from './viewscreen';
import { AstrogationPanel } from './astrogation';
import { TransporterPanel } from './transporter';
import { ComputerPanel } from './computer';
import { ReplayPanel } from './replay';
import { TacticalPanel } from './tactical';
import { HolodeckPanel } from './holodeck';
import { EngineeringPanel } from './engineering';
import { useHotspotLabels } from '../hotspotLabels';
import { areaStyle } from './areas';
import { useAttempt, usePort } from './hooks';

const SCREEN_WIDTH = 640;
const SCREEN_HEIGHT = 480;
const NOT_BUILT = 'Not built yet';

/** The interface strip along the bottom of the bridge's plate, in the original's pixels ([x, y, width, height]): the plate's kept rectangle. */
const STRIP: [number, number, number, number] = [0, 364, 640, 116];
/**
 * What the original's strip has that its tableau does not (bridge.cpp: viewscreenButton, adminButton), where it has them. Every other
 * function it offers is a tableau item (replay conversation at [58,423], comms, lounge, tactical, astrogation, computer, the turbolift for
 * the transporter room and engineering) or the HUD's (log, saves). The sensor records are the three rows and the two arrows.
 */
const SECTOR_READOUT: [number, number, number, number] = [8, 392, 153, 20];
/** The journey readouts and the hover-name box (bridge.cpp draw(): speed at x 168, destination at x 255, the box hoverTextBox()). */
const SPEED_READOUT: [number, number, number, number] = [168, 392, 84, 20];
const DEST_READOUT: [number, number, number, number] = [255, 392, 208, 20];
const HOVER_BOX: [number, number, number, number] = [492, 392, 102, 16];
/** kStatusBlinkTime (bridge.cpp:48): the distance left and the speed take turns. */
const BLINK_MS = Math.trunc(0x246 * 1000 / 291);
type StripId = 'viewscreen' | 'admin' | 'sensor-up' | 'sensor-down' | `sensor-row-${number}`;
const STRIP_BUTTONS: { id: StripId; label: string; rect: [number, number, number, number] }[] = [
  { id: 'admin', label: 'Admin menu', rect: [3, 421, 46, 59] },
  // (the sensor records, bridge.cpp sensorUpButton/sensorDownButton/sensorRow: three rows of where the ship has been sent, and their arrows)
  { id: 'sensor-up', label: 'Sensor records up', rect: [117, 426, 48, 24] },
  { id: 'sensor-down', label: 'Sensor records down', rect: [117, 450, 48, 24] },
  ...[0, 1, 2].map(i => ({ id: `sensor-row-${i}` as StripId, label: `Sensor record ${i + 1}`, rect: [171, 423 + 20 * i, 295, 16] as [number, number, number, number] })),
  { id: 'viewscreen', label: 'Viewscreen', rect: [484, 426, 121, 42] },
];
/**
 * How much of its size a label keeps to fit a box, from its width and the room it has, both in ems of the same font (so the answer holds at every
 * size of the strip): 1 when it fits, else the share that does.
 */
export function labelScale(textEm: number, roomEm: number): number {
  if (!(textEm > 0) || !(roomEm > 0)) return 1;
  return Math.min(1, roomEm / textEm);
}

/**
 * Sizes `label` (a nowrap span in `box`) so its text fits the box's width whichever font the system fell back to: the stack names condensed
 * faces that a stock Windows lacks, and Arial is about 10% too wide for the Viewscreen button. Measured in the font the browser actually used,
 * so nothing is clipped silently.
 */
export function fitStripLabel(label: HTMLElement, box: HTMLElement): void {
  label.style.fontSize = '';
  const px = parseFloat(getComputedStyle(label).fontSize);
  if (!(px > 0)) return;
  const room = box.clientWidth;
  let k = labelScale(label.getBoundingClientRect().width / px, room / px);
  // (text does not scale exactly with its size: hinting and the tracking round, so what was set is measured again and trimmed until it fits)
  for (let pass = 0; k < 1 && pass < 4; pass++) {
    label.style.fontSize = `${k}em`;
    const wide = label.getBoundingClientRect().width;
    if (wide <= room) break;
    k *= (room / wide) * 0.995;
  }
}

/** The button's label, fitted to the button (nowrap, in a span: only the Viewscreen button, whose text is the original's picture when there is one). */
function FittedLabel({ text }: { text: string }): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  const fit = () => { const el = ref.current; const box = el?.parentElement; if (el && box) fitStripLabel(el, box); };
  useLayoutEffect(() => {
    fit();
    // (a web font or a late fallback changes the width after the first paint)
    let live = true;
    void document.fonts?.ready.then(() => { if (live) fit(); });
    // (and when the box is laid out or resized: the strip's size is a container's, unknown at the first layout)
    const box = ref.current?.parentElement;
    const watch = box && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : undefined;
    if (box) watch?.observe(box);
    return () => { live = false; watch?.disconnect(); };
  }, [text]);
  return <span ref={ref} class="au-ship-strip-label">{text}</span>;
}

/** A rectangle of the original's screen as a place inside the strip (percentages of the strip's own box). */
const inStrip = ([x, y, w, h]: readonly [number, number, number, number]) => ({
  position: 'absolute' as const,
  left: `${((x - STRIP[0]) / STRIP[2]) * 100}%`, top: `${((y - STRIP[1]) / STRIP[3]) * 100}%`,
  width: `${(w / STRIP[2]) * 100}%`, height: `${(h / STRIP[3]) * 100}%`,
});

/** The stations whose own screens come in later tasks; until then they show this. */
const STATION_NAMES: Record<Station, string> = {
  bridge: 'Bridge', transporter: 'Transporter room', viewscreen: 'Viewscreen', astrogation: 'Astrogation',
  computer: 'Computer', tactical: 'Tactical', engineering: 'Engineering', holodeck: 'Holodeck',
};

/** The station a turbolift code names exactly (no parameter), if any. */
function stationByCode(code: number): Station | undefined {
  return (Object.keys(STATION_CODE) as Station[]).find(s => STATION_CODE[s] === code && s !== 'viewscreen');
}

/** The gap between a menu and the pointer that opened it (so the item stays under the pointer), and the margin it keeps from the box's edges. */
const MENU_GAP = 10;
const MENU_MARGIN = 4;

/** Where a menu opens: by the pointer that clicked, in pixels of the bridge's box (a click with no pointer, such as a key's, opens it by the item). */
type MenuAt = { x: number; y: number };

/** The place for a menu of `size` that opens by `at` in a box of `box`: below and right of the pointer, moved back in where that would leave the box. */
export function menuPlace(at: MenuAt, size: { width: number; height: number }, box: { width: number; height: number }): MenuAt {
  // (a box with no size is not laid out, as in a test: keep where it was asked for)
  if (box.width <= 0 || box.height <= 0) return { x: at.x + MENU_GAP, y: at.y + MENU_GAP };
  const fit = (want: number, own: number, room: number) => Math.max(MENU_MARGIN, Math.min(want, room - own - MENU_MARGIN));
  return { x: fit(at.x + MENU_GAP, size.width, box.width), y: fit(at.y + MENU_GAP, size.height, box.height) };
}

/** A list of choices that opens by the pointer, as the original's choice dialog does (runChoice), and stays inside the bridge's box. */
function ChoiceMenu({ label, at, children }: { label: string; at: MenuAt; children: ComponentChildren }): JSX.Element {
  const ref = useRef<HTMLUListElement>(null);
  const start = menuPlace(at, { width: 0, height: 0 }, { width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    const box = el?.offsetParent;
    if (!el || !box) return;
    const place = menuPlace(at, { width: el.offsetWidth, height: el.offsetHeight }, { width: box.clientWidth, height: box.clientHeight });
    el.style.left = `${place.x}px`;
    el.style.top = `${place.y}px`;
  });
  return <ul ref={ref} class="au-ship-lift au-ship-choice" aria-label={label} style={{ left: `${start.x}px`, top: `${start.y}px` }}>{children}</ul>;
}

/** The bridge: the lifted items at their rectangles (the tableau), the strip's own buttons, and the turbolift list. */
export function BridgeView({ port }: { port: ShipPort }) {
  usePort(port);
  const [lift, setLift] = useState(false);
  const [replay, setReplay] = useState(false);
  const [pick, setPick] = useState<'comms' | 'lounge' | null>(null);
  // (where the last item was clicked: the menus it opens come up there)
  const [at, setAt] = useState<MenuAt>({ x: 0, y: 0 });
  const [problem, attempt] = useAttempt();
  const go = (name: Station) => attempt(() => port.station(name));
  // (BridgeScreen::chooseObject: with nobody to choose, the room says so at once, bridge.cpp:372-375)
  const choose = (which: 'comms' | 'lounge') => {
    // (the lounge's door opens first, bridge.cpp:387; Comms beeps in the port)
    if (which === 'lounge') port.sound('doorOpen');
    if (port.contacts(which).length === 0) attempt(() => (which === 'comms' ? port.comms(null) : port.lounge(null)));
    else setPick(which);
  };
  const up = port.viewscreenUp();
  // (the Viewscreen button is sensor.mrg's picture when it is published and the art is on: bridge.cpp draw())
  const sensor = port.sensorSprites();
  const [hover, setHover] = useState('');
  const readout = port.stripReadout();
  const sensors = port.sensorRecords();
  const [blink, setBlink] = useState(0);
  useEffect(() => {
    if (!readout.transit) return;
    const id = setInterval(() => setBlink(Math.trunc(Date.now() / BLINK_MS) % 2), 100);
    return () => clearInterval(id);
  }, [readout.transit !== null]);
  const speedText = readout.transit && (blink
    ? `LY:${readout.transit.lightYears.toFixed(1).padStart(5)}`
    : `${readout.transit.warp ? 'WARP' : 'IMPL'}: ${(readout.transit.speed / (readout.transit.warp ? 100 : 1)).toFixed(1)}`);
  // (the box tells the session where to draw the ship's set: it registers while the bridge is up and goes with it)
  const screenRef = useCallback((el: HTMLDivElement | null) => port.screenRect(el ? () => el.getBoundingClientRect() : null), [port]);
  /** The click's place in the bridge's box: the pointer's, or the item's centre for a click without one. */
  const place = (ev: JSX.TargetedMouseEvent<HTMLButtonElement>): MenuAt => {
    const box = ev.currentTarget.closest('.au-ship-bridge')?.getBoundingClientRect();
    const own = ev.currentTarget.getBoundingClientRect();
    if (!box) return { x: 0, y: 0 };
    const pointer = ev.detail > 0 || ev.clientX !== 0 || ev.clientY !== 0;
    return { x: (pointer ? ev.clientX : own.left + own.width / 2) - box.left, y: (pointer ? ev.clientY : own.top + own.height / 2) - box.top };
  };
  const click = (item: BridgeItemView) => {
    // (the lift's door opens as its list does, and closes again if nothing is chosen: bridge.cpp:401-413)
    if (item.action === 'turbolift') {
      port.sound(lift ? 'doorClose' : 'doorOpen');
      // (the stations it goes to start loading as the list opens, so the move shows at once: B5)
      if (!lift) port.preloadStations(port.turbolift().flatMap(e => { const s = stationByCode(e.code); return s === undefined ? [] : [s]; }));
      setLift(open => !open);
    }
    else if (item.action === 'astrogation') go('astrogation');
    else if (item.action === 'computer') go('computer');
    else if (item.action === 'tactical') go('tactical');
    else if (item.action === 'replay') { port.sound('advice'); setReplay(true); }
    else if (item.action === 'comms' || item.action === 'lounge') choose(item.action);
    else if (item.action === 'talk') attempt(() => port.talk(item.object));
  };
  return (
    <div class={up ? 'au-ship-bridge au-ship-bridge-up' : 'au-ship-bridge'}>
      <div class="au-ship-screen" ref={screenRef} style={{ aspectRatio: `${SCREEN_WIDTH} / ${SCREEN_HEIGHT}` }}>
        {port.bridgeItems().map((item, i) => {
          // (only the replay works with the viewscreen up, bridge.cpp:277)
          const later = item.action === 'later';
          const shut = up && item.action !== 'replay';
          return (
            <button
              key={i}
              type="button"
              class="au-ship-item"
              data-object={item.object}
              disabled={later || shut}
              title={later ? NOT_BUILT : item.label}
              style={{
                left: `${(item.x / SCREEN_WIDTH) * 100}%`, top: `${(item.y / SCREEN_HEIGHT) * 100}%`,
                width: `${(item.width / SCREEN_WIDTH) * 100}%`, height: `${(item.height / SCREEN_HEIGHT) * 100}%`,
              }}
              onPointerEnter={() => setHover(item.label)}
              onPointerLeave={() => setHover('')}
              onClick={ev => { setAt(place(ev)); click(item); }}
            >{item.label}</button>
          );
        })}
        {/* (the original's interface strip: its own buttons, over the painted ones; the strip is the plate's kept rectangle) */}
        <div class="au-ship-strip" data-area="strip" style={areaStyle(STRIP)}>
          {/* (bridge.cpp draw(): "SECTOR: <name>" in the plate's first text box, which the plate leaves empty) */}
          <span class="au-ship-strip-sector" data-strip-readout="sector" style={inStrip(SECTOR_READOUT)}>{`SECTOR: ${port.sectorName()}`}</span>
          {speedText && <span class="au-ship-strip-sector" data-strip-readout="speed" style={inStrip(SPEED_READOUT)}>{speedText}</span>}
          {readout.dest && <span class="au-ship-strip-sector" data-strip-readout="dest" style={inStrip(DEST_READOUT)}>{`${readout.dest.arriving ? 'DEST' : 'ARR'}: ${readout.dest.name}`}</span>}
          {/* (the box names the item under the pointer, centred: bridge.cpp mouseMove's _statusText) */}
          <span class="au-ship-strip-sector au-ship-strip-hover" data-strip-readout="hover" style={inStrip(HOVER_BOX)}>{hover}</span>
          {/* (the sensor records: where the ship has been sent, newest first, in the plate's three black rows) */}
          {sensors.rows.map((name, i) => (
            <span key={i} class="au-ship-strip-sector au-ship-strip-record" data-strip-readout={`record-${i}`} style={inStrip([171, 423 + 20 * i, 295, 16])}>{name}</span>
          ))}
          {STRIP_BUTTONS.map(b => {
            const pic = b.id === 'viewscreen' && sensor ? sensor.sprite(up ? 'viewscreenDown' : 'viewscreen') : undefined;
            return (
            <button
              key={b.id}
              type="button"
              class={pic ? `au-ship-strip-btn au-ship-strip-${b.id} au-ship-strip-pic` : `au-ship-strip-btn au-ship-strip-${b.id}`}
              data-strip={b.id}
              data-end={(b.id === 'sensor-up' && !sensors.up) || (b.id === 'sensor-down' && !sensors.down) ? '' : undefined}
              title={b.label}
              aria-label={b.label}
              aria-pressed={b.id === 'viewscreen' ? up : undefined}
              style={inStrip(b.rect)}
              onClick={() => (b.id === 'viewscreen' ? port.toggleViewscreen()
                : b.id === 'admin' ? port.adminMenu()
                : b.id === 'sensor-up' ? port.sensorScroll(1)
                : b.id === 'sensor-down' ? port.sensorScroll(-1)
                : attempt(() => port.sensorGo(Number(b.id.slice(-1)))))}
            >{pic ? <><span class="au-ship-strip-art" aria-hidden="true" style={{ width: `${(pic.rect[2] / b.rect[2]) * 100}%`, height: `${(pic.rect[3] / b.rect[3]) * 100}%`, backgroundImage: `url("${pic.url}")` }} /><span class="au-visually-hidden">{b.label}</span></> : b.id === 'viewscreen' ? <FittedLabel text={b.label} /> : b.label}</button>
            );
          })}
        </div>
      </div>
      {lift && (
        <ChoiceMenu label="Turbolift" at={at}>
          {port.turbolift().map(entry => (
            <li key={entry.code}>
              <button
                type="button"
                data-code={entry.code}
                onClick={() => {
                  setLift(false);
                  const station = stationByCode(entry.code);
                  attempt(() => (station !== undefined ? port.station(station) : port.screen(entry.code)));
                }}
              >{entry.label}</button>
            </li>
          ))}
        </ChoiceMenu>
      )}
      {pick !== null && (
        <ChoiceMenu label={pick === 'comms' ? 'Comms' : 'Lounge'} at={at}>
          {port.contacts(pick).map(c => (
            <li key={c.object}>
              <button
                type="button"
                data-object={c.object}
                onClick={() => {
                  setPick(null);
                  attempt(() => (pick === 'comms' ? port.comms(c.object) : port.lounge(c.object)));
                  if (pick === 'lounge') port.sound('doorClose');
                }}
              >{c.label}</button>
            </li>
          ))}
          <li><button type="button" onClick={() => { setPick(null); if (pick === 'lounge') port.sound('doorClose'); }}>Cancel</button></li>
        </ChoiceMenu>
      )}
      {replay && <ReplayPanel port={port} close={() => setReplay(false)} />}
      {problem !== null && <p class="au-problem" role="alert">{problem}</p>}
    </div>
  );
}

/** A station whose screen is not built yet. */
function StationStub({ station, port }: { station: Station; port: ShipPort }) {
  const [problem, attempt] = useAttempt();
  return (
    <div class="au-ship-stub">
      <h2>{STATION_NAMES[station]}</h2>
      <p>{NOT_BUILT}</p>
      <button type="button" onClick={() => attempt(() => port.station('bridge'))}>Back to the bridge</button>
      {problem !== null && <p class="au-problem" role="alert">{problem}</p>}
    </div>
  );
}

/**
 * The ship's UI: whichever station the ship is at, or the end of the game. Nothing while the team is away. At tactical,
 * `battlePort`'s battle is the console (Plan 27), and `battle` the dev view folded out over it (behind ?dev: Plan 23).
 */
export function ShipPanel({ port, battle, battlePort, devLabel }: { port: ShipPort; battle?: ComponentChildren; battlePort?: BattlePort; devLabel?: string }) {
  usePort(port);
  // (the outlines and names over the clickable areas of a plate: the dev hotspots view, or the player's toggle)
  const spots = useHotspotLabels() || port.hotspots();
  // (B5: while the station's picture loads, the last station's picture stays on the canvas, and its panel stays with it, as it was and inert,
  // a copy taken as the station changes; the new panel is hidden under it. Both go in the frame the new picture comes in)
  const root = useRef<HTMLDivElement | null>(null);
  const frozen = useRef<HTMLElement | null>(null);
  const holding = port.ship() !== null && port.shipHeld();
  if (!holding) frozen.current = null;
  // (read here, in the render, and not in a layout effect: an effect runs after this render's changes have reached the page, when the
  // panel's element no longer shows the station left; here it still does)
  else if (frozen.current === null && root.current) frozen.current = frozenCopy(root.current);
  const ship = port.ship();
  if (ship === null) return null;
  const over = port.gameOver();
  if (over !== null) {
    const end = port.ending(over);
    return (
      <div class="au-ship" role="dialog" aria-label="Game over">
        <p>{end.won ? 'The end.' : `Game over (${over}).`}</p>
        {!end.won && end.text ? <p class="au-ending">{end.text}</p> : null}
        <button type="button" onClick={() => void port.restart().catch((err: unknown) => console.warn(err))}>Start a new game</button>
      </div>
    );
  }
  const held = holding ? ' au-ship-held' : '';
  /** The station's panel, with the frozen copy of the last one over it while that one's picture is held. */
  const framed = (panel: JSX.Element): JSX.Element => (
    <>
      {holding && frozen.current && (
        <div class="au-ship-frozen" aria-hidden="true" ref={el => { if (el && frozen.current && el.firstChild !== frozen.current) el.replaceChildren(frozen.current); }} />
      )}
      {panel}
    </>
  );
  // (the viewscreen replaces the station while a hail runs, as the original changes screen)
  if (port.viewscreen() !== null) {
    return framed(<div ref={root} class={(port.shipArt('viewscreen') ? 'au-ship au-ship-art' : 'au-ship') + held} data-station="viewscreen"><Viewscreen port={port} /></div>);
  }
  // (the computer leaves the ship's station as it was, so it is looked for first)
  if (port.computer() !== null) {
    return framed(<div ref={root} class={(port.shipArt('computer') ? `au-ship au-ship-art${spots ? ' au-ship-hotspots' : ''}` : 'au-ship') + held} role="region" aria-label="Computer" data-station="computer"><ComputerPanel port={port} /></div>);
  }
  return framed(
    <div ref={root} class={((ship.station === 'bridge' || ship.station === 'transporter' || ship.station === 'astrogation' || ship.station === 'tactical') && port.shipArt(ship.station) ? `au-ship au-ship-art${spots ? ' au-ship-hotspots' : ''}` : ship.station === 'astrogation' ? 'au-ship au-ship-map' : ship.station === 'engineering' || (ship.station === 'holodeck' && port.holodeckArt() !== null) ? 'au-ship au-ship-engineering' : 'au-ship') + held} role="region" aria-label={STATION_NAMES[ship.station]} data-station={ship.station}>
      {ship.station === 'bridge' ? <BridgeView port={port} />
        : ship.station === 'astrogation' ? <AstrogationPanel port={port} />
        : ship.station === 'transporter' ? <TransporterPanel port={port} />
        : ship.station === 'tactical' ? <TacticalPanel port={port} battle={battlePort} dev={battle} devLabel={devLabel} />
        : ship.station === 'holodeck' ? <HolodeckPanel port={port} />
        : ship.station === 'engineering' ? <EngineeringPanel port={port} />
        : <StationStub station={ship.station} port={port} />}
    </div>
  );
}

/**
 * A still copy of a station's panel (B5): its elements as they are, its canvases' pictures drawn in, and nothing that names it a station or a
 * region, so it is never taken for the station the ship is at.
 */
function frozenCopy(el: HTMLElement): HTMLElement {
  const copy = el.cloneNode(true) as HTMLElement;
  const from = el.querySelectorAll('canvas');
  const to = copy.querySelectorAll('canvas');
  from.forEach((c, i) => {
    try {
      to[i]?.getContext('2d')?.drawImage(c, 0, 0);
    } catch {
      // (a canvas with nothing to copy, or none in a test's page)
    }
  });
  copy.removeAttribute('data-station');
  copy.removeAttribute('role');
  // (an open list, as the turbolift's whose choice made the move, is closed in the copy: it was the last thing clicked, not the picture)
  for (const list of copy.querySelectorAll('.au-ship-choice')) list.remove();
  // (the strip's buttons keep their look by a class of the copy's own, since what names them goes)
  for (const btn of copy.querySelectorAll('[data-strip]')) btn.classList.add('au-ship-strip-copy');
  // (no ids, labels' targets, accessible names or the attributes that name a strip button, readout or object: the live panel's own must
  // stay the only ones on the page)
  for (const node of [copy, ...copy.querySelectorAll('*')]) {
    for (const { name } of [...node.attributes]) {
      if (name === 'id' || name === 'for' || name.startsWith('aria-') || name === 'data-strip' || name === 'data-strip-readout' || name === 'data-object') node.removeAttribute(name);
    }
  }
  copy.classList.remove('au-ship-held');
  // (no pointer or key reaches it; its holder takes the clicks, so none falls through to the canvas under it)
  copy.setAttribute('inert', '');
  return copy;
}
