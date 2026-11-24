// SPDX-License-Identifier: GPL-3.0-or-later
import type { JSX } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { SliderKind } from '../../sim/shipSystems';
import { SLIDER_WIDTH, TORPEDO_CELLS_WIDTH, UNIT_FUSION, UNIT_MATTER_ANTIMATTER, UNIT_POWER_GRID, UNIT_TORPEDO } from '../../sim/shipSystems';
import {
  BACKGROUND, BRIDGE_BUTTON, buttonMs, COLOUR_MS, DELEGATE_BUTTON, drawEngineering, newUi, NUM_PAGES, PAGE_NAMES, PAGES, sliderAt, sliderKind, TACTICAL_BUTTON, tabRect,
  totalPower, unitFor, unitInfo, updateColours, type EngineeringUi,
} from '../../view/engineeringLayout';
import { IndexedScreen, SCREEN_H, SCREEN_W } from '../../view/indexed';
import type { Rect } from '../../view/art';
import type { ShipPort } from '../../web/shipPort';
import type { EngineeringView } from '../../web/engineeringSession';
import { areaStyle } from './areas';
import { usePort } from './hooks';
import { PaintedButton } from './painted';

/** The station's codes for the two screens its buttons go to (STATION_CODE: the bridge 0, tactical 7). */
const BRIDGE = 0, TACTICAL = 7;

/** How far a key moves a slider: a twentieth of the bar, as one lit segment. */
const KEY_STEP = 6;

const rectOf = (r: readonly [number, number, number, number]): Rect => [r[0], r[1], r[2] - r[0], r[3] - r[1]];

/** What a slider of the screen says it is: the unit's name and what the slider sets. */
function sliderLabel(name: string, kind: SliderKind | null): string {
  return `${name} ${kind === 'repair' ? 'repair' : kind === 'torpedoes' ? 'loaded' : 'power'}`;
}

/** The slider's own position, in the original's pixels along its bar (the inverse of setSlider's mapping), for a keyboard to step from and a reader to say. */
function sliderValue(view: EngineeringView, unit: number, kind: SliderKind): number {
  const u = view.systems.units[unit], def = view.units[unit];
  if (!u || !def) return 0;
  if (kind === 'torpedoes') return Math.round(u.target * TORPEDO_CELLS_WIDTH / 10);
  if (kind === 'repair') return def.maxDamage ? Math.round(u.repair * SLIDER_WIDTH / def.maxDamage) : 0;
  return u.max ? Math.round(u.target * SLIDER_WIDTH / u.max) : 0;
}
const percentOf = (x: number, kind: SliderKind): number => Math.round(x * 100 / (kind === 'torpedoes' ? TORPEDO_CELLS_WIDTH : SLIDER_WIDTH));

/**
 * The engineering screen (EngineeringScreen, engineering.cpp): with the original's pictures published (`art engineering publish`) it is the
 * original's own screen, drawn from its pictures and fonts onto a canvas (engineeringLayout.ts) with clear controls over its tabs, buttons and
 * sliders; without them, a plain list of the same sliders. Power is allocated and repairs asked for by the sliders; the ship's systems
 * (sim/shipSystems.ts) charge, repair and draw on the pool as the clock runs.
 */
export function EngineeringPanel({ port }: { port: ShipPort }) {
  usePort(port);
  const view = port.engineering();
  if (view === null) return null;
  return view.art ? <ArtScreen port={port} view={view} art={view.art} /> : <PlainScreen port={port} view={view} />;
}

/** The three buttons: a pressed one stays down a moment before it acts (0x91 ticks for Bridge and Tactical, 0x24 for Delegate: update()). */
function usePress(port: ShipPort, ui: { current: EngineeringUi }, redraw: () => void): (button: number) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
  return (button: number) => {
    // (while one is down, another is ignored: mouseClick returns while _pressedButton is set)
    if (ui.current.pressed !== -1) return;
    port.sound('shipBeep');
    ui.current.pressed = button;
    redraw();
    timer.current = setTimeout(() => {
      timer.current = null;
      ui.current.pressed = -1;
      if (button === 0) void port.screen(BRIDGE).catch((e: unknown) => console.warn(e));
      else if (button === 1) void port.screen(TACTICAL).catch((e: unknown) => console.warn(e));
      else port.engineeringDelegate();
      redraw();
    }, buttonMs(button));
  };
}

function ArtScreen({ port, view, art }: { port: ShipPort; view: EngineeringView; art: NonNullable<EngineeringView['art']> }) {
  const [, setRevision] = useState(0);
  const redraw = useCallback(() => setRevision(n => n + 1), []);
  const ui = useRef<EngineeringUi>(newUi(view.delegate));
  const canvas = useRef<HTMLCanvasElement>(null);
  const screen = useRef<IndexedScreen | null>(null);
  const palette = useRef(art.palette.clone());
  const colours = useRef({ at: -1e9 });
  const frames = useRef(0);
  ui.current.delegate = view.delegate;

  // the screen is the background with the panel drawn over it, afresh each frame, as the original's; its palette rotates as it runs
  useEffect(() => {
    const s = (screen.current = new IndexedScreen(SCREEN_W, SCREEN_H));
    s.set(art.images[BACKGROUND]!);
    palette.current = art.palette.clone();
    colours.current.at = -1e9;
    const context = canvas.current?.getContext('2d') ?? null;
    const image = context?.createImageData(SCREEN_W, SCREEN_H);
    const frame = (): void => {
      const now = performance.now();
      const current = port.engineering();
      if (current === null) return;
      const ship = { units: current.units, systems: current.systems };
      if (now - colours.current.at > COLOUR_MS) {
        colours.current.at = now;
        updateColours(palette.current, art, ui.current, ship, now);
      }
      drawEngineering(s, art, ui.current, ship);
      frames.current++;
      if (canvas.current) canvas.current.dataset.frames = String(frames.current);
      if (context && image) {
        s.toRgba(palette.current, image.data);
        context.putImageData(image, 0, 0);
      }
    };
    frame();
    const id = setInterval(frame, 66);
    return () => clearInterval(id);
  }, [art, port]);

  const press = usePress(port, ui, () => { redraw(); });
  const page = PAGES[ui.current.page]!;
  const sliders = [];
  for (let slider = page.firstSlider; slider <= page.lastSlider; slider++) {
    const s = art.tables.sliders[slider];
    if (!s) continue;
    sliders.push(
      <SliderBox key={slider} port={port} view={view} slider={slider} flags={s.flags} at={[s.x - 7, s.y - 3, 130, 25]} unit={unitFor(art.tables, slider)}
        onHover={on => { ui.current.hover = on ? slider : (ui.current.hover === slider ? -1 : ui.current.hover); redraw(); }} />,
    );
  }
  const power = totalPower({ units: view.units, systems: view.systems });
  const hovered = ui.current.hover === -1 ? null : unitFor(art.tables, ui.current.hover);
  const info = hovered === null ? null : unitInfo(view.units[hovered]!, view.systems.units[hovered]!);
  return (
    <div class="au-eng" role="region" aria-label="Engineering">
      <div class="au-ship-screen au-eng-screen" style={{ aspectRatio: `${SCREEN_W} / ${SCREEN_H}` }} data-page={PAGE_NAMES[ui.current.page]!.toLowerCase()}>
        <h2 class="au-visually-hidden">Engineering</h2>
        <canvas ref={canvas} class="au-eng-canvas" width={SCREEN_W} height={SCREEN_H} aria-hidden="true" />
        {Array.from({ length: NUM_PAGES }, (_, p) => (
          <PaintedButton key={p} id={`page-${PAGE_NAMES[p]!.toLowerCase()}`} label={PAGE_NAMES[p]!} rect={rectOf(tabRect(p))} plate pressed={p === ui.current.page}
            onClick={() => {
              if (p === ui.current.page) return;
              port.sound('shipBeep');
              ui.current.page = p;
              ui.current.hover = -1;
              colours.current.at = -1e9;
              redraw();
            }} />
        ))}
        <PaintedButton id="bridge" label="Bridge" rect={rectOf(BRIDGE_BUTTON)} plate onClick={() => press(0)} />
        <PaintedButton id="tactical" label="Tactical" rect={rectOf(TACTICAL_BUTTON)} plate onClick={() => press(1)} />
        <PaintedButton id="delegate" label="Delegate" rect={rectOf(DELEGATE_BUTTON)} plate pressed={view.delegate} onClick={() => press(2)} />
        {sliders}
        {/* (what the screen shows in its pictures, for a screen reader: the Total Power figures and the pointed-at unit's lines) */}
        <ul class="au-visually-hidden" aria-label="Total power" data-total-power>
          <li data-figure="demand">{`Demand ${Math.max(0, Math.round(power.demand / 1.334))}`}</li>
          <li data-figure="spare">{`Spare ${Math.round(power.spare / 1.334)}`}</li>
          <li data-figure="usage">{`In use ${Math.round(power.usage / 1.334)}`}</li>
        </ul>
        {info && <p class="au-visually-hidden" data-unit-info>{`${info.name}: ${info.state}`}</p>}
      </div>
    </div>
  );
}

/** One slider of the screen over its place on the picture: a clear box the pointer drags along, as the original's sliderAt region, and the arrow keys step. */
function SliderBox({ port, view, slider, flags, at, unit, onHover }: {
  port: ShipPort; view: EngineeringView; slider: number; flags: number; at: Rect; unit: number; onHover: (on: boolean) => void;
}): JSX.Element {
  const kind = sliderKind(flags);
  const dragging = useRef(false);
  const name = view.units[unit]?.name ?? `Unit ${unit}`;
  const set = (x: number): void => { if (kind !== null) port.engineeringSlider(unit, kind, x); };
  const along = (e: PointerEvent): number => {
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // (the box starts 7 pixels left of the bar)
    return (e.clientX - box.left) / box.width * at[2] - 7;
  };
  const now = kind === null ? 0 : sliderValue(view, unit, kind);
  return (
    <div
      class="au-eng-slider"
      role="slider"
      tabIndex={0}
      data-slider={slider}
      data-unit={unit}
      data-kind={kind ?? 'readonly'}
      aria-label={sliderLabel(name, kind)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={kind === null ? 0 : percentOf(now, kind)}
      aria-readonly={kind === null ? true : undefined}
      style={areaStyle(at)}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => { if (!dragging.current) onHover(false); }}
      onPointerDown={e => {
        if (e.button !== 0) return;
        dragging.current = true;
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        set(along(e));
      }}
      onPointerMove={e => { if (dragging.current) set(along(e)); }}
      onPointerUp={e => { dragging.current = false; (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId); }}
      onPointerCancel={() => { dragging.current = false; onHover(false); }}
      onFocus={() => onHover(true)}
      onBlur={() => onHover(false)}
      onKeyDown={e => {
        if (kind === null) return;
        const step = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? KEY_STEP : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -KEY_STEP : 0;
        if (step !== 0) set(now + step);
        else if (e.key === 'Home') set(0);
        else if (e.key === 'End') set(SLIDER_WIDTH);
        else return;
        e.preventDefault();
      }}
    />
  );
}

/** The units a page's sliders stand for, in order (without the executable's tables: the shields are in the lifted order). */
function pageUnits(page: number, shieldOrder?: readonly number[]): number[] {
  const p = PAGES[page]!;
  const out: number[] = [];
  for (let slider = p.firstSlider; slider <= p.lastSlider; slider++) {
    const unit = unitFor({ shieldOrder: shieldOrder ?? [] }, slider);
    if (!out.includes(unit)) out.push(unit);
  }
  return out;
}

/** Without the original's pictures: the same sliders as a list, a pair of range inputs a unit (repair, power) and the buttons. */
function PlainScreen({ port, view }: { port: ShipPort; view: EngineeringView }) {
  const [page, setPage] = useState(0);
  const ui = useRef<EngineeringUi>(newUi(view.delegate));
  ui.current.delegate = view.delegate;
  const [, setRevision] = useState(0);
  const press = usePress(port, ui, () => setRevision(n => n + 1));
  const power = totalPower({ units: view.units, systems: view.systems });
  // (the sim moves on without an event: look again as the systems charge)
  useEffect(() => {
    const id = setInterval(() => setRevision(n => n + 1), 500);
    return () => clearInterval(id);
  }, []);
  return (
    <div class="au-eng au-eng-plain" role="region" aria-label="Engineering">
      <h2>Engineering</h2>
      <div role="group" aria-label="Pages">
        {PAGE_NAMES.map((name, p) => (
          <button key={name} type="button" data-page={name.toLowerCase()} aria-pressed={p === page} onClick={() => { port.sound('shipBeep'); setPage(p); }}>{name}</button>
        ))}
      </div>
      <p data-total-power>
        {`Power: demand ${Math.round(power.demand / 1.334)}, spare ${Math.round(power.spare / 1.334)}, in use ${Math.round(power.usage / 1.334)}. Torpedoes in store: ${view.systems.torpedoes}.`}
      </p>
      <ul class="au-eng-units">
        {pageUnits(page).map(unit => {
          const def = view.units[unit]!, u = view.systems.units[unit]!;
          const info = unitInfo(def, u);
          const powerKind: SliderKind | null = def.type === UNIT_POWER_GRID ? null : def.type === UNIT_TORPEDO ? 'torpedoes'
            : def.type === UNIT_FUSION || def.type === UNIT_MATTER_ANTIMATTER ? 'reactor' : 'power';
          const range = (kind: SliderKind, max: number) => (
            <label>{sliderLabel(def.name, kind)}
              <input type="range" min={0} max={max} value={Math.min(sliderValue(view, unit, kind), max)} data-unit={unit} data-kind={kind}
                onInput={e => port.engineeringSlider(unit, kind, Number(e.currentTarget.value))} />
            </label>
          );
          return (
            <li key={unit} data-unit-row={unit}>
              <strong>{def.name}</strong>: {info.state}
              {powerKind !== null && range(powerKind, powerKind === 'torpedoes' ? TORPEDO_CELLS_WIDTH : SLIDER_WIDTH)}
              {u.damage > 0 && range('repair', SLIDER_WIDTH)}
            </li>
          );
        })}
      </ul>
      <p>
        <button type="button" data-engineering="delegate" aria-pressed={view.delegate} onClick={() => press(2)}>Delegate</button>
        <button type="button" data-engineering="bridge" onClick={() => press(0)}>Bridge</button>
        <button type="button" data-engineering="tactical" onClick={() => press(1)}>Tactical</button>
      </p>
    </div>
  );
}
