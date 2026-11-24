// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useState } from 'preact/hooks';
import type { MapPanel, MapView } from '../../sim/astroCamera';
import type { AstroTime, Course, CourseError } from '../../sim/astro';
import type { Rect } from '../../view/art';
import type { ShipPort } from '../../web/shipPort';
import type { AstroPanelSprite, AstroSpriteName } from '../faces';
import { areaStyle } from './areas';
import { useAttempt, usePort } from './hooks';
import { PaintedButton } from './painted';
import { BitmapText } from './bitmapText';
import { wrapInfo, ASTRO_FONT } from '../../view/bitmapText';
import { ASTRO_ENGINE_FRAME_MS } from '../faces';

/** A refusal in plain words. */
const REASONS: Record<CourseError, string> = {
  'nothing there': 'There is nothing to go to there.',
  'too fast': 'The ship cannot go that fast.',
  'no warp': 'The warp drive is not working.',
  'too far for impulse': 'That is too far to go at impulse.',
};

/** The course panel's speeds (`_warpSetting`, `_impulseSetting`: astrogation.cpp:1050-1051, 1699-1701): where they start, and the warp buttons' range, in hundredths of a warp factor. */
export const DEFAULT_WARP = 500, DEFAULT_IMPULSE = 10, MIN_WARP = 100, MAX_WARP_SETTING = 990;

const UNITS: [keyof AstroTime, string][] = [
  ['years', 'y'], ['months', 'mo'], ['days', 'd'], ['hours', 'h'], ['minutes', 'm'], ['seconds', 's'],
];

/** A journey time, leaving out the leading units that are zero. */
export function formatTime(t: AstroTime): string {
  const parts = UNITS.filter(([unit]) => t[unit] > 0).map(([unit, short]) => `${t[unit]}${short}`);
  return parts.length ? parts.join(' ') : '0s';
}

/**
 * The buttons the original paints on the astrogation screen (astrogation.cpp buttonAt), [x, y, w, h] in its pixels. The rotation pad's
 * rectangles are the executable's (data._rotationPad). They turn the map, move its cursor and change its view
 * and panel through the port (the session's map camera).
 */
const PAINTED_EXITS: { id: string; label: string; to: 'bridge' | 'computer' | 'engineering'; rect: Rect }[] = [
  { id: 'exit-bridge', label: 'Back to the bridge', to: 'bridge', rect: [490, 369, 119, 32] },
  { id: 'exit-computer', label: 'Computer', to: 'computer', rect: [490, 401, 119, 31] },
  { id: 'exit-engineering', label: 'Engineering', to: 'engineering', rect: [490, 432, 119, 37] },
];
const PAINTED_TABS: { id: string; label: string; rect: Rect }[] = [
  { id: 'tab-info', label: 'See info', rect: [389, 49, 72, 25] },
  { id: 'tab-course', label: 'Course', rect: [479, 49, 73, 25] },
  { id: 'tab-display', label: 'Display', rect: [567, 49, 73, 25] },
];
const PAINTED_MAP: { id: string; label: string; rect: Rect }[] = [
  // (the rotation pad's rectangles are the executable's, `_rotationPad`: the bars of up and down span the whole pad and so cover the corners of left and right,
  // which buttonAt reaches first, so they come later here, over them)
  { id: 'pad-stop', label: 'Stop the map turning', rect: [37, 402, 43, 43] },
  { id: 'pad-left', label: 'Turn the map left', rect: [9, 374, 28, 99] },
  { id: 'pad-right', label: 'Turn the map right', rect: [80, 374, 28, 99] },
  { id: 'pad-up', label: 'Turn the map up', rect: [9, 374, 99, 28] },
  { id: 'pad-down', label: 'Turn the map down', rect: [9, 445, 99, 28] },
  { id: 'view-galaxy', label: 'Galaxy view', rect: [124, 376, 48, 32] },
  { id: 'view-sector', label: 'Sector view', rect: [124, 408, 48, 32] },
  { id: 'view-system', label: 'System view', rect: [124, 440, 48, 32] },
  ...(['x', 'y', 'z'] as const).flatMap((axis, i) => [
    { id: `cursor-${axis}-up`, label: `Cursor ${axis} up`, rect: [191 + 32 * i, 372, 29, 30] as Rect },
    { id: `cursor-${axis}-down`, label: `Cursor ${axis} down`, rect: [191 + 32 * i, 445, 29, 30] as Rect },
  ]),
];
/** The Display tab's nine switches (our own names: the original's labels are not in the lifted data). */
const DISPLAY_LABELS = ['Stars', 'Grid', 'Region 1', 'Region 2', 'Region 3', 'Region 4', 'Region 5', 'Inhabited stars', 'Starbases'];
/** The Display tab's switches' tops (drawDisplayPanel's kTops): each bar runs from 398 (423 for the five regions) to 520, its label at 528, 19 or 20 high. */
const SWITCH_TOPS = [102, 126, 169, 193, 217, 241, 265, 308, 332];
const switchLeft = (i: number): number => (i >= 2 && i < 7 ? 423 : 398);
/** Where the original writes what the map is looking at and the coordinates (drawTitle: x 101, y 1; drawCoordinates: the cursor's from x 197 and the ship's from x 318, 32 apart, y 417). */
const TITLE_AT: Rect = [101, 1, 280, 17];
/** The ink the title is drawn in on the plate's blue field (the CSS text's #04101e). */
const TITLE_INK = [4, 16, 30] as const;
const cursorAt = (i: number): Rect => [197 + 32 * i, 417, 28, 16];
const shipAt = (i: number): Rect => [318 + 32 * i, 417, 28, 16];
/** Where the original writes how the map is turned (astrogation.cpp drawCoordinates: "E: 000" at x 16, "A: 000" at x 325, y 344). */
const ELEVATION_AT: Rect = [16, 344, 60, 16];
const AZIMUTH_AT: Rect = [325, 344, 60, 16];



/**
 * The astrogation screen's panel: pick a sector, star and planet, set the speed and engage. The map is the canvas behind.
 *
 * With a plate (Plan 16 R17) the same controls sit in a 4:3 `.au-ship-screen` box, over the repainted screen: the selectors, mode, speed and
 * journey in its `info` box, Engage and Back to the bridge over its painted exit block (`controls`), each over an opaque LCARS ground. The map
 * has no element: the session draws it in the plate's `map` window, and the pointer passes through the box to it. The markup, labels, order
 * and handlers are the same; the heading is visually hidden but stays in the accessibility tree.
 */
export function AstrogationPanel({ port }: { port: ShipPort }) {
  usePort(port);
  const [problem, attempt] = useAttempt();
  const [refused, setRefused] = useState<CourseError | null>(null);
  const [warp, setWarp] = useState(true);
  const [speed, setSpeed] = useState<number | null>(null);
  // the journey's progress moves without an event: look again as it runs
  const [, setNow] = useState(0);
  // (the engine's picture on the course panel runs its frames)
  const [engineFrame, setEngineFrame] = useState(0);
  const transit = port.transit();
  // (a scripted warp engages by itself on a later frame, with no event: look again while it does)
  const exitsEnabled = port.exitsEnabled();
  // (and so does a spinning map, whose angles are read out)
  const spinning = port.mapCamera().spinning;
  useEffect(() => {
    if (!transit && exitsEnabled && !spinning) return undefined;
    const id = setInterval(() => setNow(n => n + 1), 250);
    return () => clearInterval(id);
  }, [transit !== null, exitsEnabled, spinning]);

  const max = port.maxWarp();
  const canWarp = max !== 100;
  const useWarp = warp && canWarp;
  const steps = port.impulseSteps();
  // (setDefaults, astrogation.cpp:1050: warp 5.0 and 100 percent impulse; the buttons keep warp to 1.0..9.9 and impulse to 10..100 percent, not to what the
  // engines can do: an engage past that is refused, and sets the speed to the most they can)
  const chosenSpeed = useWarp ? Math.min(Math.max(speed ?? DEFAULT_WARP, MIN_WARP), MAX_WARP_SETTING) : Math.min(Math.max(speed ?? DEFAULT_IMPULSE, 1), steps);
  const selection = port.selection();
  const sectors = port.sectors();
  const stars = selection ? port.stars(selection.sector) : [];
  const star = selection?.star !== undefined ? stars[selection.star] : undefined;
  // (a course is to what is chosen: a star or planet, a station or phenomenon, or with only a sector chosen the cursor's own place, as startCourse does)
  const cam = port.mapCamera();
  const somewhere = selection && (selection.star !== undefined || selection.station === true || selection.phenomenon !== undefined);
  const cursorPlace = { x: cam.cursorSector[0] * 20 + cam.cursor[0], y: cam.cursorSector[1] * 20 + cam.cursor[1], z: cam.cursorSector[2] * 20 + cam.cursor[2] };
  const course: Course | null = selection
    ? { ...selection, warp: useWarp, speed: chosenSpeed, ...(somewhere ? {} : { point: cursorPlace }) } : null;
  const preview = course ? port.preview(course) : null;

  const plate = port.shipPlate('astrogation');
  // (the original's own pictures, when published: the tab strip of the tab that is open, which is the whole panel for the course, and the engine's frames on it)
  const art = plate !== null ? port.astroSprites() : null;
  // (the game's own bitmap fonts for the screen's text, when they are published and loaded: the words stay in the page, and the eye gets the original's letters)
  const fonts = plate !== null ? port.astroFonts() : null;
  const bt = (face: 'map' | 'info' | 'label', text: string, x: number, y: number, key: string, ink?: readonly [number, number, number]) => (
    fonts ? <BitmapText key={key} fonts={fonts} face={face} text={text} x={x} y={y} ink={ink} /> : null
  );
  const panelName = cam.panel === 'info' ? 'info_tab' : cam.panel === 'display' ? 'display_tab' : useWarp ? 'course_warp' : 'course_impulse';
  const panelPicture = art?.panel(panelName);
  const frames = cam.panel === 'course' ? art?.engine(useWarp) : undefined;
  const courseArt = cam.panel === 'course' && panelPicture !== undefined;
  useEffect(() => {
    if (!frames) return undefined;
    const id = setInterval(() => setEngineFrame(f => f + 1), ASTRO_ENGINE_FRAME_MS);
    return () => clearInterval(id);
  }, [frames !== undefined, useWarp]);
  // (the box registers while it is up and goes with it, as the bridge's does)
  const screenRef = useCallback((el: HTMLDivElement | null) => port.screenRect(el ? () => el.getBoundingClientRect() : null), [port]);
  const areas = plate?.areas ?? {};
  /** A section's place: the class and style that put it in its area, when there is a plate with that area. */
  const at = (area: string, rect: Rect | undefined = areas[area]): { class?: string; style?: ReturnType<typeof areaStyle>; 'data-area'?: string } =>
    plate !== null && rect !== undefined ? { class: `au-area au-astro-${area}`, style: areaStyle(rect), 'data-area': area } : {};

  // (start(), astrogation.cpp:1085-1089: as the screen opens, its first message is drawn at 80, 140 and shown, then its third at 73, 140
  // over it, each for a frame; the charts are loaded already, so they are seen only for a moment)
  // (the plate may come after the panel: it is when the screen is there to see that they are shown)
  const [opening, setOpening] = useState(0);
  const onPlate = plate !== null;
  useEffect(() => {
    if (!onPlate) return undefined;
    setOpening(0);
    let second = 0;
    const first = requestAnimationFrame(() => { setOpening(1); second = requestAnimationFrame(() => setOpening(2)); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [onPlate]);
  const cursorAttr = [...cam.cursorSector, ...cam.cursor].join(',');
  const detail = cam.panel === 'info' ? port.selectionInfo() : { title: '', lines: [] as string[] };
  // (the info text as the original wraps it: 223 pixels in the info font, up to twenty lines from y 134, 18 apart)
  const infoFont = fonts?.fonts[ASTRO_FONT.info];
  const infoLines = infoFont ? detail.lines.flatMap(l => wrapInfo(infoFont, l, 223)).slice(0, 20) : [];
  const text = port.astroText();
  const labels = text.labels ?? DISPLAY_LABELS;
  const pick = (next: { sector: number; star?: number; planet?: number } | null) => { setRefused(null); port.select(next); };
  const number = (value: string) => (value === '' ? undefined : Number(value));

  const journey = (
    <>
      {cam.panel === 'course' && preview && (typeof preview === 'string'
        ? <p>{REASONS[preview]}</p>
        : <p>Journey time: <strong>{formatTime(preview.time)}</strong></p>)}
      {cam.panel === 'course' && transit && (
        <div>
          <progress aria-label="Journey" max={1} value={transit.progress} />
          <p>Arrives in {formatTime(transit.eta)}</p>
        </div>
      )}
    </>
  );
  const info = (
    <>
      {/* (the course controls are painted over the panel's upper part, as the original's: the selectors and the journey sit below them) */}
      {cam.panel === 'course' && plate !== null && !courseArt && <div class="au-astro-spacer" style={{ height: '48.5%' }} />}
      {cam.panel !== 'display' && <div class={plate !== null ? 'au-visually-hidden' : 'au-astro-selectors'}>
      <label>Sector
        <select
          value={selection?.sector ?? ''}
          onChange={e => { const sector = number(e.currentTarget.value); pick(sector === undefined ? null : { sector }); }}
        >
          <option value="">Choose a sector</option>
          {sectors.map(s => <option key={s.index} value={s.index}>{s.label}</option>)}
        </select>
      </label>
      {selection && (
        <label>Star
          <select
            value={selection.star ?? ''}
            onChange={e => pick({ sector: selection.sector, star: number(e.currentTarget.value) })}
          >
            <option value="">Choose a star</option>
            {stars.map(s => <option key={s.index} value={s.index}>{s.label}</option>)}
          </select>
        </label>
      )}
      {selection && star && (
        <label>Planet
          <select
            value={selection.planet ?? ''}
            onChange={e => pick({ sector: selection.sector, star: selection.star, planet: number(e.currentTarget.value) })}
          >
            <option value="">The star</option>
            {Array.from({ length: star.planets }, (_, i) => <option key={i} value={i}>{`Planet ${i + 1}`}</option>)}
          </select>
        </label>
      )}
      </div>}
      {!courseArt && journey}
      {cam.panel === 'info' && (
        <div class="au-astro-detail" role="region" aria-label="Info">
          {detail.title && <h3>{detail.title}</h3>}
          {detail.lines.map((line, i) => <p key={i}>{line}</p>)}
        </div>
      )}
      {cam.panel === 'display' && plate === null && (
        <fieldset class="au-astro-display">
          <legend>Display</legend>
          {labels.map((label, i) => (
            <label key={i}><input type="checkbox" data-display={i} checked={cam.display[i]} onChange={() => port.mapDisplay(i)} /> {label}</label>
          ))}
        </fieldset>
      )}
    </>
  );
  // (the course panel's own controls, AstrogationScreen::buttonAt: Warp, Impulse, Faster, Slower, Engage and Stop, at the original's rectangles)
  const step = (direction: 1 | -1) => setSpeed(useWarp ? Math.min(MAX_WARP_SETTING, Math.max(MIN_WARP, chosenSpeed + direction * 10)) : Math.min(steps, Math.max(1, chosenSpeed + direction)));
  const engageNow = () => {
    if (!course) return;
    setRefused(null);
    attempt(async () => {
      const why = await port.engage(course);
      setRefused(why);
      // (checkCourse, astrogation.cpp:1778: a speed the engines cannot manage is set to the most they can, as the course is refused)
      if (why === 'too fast') setSpeed(max);
    });
  };
  // (the sprites of the original's course panel, when published: drawCoursePanel draws Faster by the drive, Slower, Engage and Stop, and their pressed frames)
  const sprites = (up: AstroSpriteName, down: AstroSpriteName) => (art ? { up: art.sprite(up), down: art.sprite(down) } : undefined);
  const speedText = useWarp ? (chosenSpeed / 100).toFixed(1) : `${chosenSpeed * 10}%`;
  const courseControls = cam.panel !== 'course' ? null : (
    <>
      <PaintedButton id="warp" label="Warp" rect={[395, 93, 83, 61]} plate={plate !== null} art={courseArt} pressed={useWarp} disabled={!canWarp} onClick={() => { setWarp(true); setSpeed(null); }} />
      <PaintedButton id="impulse" label="Impulse" rect={[552, 93, 86, 61]} plate={plate !== null} art={courseArt} pressed={!useWarp} onClick={() => { setWarp(false); setSpeed(null); }} />
      <PaintedButton id="faster" label="Faster" rect={[478, 93, 64, 28]} plate={plate !== null} hold={120} sprite={useWarp ? sprites('faster_warp', 'faster_warp_down') : sprites('faster_impulse', 'faster_impulse_down')} onClick={() => step(1)} />
      <PaintedButton id="slower" label="Slower" rect={[478, 121, 64, 30]} plate={plate !== null} hold={120} sprite={sprites('slower', 'slower_down')} onClick={() => step(-1)} />
      {/* (a new course can be engaged mid-journey: AstrogationScreen::engage takes wasInTransit into account, astrogation.cpp:1852-1856) */}
      <PaintedButton id="engage" label="Engage" rect={[392, 161, 245, 28]} plate={plate !== null} disabled={course === null || !exitsEnabled} sprite={sprites('engage', 'engage_down')} onClick={engageNow} />
      <PaintedButton id="stop" label="Stop" rect={[392, 189, 245, 28]} plate={plate !== null} disabled={transit === null} sprite={sprites('stop', 'stop_down')} onClick={() => attempt(() => port.stopTransit())} />
      {/* (the speed, drawn at x 425 for warp and 578 for impulse, y 97: drawCoursePanel) */}
      <output class="au-astro-speed" data-readout="speed" style={plate !== null ? areaStyle([useWarp ? 425 : 578, 97, 40, 18]) : undefined}>{speedText}</output>
      {bt('label', speedText, useWarp ? 425 : 578, 97, 'speed')}
    </>
  );
  // (drawButtons: the original's picture of a pad button or cursor arrow while it is held, over the plate's own)
  const heldFor = (id: string) => {
    if (id.startsWith('pad-')) return art?.panel(`pad_${id.slice(4)}_down` as AstroPanelSprite);
    if (id.startsWith('cursor-')) return art?.panel(id.endsWith('-up') ? 'arrow_up_down' : 'arrow_down_down');
    return undefined;
  };
  // (mouseMove, astrogation.cpp:1917-1925: over an exit that is open the pointer is the lit use pointer, elsewhere the arrow)
  const exitCursor = port.exitCursor();
  const mapClick = (id: string): (() => void) => {
    const pad = ['pad-up', 'pad-down', 'pad-left', 'pad-right', 'pad-stop'].indexOf(id);
    if (pad >= 0) return () => port.mapPad(pad);
    if (id.startsWith('view-')) return () => port.mapView(id.slice(5) as MapView);
    const [, axis, dir] = id.split('-');
    return () => port.mapCursor(['x', 'y', 'z'].indexOf(axis), dir === 'up' ? 1 : -1);
  };
  const painted = (
    <>
      {/* (the exit block: AstrogationScreen's exits go to the bridge, the computer and engineering, astrogation.cpp kExitCodes) */}
      {PAINTED_EXITS.map(b => (
        <PaintedButton key={b.id} id={b.id} label={b.label} rect={b.rect} plate={plate !== null} disabled={!exitsEnabled} held={art?.panel(`exit_${b.to}_down` as AstroPanelSprite)}
          cursor={plate !== null ? exitCursor : undefined} onClick={() => attempt(() => port.station(b.to))} />
      ))}
      {PAINTED_TABS.map(b => (
        <PaintedButton key={b.id} id={b.id} label={b.label} rect={b.rect} plate={plate !== null} pressed={b.id === `tab-${cam.panel}`} onClick={() => port.mapPanel(b.id.slice(4) as MapPanel)} />
      ))}
      {courseControls}
      {PAINTED_MAP.map(b => (
        <PaintedButton key={b.id} id={b.id} label={b.label} rect={b.rect} plate={plate !== null} pressed={b.id.startsWith('view-') ? b.id === `view-${cam.view}` : undefined}
          held={heldFor(b.id)} lit={b.id.startsWith('view-') ? art?.panel(`view_${b.id.slice(5)}_lit` as AstroPanelSprite) : undefined} onClick={mapClick(b.id)} />
      ))}
      {/* (how the map is turned, in degrees: the original draws these over the map's lower corners) */}
      <span class="au-astro-angle" data-readout="elevation" style={plate !== null ? areaStyle(ELEVATION_AT) : undefined}>{`°E: ${String(cam.elevation).padStart(3, '0')}`}</span>
      <span class="au-astro-angle" data-readout="azimuth" style={plate !== null ? areaStyle(AZIMUTH_AT) : undefined}>{`°A: ${String(cam.azimuth).padStart(3, '0')}`}</span>
      {/* (the sector at the top, and the cursor's and the ship's coordinates in the plate's two fields: drawTitle and drawCoordinates) */}
      {plate !== null && <span class="au-astro-title" data-readout="title" style={areaStyle(TITLE_AT)}>{text.title}</span>}
      {plate !== null && text.cursor.map((n, i) => <span key={`c${i}`} class="au-astro-coord" data-readout={`cursor-${'xyz'[i]}`} style={areaStyle(cursorAt(i))}>{String(n).padStart(2, '0')}</span>)}
      {plate !== null && text.ship.map((n, i) => <span key={`s${i}`} class="au-astro-coord" data-readout={`ship-${'xyz'[i]}`} style={areaStyle(shipAt(i))}>{String(n).padStart(2, '0')}</span>)}
      {plate !== null && opening < 2 && (() => {
        const message = opening === 0 ? text.messages?.[0] : text.messages?.[2];
        if (!message) return null;
        const x = opening === 0 ? 80 : 73;
        return (
          <>
            {bt('label', message, x, 140, 'opening')}
            <span class={fonts ? 'au-visually-hidden' : 'au-astro-opening'} data-opening={opening} style={fonts ? undefined : areaStyle([x, 140, 300, 19])}>{message}</span>
          </>
        );
      })()}
      {/* (the same in the game's own font, where the original draws them: drawTitle, drawCoordinates, drawInfoPanel and drawDisplayPanel) */}
      {fonts && (
        <>
          {/* (the plate's title field is blue, not the original's black: the letters are the font's, in the plate's dark ink as the CSS text was) */}
          {bt('label', text.title, 101, 1, 'title', TITLE_INK)}
          {text.cursor.map((n, i) => bt('info', String(n).padStart(2, '0'), 197 + 32 * i, 417, `c${i}`))}
          {text.ship.map((n, i) => bt('info', String(n).padStart(2, '0'), 318 + 32 * i, 417, `s${i}`))}
          {bt('label', `@E: ${String(cam.elevation).padStart(3, '0')}`, 16, 344, 'elevation')}
          {bt('label', `@A: ${String(cam.azimuth).padStart(3, '0')}`, 325, 344, 'azimuth')}
          {cam.panel === 'display' && labels.map((label, i) => bt('label', label, 528, SWITCH_TOPS[i]!, `switch${i}`))}
          {cam.panel === 'info' && detail.lines.length > 0 && bt('info', detail.title, 399, 98, 'info-title')}
          {cam.panel === 'info' && infoLines.map((line, i) => bt('info', line, 399, 134 + 18 * i, `info${i}`))}
        </>
      )}
      {/* (the Display tab, as drawDisplayPanel draws it: a bar for each switch, lit or not, with its label beside, over the swatches' picture) */}
      {plate !== null && cam.panel === 'display' && (() => {
        const bottom = art?.panel('display_bottom');
        return (
          <>
            {bottom && <img class="au-astro-sprite" src={bottom.url} alt="" style={areaStyle([...bottom.rect])} />}
            {labels.map((label, i) => {
              const left = switchLeft(i), width = 637 - left;
              return (
                <label key={i} class="au-astro-switch" data-switch={i} style={areaStyle([left, SWITCH_TOPS[i]!, width, 20])}>
                  <input type="checkbox" class="au-visually-hidden" data-display={i} checked={cam.display[i]} onChange={() => port.mapDisplay(i)} />
                  <span class="au-astro-bar" data-on={cam.display[i] ? '' : undefined} style={{ width: `${((520 - left) / width) * 100}%` }} />
                  <span class="au-astro-switch-label" style={{ left: `${((528 - left) / width) * 100}%` }}>{label}</span>
                </label>
              );
            })}
          </>
        );
      })()}
    </>
  );
  const notes = (
    <>
      {refused !== null && <p class="au-problem" role="alert">{REASONS[refused]}</p>}
      {problem !== null && <p class="au-problem" role="alert">{problem}</p>}
    </>
  );
  if (plate === null) {
    return (
      <div class="au-astro" data-cursor={cursorAttr}>
        <h2>Astrogation</h2>
        {info}
        {notes}
        <div class="au-astro-painted">{painted}</div>
      </div>
    );
  }
  return (
    <div class="au-astro au-astro-plate" data-cursor={cursorAttr} data-bitmap={fonts ? '' : undefined}>
      <div key="screen" class="au-ship-screen" ref={screenRef} style={{ aspectRatio: '640 / 480' }}>
        <h2 class="au-visually-hidden">Astrogation</h2>
        {/* (the original's pictures go first, under everything: the tab strip or the course panel, and the engine's frame on it) */}
        {panelPicture && <img class="au-astro-sprite" data-panel={panelName} src={panelPicture.url} alt="" draggable={false} style={areaStyle([...panelPicture.rect])} />}
        {frames && <img class="au-astro-sprite" data-engine={engineFrame % frames.length} src={frames[engineFrame % frames.length]!.url} alt="" draggable={false} style={areaStyle([...frames[engineFrame % frames.length]!.rect])} />}
        <div {...at('info')} {...(cam.panel === 'display' ? { 'data-passive': '' } : {})} {...(panelPicture ? { 'data-clear': '' } : {})}>{info}{notes}</div>
        {courseArt && <div class="au-astro-journey" style={areaStyle([393, 336, 243, 24])}>{journey}</div>}
        {painted}
      </div>
    </div>
  );
}
