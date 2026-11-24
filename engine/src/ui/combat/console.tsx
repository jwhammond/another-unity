// SPDX-License-Identifier: GPL-3.0-or-later
import type { JSX } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { maneuverAt } from '../../sim/combat/maneuvers';
import { CONSOLE_PAGES, type CombatCommand, type ConsolePage } from '../../sim/combat/commands';
import type { BattleState } from '../../sim/combat/types';
import {
  BUTTON, BUTTONS, buttonShown, DOWN_ARROW, ENGAGE_BUTTON, MANEUVER_ROWS, maneuverRow, NUM_BUTTONS, NUM_PAGES, PAGE, PAGE_LABELS, PHASER_SLIDER_X, phaserSliderY,
  powerCell, SALVO_X, SALVO_Y, tabRect, UP_ARROW, type ConsoleArt, type ConsoleUi, type Rect,
} from '../../view/combat/console';
import { consolePalette, drawConsole } from '../../view/combat/consoleFrame';
import { buttonDue, consoleClick, dragCommand, pendingSwitches, pressArrow, pressButton, TacticalKeys, type Switches } from '../../view/combat/consoleInput';
import type { PadState } from '../../view/combat/controls';
import { hudModel, PHONE_HEIGHT } from '../../view/combat/hud';
import { SPLIT_RECT } from '../../view/combat/projection';
import type { RadarBlip } from '../../view/combat/radar';
import { blitKey, drawArtLayer, RecordingScreen, seeThrough } from '../../view/combat/spaceArt';
import { Palette, type IndexedImage } from '../../view/indexed';
import type { BattlePort, BattleView } from '../../web/battlePort';
import { AssistsPanel } from '../assists';
import { areaStyle } from '../ship/areas';
import { Drawer, SCANNER_CROP } from './drawer';
import { CombatOptions } from './combatOptions';
import { useBattleControls } from './controls';
import { Hud } from './hud';
import { ViewSurface, type ViewActions } from './viewInput';

/**
 * The tactical console (M8 spec §5; Plan 27): TacticalScreen's console as the original draws it, from its own pictures in the
 * space palette (consoleFrame.ts), on a canvas over the space view, the view's rectangle left clear for it; clear controls over
 * its places that take a click where the original's mouseClick would, and a keyboard's Enter at their middles. Every control
 * gives the battle an order (BattlePort.command). Drawn each animation frame. In the combat chunk (Plan 27 R2).
 */

/** A button's name: its own, or the one it is now (Hail at red alert, Split when wide: `wide`, as the orders waiting will leave it, R3). */
export function buttonLabel(button: number, b: Readonly<BattleState>, wide = b.view.wide): string {
  if (button >= BUTTON.spread) return `Spread ${(button - BUTTON.spread) * 5} degrees`;
  switch (button) {
    case BUTTON.bridge: return b.console.redAlert ? 'Hail' : 'Bridge';
    case BUTTON.engineering: return 'Engineering';
    case BUTTON.view: return 'Camera view';
    case BUTTON.full: return wide ? 'Split view' : 'Full view';
    case BUTTON.phasers: return 'Fire phasers';
    case BUTTON.torpedoes: return 'Fire torpedoes';
    case BUTTON.both: return 'Fire both';
    case BUTTON.zoomIn: return 'Zoom in';
    case BUTTON.zoomOut: return 'Zoom out';
    case BUTTON.shields: return 'Shields';
    case BUTTON.weaponsLock: return 'Weapons lock';
    case BUTTON.selfDestruct: return 'Self-destruct';
    case BUTTON.delegate: return 'Delegate';
    case BUTTON.allPhasers: return 'All banks';
    default: return 'No banks';
  }
}

/**
 * Whether a button shows on (aria-pressed): the toggles drawButton draws down while on, and Delegate's lamp; a switch as the orders
 * waiting will leave it (`on`, pendingSwitches: Plan 29 R3).
 */
function buttonOn(button: number, b: Readonly<BattleState>, on: Switches): boolean | undefined {
  const c = b.console;
  if (button === BUTTON.shields) return on.shieldsRaised;
  if (button === BUTTON.weaponsLock) return on.weaponsLock;
  if (button === BUTTON.selfDestruct) return c.selfDestructTime !== 0;
  if (button === BUTTON.delegate) return on.delegate;
  if (button === BUTTON.full) return on.wide;
  if (button >= BUTTON.spread) return c.spreadDegrees === (button - BUTTON.spread) * 5;
  return undefined;
}

/**
 * The radar's clickable place on the console: where its blips are drawn (drawRadar's bounds, x 12-307 and y 30-288,
 * tactical.cpp:1127), widened by 7 px each way as mouseClick takes a blip within |dx|, |dy| < 8 (tactical.cpp:696). Still clear
 * of the view (SPLIT_RECT, x 319 on), and under the controls, so the buttons come first as in mouseClick.
 */
const RADAR_RECT: Rect = [5, 21, 315, 296];
const rectArea = (r: Rect): [number, number, number, number] => [r[0], r[1], r[2] - r[0], r[3] - r[1]];
/** Each port's keys (TacticalKeys), made as its console first comes up. */
const KEYS = new WeakMap<BattlePort, TacticalKeys>();
/** Split's view on the console (tactical.cpp:39-42), where its pointer surface goes (Plan 29 R6). */
const VIEW_AREA: [number, number, number, number] = [SPLIT_RECT.x, SPLIT_RECT.y, SPLIT_RECT.width, SPLIT_RECT.height];

/**
 * `wide` is the element the wide view fills (the game frame), where the HUD goes while the view is wide (Plan 27 R10); without
 * it the HUD is drawn in place. `pads` and `keyboardFocus` stand in for the browser's in the tests (useBattleControls).
 */
export function CombatConsole({ port, wide, now = () => performance.now(), pads, keyboardFocus }: {
  port: BattlePort; wide?: HTMLElement | null; now?: () => number; pads?: () => readonly (PadState | null)[]; keyboardFocus?: (el: Element) => boolean;
}): JSX.Element | null {
  const [, setShown] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const ui = useRef<ConsoleUi>({ page: PAGE.conn, pressed: -1, buttonTime: 0, arrow: -1, wall: 0 });
  /**
   * The keys held and the keys' last times (TacticalScreen's _held and _last*), the drag's and the pad's: kept with the port for the
   * session, as TacticalScreen outlives a battle (its _last* times from the constructor, tactical.cpp:246-248), and let go as tactical
   * comes up (start()'s `_held = 0`, :284). Plan 29 R4.
   */
  const keys = useMemo(() => {
    let k = KEYS.get(port);
    if (!k) KEYS.set(port, (k = new TacticalKeys()));
    k.release();
    return k;
  }, [port]);
  const blips = useRef<RadarBlip[]>([]);
  const dragging = useRef(-1);
  const frames = useRef(0);
  const screen = useMemo(() => new RecordingScreen(), []);
  /** The art layer's canvas, the pictures the screen knows, and what the layer last drew (Plan 30 R7). */
  const artCanvas = useRef<HTMLCanvasElement>(null);
  const known = useRef<readonly IndexedImage[] | null>(null);
  const layered = useRef<{ el: HTMLCanvasElement | null; key: string }>({ el: null, key: '' });
  const palette = useMemo(() => new Palette(), []);
  const image = useRef<ImageData | null>(null);
  /** The drawer's scanner picture, made once and filled each frame (not a new one a frame: a phone's GC at 30 fps). */
  const cropImage = useRef<ImageData | null>(null);
  const [drawer, setDrawer] = useState(false);
  /** The assists panel over the battle (M8 spec §6.2; Plan 29 R9): Escape or the HUD's button. */
  const [assistsOpen, setAssistsOpen] = useState(false);
  const assistsShown = useRef(false);
  /** Where the keyboard's focus was as the panel opened, to go back to as it closes; whether a key opened it, so it takes the focus. */
  const returnFocus = useRef<Element | null>(null);
  const focusPanel = useRef(false);
  const over = useRef<HTMLDivElement>(null);
  const openAssists = (open: boolean, byKey = false) => {
    if (open === assistsShown.current) return;
    if (open) {
      returnFocus.current = document.activeElement;
      focusPanel.current = byKey;
    }
    assistsShown.current = open;
    setAssistsOpen(open);
  };
  /**
   * Tactical's F1 Combat Options (Plan 32 Task 11), over the console or the wide view: F1 opens it, the screen closes itself (F1, Esc, its
   * buttons). While it is up the session pauses the battle and makes it the battle's dialog (BattlePort.showOptions), so the battle's keys rest.
   */
  const [optionsOpen, setOptionsOpen] = useState(false);
  const openOptions = () => { if (port.optionsScreen?.()) setOptionsOpen(true); };
  useEffect(() => {
    if (!optionsOpen) return undefined;
    port.showOptions?.(true);
    return () => port.showOptions?.(false);
  }, [optionsOpen, port]);
  /** F6's way in: the console's first control, or the HUD's first button. */
  const focusConsole = () => document.querySelector<HTMLElement>('.au-console-root [data-control], .au-combat-hud button')?.focus();
  const drawerOpen = useRef(false);
  drawerOpen.current = drawer;
  const scanner = useRef<HTMLCanvasElement>(null);
  // (the battle's keys and pads: Plan 29 R2, R4, R8)
  const flushZeros = useBattleControls({
    port, keys, now, pads, keyboardFocus,
    assists: () => openAssists(!assistsShown.current, true),
    options: openOptions,
    turnPage: step => {
      const v = port.battle();
      if (!v || v.warp || ui.current.pressed !== -1) return;
      port.page(CONSOLE_PAGES[(CONSOLE_PAGES.indexOf(v.page) + step + NUM_PAGES) % NUM_PAGES]!);
    },
    focusConsole,
  });
  // (the panel a key opened takes the keyboard's focus, so Tab moves through it (its keys are the page's); as it closes, the focus
  // it took goes back where it was, the body included, or to the console when that is gone: Plan 29 R2, R9)
  useEffect(() => {
    if (assistsOpen) {
      if (focusPanel.current) over.current?.querySelector<HTMLElement>('.au-assists')?.focus();
      return;
    }
    const back = returnFocus.current;
    returnFocus.current = null;
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (!back || !lost || back === document.body) return;
    if (back.isConnected && back instanceof HTMLElement) back.focus();
    else focusConsole();
  }, [assistsOpen]);
  /** A short screen, a phone on its side (M8 spec Decision 16): asked as the console comes up, and again as it changes (Plan 29 R12). */
  const query = useMemo(() => globalThis.matchMedia?.(`(max-height: ${PHONE_HEIGHT - 1}px)`) ?? null, []);
  const [short, setShort] = useState(query?.matches === true);

  // (a short screen, a phone on its side, opens the battle wide with the console as a drawer: M8 spec Decision 16; asked whatever the
  // view is now, as coming back from Engineering queues the original's reset to Split, which this order follows)
  useEffect(() => {
    const view = port.battle();
    if (view && !view.warp && query?.matches) port.command({ type: 'wide', on: true });
  }, [port]);

  // (a screen that becomes short, a phone turned or a window made low, goes wide as one that opened short does, unless it already
  // will; one that becomes tall keeps its view: Plan 29 R12)
  useEffect(() => {
    if (!query?.addEventListener) return undefined;
    const change = (e: { matches: boolean }) => {
      setShort(e.matches);
      const view = port.battle();
      if (e.matches && view && !view.warp && !pendingSwitches(view.b, view.queued).wide) port.command({ type: 'wide', on: true });
    };
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, [query, port]);

  // (a frame of the console: TacticalScreen::update's button, then draw; the controls follow what changed)
  useEffect(() => {
    const frame = () => {
      const view = port.battle();
      if (!view) return;
      const u = ui.current;
      u.wall = now();
      u.page = CONSOLE_PAGES.indexOf(view.page);
      // (the warp overlay lets the pressed button and the drag go, tactical.cpp:843-846, and the console isn't drawn)
      if (view.warp) {
        u.pressed = -1;
        dragging.current = -1;
      }
      const due = buttonDue(u);
      if (due) port.command(due);
      // (drawn wide too, unseen: the scanner's log scrolls as the original's Full draws the console's lower half, tactical.cpp:1310-1314)
      const art = port.consoleArt();
      if (art && !view.warp) paint(view, art);
      setShown([view.page, view.b.view.wide, view.warp, u.pressed, u.buttonTime > u.wall, view.b.steps, art !== null, view.paused, view.resolving, view.resolved !== null, view.overlay].join(' '));
    };
    const paint = (view: BattleView, art: ConsoleArt) => {
      if (known.current !== art.images) {
        screen.pictures(art.images);
        known.current = art.images;
      }
      const drawn = drawConsole(screen, art, view, ui.current, port.radar());
      blips.current = drawn.blips;
      if (drawn.scanned) port.logShown(drawn.scanned.index);
      frames.current++;
      consolePalette(art.palette, drawn.scanner, port.flash(), palette.rgb);
      // (the drawer's scanner pages show the console's own scanner: wide, or on a short screen's Split)
      const crop = drawerOpen.current ? scanner.current?.getContext('2d') : null;
      if (crop) {
        const [x0, y0, w, h] = SCANNER_CROP;
        const part = (cropImage.current ??= crop.createImageData(w, h));
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const c = screen.pixels[(y0 + y) * 640 + x0 + x]! * 3, o = (y * w + x) * 4;
            part.data[o] = palette.rgb[c]!;
            part.data[o + 1] = palette.rgb[c + 1]!;
            part.data[o + 2] = palette.rgb[c + 2]!;
            part.data[o + 3] = 255;
          }
        }
        crop.putImageData(part, 0, 0);
      }
      const el = canvas.current;
      const g = view.b.view.wide ? null : el?.getContext('2d');
      if (!el || !g) return;
      el.dataset.frames = String(frames.current);
      el.dataset.blips = JSON.stringify(drawn.blips);
      const img = (image.current ??= g.createImageData(640, 480));
      screen.toRgba(palette, img.data);
      // (the view's rectangle is the space view's, drawn under the console: left clear)
      for (let y = SPLIT_RECT.y; y < SPLIT_RECT.y + SPLIT_RECT.height; y++) {
        for (let x = SPLIT_RECT.x; x < SPLIT_RECT.x + SPLIT_RECT.width; x++) img.data[(y * 640 + x) * 4 + 3] = 0;
      }
      // (with the art on, the repaint shows where the frame is still the plate's or a picture's that has one: Plan 30 R7)
      const rp = art.repaint;
      if (rp) {
        seeThrough(screen, art.plate, screen.blits, art.images, rp.images, rp.opaque, img.data);
        const ael = artCanvas.current, key = blitKey(screen.blits, rp.images);
        const layer = ael?.getContext('2d');
        if (ael && layer && (layered.current.el !== ael || layered.current.key !== key)) {
          drawArtLayer({ clearRect: (x, y, w, h) => layer.clearRect(x, y, w, h), drawImage: (im, x, y) => layer.drawImage(im as CanvasImageSource, x, y) }, rp, screen.blits);
          layered.current = { el: ael, key };
        }
      }
      g.putImageData(img, 0, 0);
    };
    let id = requestAnimationFrame(function loop() {
      frame();
      id = requestAnimationFrame(loop);
    });
    frame();
    return () => cancelAnimationFrame(id);
  }, [port]);

  const view = port.battle();
  const art = port.consoleArt();
  if (!view || view.warp) return null;
  const b = view.b;
  // (the Combat Options up: the screen alone, over the console's box or the wide view's frame; the console's controls and the HUD are gone
  // under it, so its preview's window shows the space view's canvas, and nothing behind it takes a click)
  const optionsScreen = optionsOpen ? port.optionsScreen?.() ?? null : null;
  if (optionsScreen) {
    const o = optionsScreen;
    const options = <CombatOptions settings={o.settings} picture={o.picture} fonts={o.fonts} preview={box => port.previewBox?.(box)} onClose={() => setOptionsOpen(false)} />;
    if (b.view.wide) return wide ? createPortal(options, wide) : options;
    return <div class="au-console-root" ref={root} data-page={view.page}>{options}</div>;
  }
  const page = CONSOLE_PAGES.indexOf(view.page);
  const send = (cmd: CombatCommand) => port.command(cmd);
  // (the assists panel over the console or the HUD: as the player opened it, and while auto-resolve runs or its result waits, so
  // the result is seen whatever was open: Plan 29 R10. Not while a game panel is open over tactical: the saves panel shows its own)
  const assists = view.overlay !== 'panel' && (assistsOpen || view.resolving || view.resolved !== null) ? (
    <div class="au-assists-over" ref={over}><AssistsPanel port={port} onClose={() => openAssists(false)} /></div>
  ) : null;
  /**
   * The battle as it is now, or null when there's none or the warp overlay is up: mouseClick's own returns (the overlay,
   * tactical.cpp:647-648; `!_inCombat`, :653) and mouseDown's (:640). Every handler asks it first, as this component's controls can outlive the battle
   * until a parent re-renders (the frame loop sets nothing once the battle is gone), and the port throws without one.
   */
  const live = () => {
    const v = port.battle();
    return v && !v.warp ? v : null;
  };
  /** A console button pressed outside the console's own picture (the HUD's, the drawer's): pressButton, as a click on it is, so not while one is down. */
  const press = (button: number) => {
    const u = ui.current;
    const v = live();
    if (!v || u.pressed !== -1) return;
    u.wall = now();
    port.beep();
    for (const cmd of pressButton(u, button, v.b, v.queued)) send(cmd);
  };
  /**
   * The view under the pointer (Plan 29 R6, R7): a click or tap targets the ship drawn there (not while a button is down, as a
   * radar click, mouseClick's lockout, tactical.cpp:653); a drag holds the steering under the keys; the wheel is the zoom keys,
   * under their delay.
   */
  const viewAct: ViewActions = {
    pick: (fx, fy) => {
      if (!live() || ui.current.pressed !== -1) return;
      const ship = port.pick(fx, fy);
      if (ship !== null) send({ type: 'target', ship });
    },
    drag: axes => {
      if (!live()) return;
      flushZeros();
      for (const cmd of keys.hold('drag', axes)) send(cmd);
    },
    zoom: direction => {
      const v = live();
      if (v) for (const cmd of keys.start(direction === 'in' ? 'zoomIn' : 'zoomOut', now(), v.b, { warp: v.warp, queued: v.queued })) send(cmd);
    },
  };
  const act = {
    page: (p: ConsolePage) => { if (ui.current.pressed === -1 && live()) port.page(p); },
    press,
    send: (cmd: CombatCommand, beep = false) => {
      if (ui.current.pressed !== -1 || !live()) return;
      if (beep) port.beep();
      send(cmd);
    },
    // (a drag skips the lockout, as dragSlider does, but not the battle's own returns)
    drag: (cmd: CombatCommand) => {
      if (live()) send(cmd);
    },
  };
  const drawerEl = <Drawer view={view} open={drawer} onToggle={() => setDrawer(o => !o)} act={act} scanner={scanner} />;
  if (b.view.wide) {
    // (the view fills the game frame: a point on it is a fraction of the frame, or of the surface where there is no frame)
    const surface = (
      <ViewSurface class="au-combat-hud-view" act={viewAct} now={now} where={(x, y, el) => {
        const box = (wide ?? el).getBoundingClientRect();
        return box.width > 0 && box.height > 0 ? [(x - box.left) / box.width, (y - box.top) / box.height] : null;
      }} />
    );
    const hud = (
      <Hud model={hudModel(view, art, view.paused ? 'paused' : port.assists().speed)} press={press} drawer={drawerEl} view={surface}
        assists={{ open: assists !== null, toggle: () => openAssists(!assistsShown.current), panel: assists }} />
    );
    return wide ? createPortal(hud, wide) : hud;
  }

  /** A click at (x, y) of the original's screen: mouseClick (consoleInput.ts), then what it does. */
  const click = (x: number, y: number) => {
    const u = ui.current;
    const v = live();
    if (!v) return;
    u.wall = now();
    const c = consoleClick(x, y, { page, wide: b.view.wide, pressed: u.pressed, blips: blips.current, images: art?.images ?? [] });
    if (!c) return;
    if (c.kind === 'page') {
      port.page(c.page);
      return;
    }
    if (c.kind === 'command') {
      if (c.arrow !== undefined) pressArrow(u, c.arrow);
      if (c.beep) port.beep();
      send(c.command);
      return;
    }
    port.beep();
    for (const cmd of pressButton(u, c.button, v.b, v.queued)) send(cmd);
  };
  /** Where an event is on the original's screen; a keyboard's click (a click of detail 0: a pointer's pointer events have 0 too) is at the control's middle. */
  const at = (e: MouseEvent, rect: Rect): [number, number] => {
    const box = root.current?.getBoundingClientRect();
    if ((e.type === 'click' && e.detail === 0) || !box || box.width === 0) return [Math.trunc((rect[0] + rect[2]) / 2), Math.trunc((rect[1] + rect[3]) / 2)];
    return [Math.floor(((e.clientX - box.left) * 640) / box.width), Math.floor(((e.clientY - box.top) * 480) / box.height)];
  };
  const control = (key: string, label: string, rect: Rect, pressed?: boolean, onClick?: () => void) => (
    <button key={key} type="button" class={onClick ? 'au-console-ctl au-console-touch' : 'au-console-ctl'} data-control={key} aria-label={label} aria-pressed={pressed}
      style={areaStyle(rectArea(rect))} onClick={e => (onClick ? onClick() : click(...at(e, rect)))} />
  );
  const controls: JSX.Element[] = [];
  const on = pendingSwitches(b, view.queued);
  for (let p = 0; p < NUM_PAGES; p++) controls.push(control(`page-${CONSOLE_PAGES[p]}`, PAGE_LABELS[p]!, tabRect(p), p === page));
  if (art) {
    for (let i = 0; i < NUM_BUTTONS; i++) {
      const im = art.images[BUTTONS[i]!.up];
      if (!buttonShown(i, page, b.view.wide) || !im) continue;
      // (the port's own: on a short screen Full's picture is about 12 CSS px high, so its control is 32 px or more (ship.css) and
      // a tap anywhere on it is Full, pressButton's way as a click on the picture is: a phone's way back to the wide view, R10)
      const touch = short && i === BUTTON.full ? () => press(BUTTON.full) : undefined;
      controls.push(control(`button-${i}`, buttonLabel(i, b, on.wide), [BUTTONS[i]!.x, BUTTONS[i]!.y, BUTTONS[i]!.x + im.width, BUTTONS[i]!.y + im.height], buttonOn(i, b, on), touch));
    }
  }
  if (page === PAGE.conn) for (let level = 0; level < 5; level++) controls.push(control(`power-${level}`, `Power level ${level}`, powerCell(level), b.console.powerLevel === level));
  if (page === PAGE.tactics) {
    for (let row = 0; row < MANEUVER_ROWS; row++) {
      const item = maneuverAt(b as BattleState, row);
      controls.push(control(`maneuver-${row}`, item ? item.label : `Maneuver row ${row + 1}`, maneuverRow(row), b.console.menuSelected === row));
    }
    controls.push(control('maneuvers-up', 'Maneuvers up', UP_ARROW), control('maneuvers-down', 'Maneuvers down', DOWN_ARROW));
    controls.push(control('engage', b.console.engageButton ? 'Disengage' : 'Engage', ENGAGE_BUTTON));
  }
  const sliders: JSX.Element[] = [];
  const slider = (index: number, label: string, rect: Rect, value: number, max: number, step: number) => (
    <div key={`slider-${index}`} class="au-console-slider" role="slider" tabIndex={0} data-control={`slider-${index}`} aria-label={label}
      aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} style={areaStyle(rectArea(rect))}
      onPointerDown={e => {
        if (e.button !== 0 || !live()) return;
        dragging.current = index;
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        const cmd = dragCommand(index, at(e, rect)[0]);
        if (cmd) send(cmd);
      }}
      onPointerMove={e => {
        if (dragging.current !== index || !live()) return;
        const cmd = dragCommand(index, at(e, rect)[0]);
        if (cmd) send(cmd);
      }}
      onPointerUp={() => { dragging.current = -1; }}
      onPointerCancel={() => { dragging.current = -1; }}
      onKeyDown={e => {
        const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? step : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -step : 0;
        if (!d || !live()) return;
        e.preventDefault();
        const setting = Math.max(0, Math.min(max, value + d));
        send(index < 6 ? { type: 'bank', bank: index, setting } : { type: 'salvo', tube: index === 6 ? 0 : 1, setting });
      }} />
  );
  const e = b.ships[0];
  if (page === PAGE.phasers && e) {
    e.banks.slice(0, 6).forEach((bank, i) => sliders.push(slider(i, `Phaser bank ${i + 1}`, [PHASER_SLIDER_X, phaserSliderY(i), PHASER_SLIDER_X + 122, phaserSliderY(i) + 20], bank.setting, 100, 5)));
  }
  if (page === PAGE.torpedoes) {
    ([0, 1] as const).forEach(tube => sliders.push(slider(6 + tube, tube === 0 ? 'Fore salvo' : 'Aft salvo', [SALVO_X, SALVO_Y[tube], SALVO_X + 122, SALVO_Y[tube] + 24], b.console.salvo[tube].setting, 10, 1)));
  }
  return (
    <div class="au-console-root" ref={root} data-page={view.page} data-art={art?.repaint ? 'repaint' : undefined}>
      {art?.repaint && <img class="au-console-plate" src={art.repaint.plate} alt="" aria-hidden="true" />}
      {art?.repaint && <canvas ref={artCanvas} class="au-console-art" width={640 * art.repaint.scale} height={480 * art.repaint.scale} aria-hidden="true" />}
      <canvas ref={canvas} class="au-console-canvas" width={640} height={480} aria-hidden="true" />
      <ViewSurface class="au-console-view" style={areaStyle(VIEW_AREA)} act={viewAct} now={now} where={(x, y) => {
        const box = root.current?.getBoundingClientRect();
        if (!box || box.width === 0 || box.height === 0) return null;
        const fx = (((x - box.left) * 640) / box.width - SPLIT_RECT.x) / SPLIT_RECT.width, fy = (((y - box.top) * 480) / box.height - SPLIT_RECT.y) / SPLIT_RECT.height;
        return fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1 ? [fx, fy] : null;
      }} />
      {b.console.radarShown && (
        <div class="au-console-radar" role="img" aria-label="Radar" style={areaStyle(rectArea(RADAR_RECT))} onClick={ev => click(...at(ev, RADAR_RECT))} />
      )}
      {controls}
      {sliders}
      {!art && <p class="au-console-wait">The console's pictures are loading.</p>}
      {/* (a short screen's Split: the console's own controls are the original's size, most under 32 CSS px there, so the drawer's,
          32 px and up, are on it too: Plan 29 R12) */}
      {short && <div class="au-console-phone">{drawerEl}</div>}
      {assists}
    </div>
  );
}
