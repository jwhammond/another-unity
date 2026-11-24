// SPDX-License-Identifier: GPL-3.0-or-later
import type { JSX } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { RefObject } from 'preact';
import type { Rect } from '../../view/art';
import type { TransporterSpriteName } from '../faces';
import type { ShipPort } from '../../web/shipPort';
import { areaStyle } from './areas';
import { MAP_RECT } from '../../view/transporterMap';
import { PaintedButton } from './painted';
import { useAttempt, usePort } from './hooks';

/** The pads list and the Recommended/Energize bar share the `controls` area: the bar is this share of its height, the pads the rest. */
const BAR_SHARE = 44 / 124;

/** The top part and the bottom part of a rectangle, split by a share of its height (the bar's). */
function split(rect: Rect, bar: number): { top: Rect; bottom: Rect } {
  const barH = Math.round(rect[3] * bar);
  return { top: [rect[0], rect[1], rect[2], rect[3] - barH], bottom: [rect[0], rect[1] + rect[3] - barH, rect[2], barH] };
}

/**
 * The buttons the original paints on the room's console and in the room (transporter.cpp listsButton .. exitDoor), [x, y, w, h] in its
 * pixels: the lists and map buttons, the lists' round up/down arrow, the kit's round left/right arrow, and the door.
 */
const PAINTED: Record<'lists' | 'map' | 'listUp' | 'listDown' | 'kitLeft' | 'kitRight' | 'door' | 'sliders', Rect> = {
  // (the sliders reach x 543 in the original; trimmed to the painted rails so they do not overlap the exits at 538)
  sliders: [418, 291, 119, 117],
  // (the lists and map buttons overlap each other and the lists by a few pixels in the original: trimmed to their own faces here)
  lists: [7, 300, 43, 59], map: [7, 359, 43, 64], listUp: [210, 359, 48, 24], listDown: [210, 383, 48, 24],
  kitLeft: [297, 424, 24, 53], kitRight: [321, 424, 26, 53], door: [63, 79, 25, 201],
};
/** Recommended's place, under the exits, over the console's plain blue elbow (the original has no button for it). */
const RECOMMENDED: Rect = [538, 340, 102, 22];

/** The kit's eight slots (transporter.cpp kKitSlotX, kKitY): four, the round arrow's gap, four. */
const KIT_SLOT_X = [71, 125, 179, 233, 357, 411, 465, 519] as const;
/** The preview box, where the chosen equipment's icon is drawn (previewBox, transporter.cpp:86 region: the original draws it at 235, 345). */
const PREVIEW: Rect = [208, 293, 53, 53];

/** Whether a scrolling list has more before it and after it: the original greys the arrows at the ends (transporter.cpp:828-829, 851-852). */
function useScrollEnds(ref: RefObject<HTMLElement>): { back: boolean; more: boolean } {
  const [ends, setEnds] = useState({ back: false, more: false });
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const next = { back: el.scrollTop > 0, more: el.scrollTop + el.clientHeight < el.scrollHeight - 1 };
    setEnds(prev => (prev.back === next.back && prev.more === next.more ? prev : next));
  }, [ref]);
  // (after every render: the list's contents change as things are moved)
  useLayoutEffect(measure);
  useEffect(() => {
    const el = ref.current;
    el?.addEventListener('scroll', measure);
    return () => el?.removeEventListener('scroll', measure);
  }, [ref, measure]);
  return ends;
}

/** Scroll a list by one of its rows (the original moves its lists a row at a time). */
export function scrollRows(list: HTMLElement | null | undefined, by: -1 | 1): void {
  if (!list) return;
  const row = list.firstElementChild instanceof HTMLElement ? list.firstElementChild.offsetHeight : 0;
  list.scrollTop = Math.max(0, list.scrollTop + by * (row || 16));
}

/**
 * The transporter room (TransporterScreen, transporter.cpp) on a flat greybox: four pads, the crew aboard, the
 * equipment and the kit, Recommended and Energize, and the room's exits. Names come from content; the words are ours.
 *
 * With a plate (Plan 16 R16) the same sections sit in a 4:3 `.au-ship-screen` box, each in its named area of the repainted room's
 * console (equipment, crew, kit, exits). The markup, labels, order and handlers are the same; the headings are visually hidden but stay in
 * the accessibility tree. The lists and the kit lie in the console's painted rows and slots with no ground of their own; Energize is a clear
 * button over the painted sliders and each pad's crew member a clear button over the pad (the original's padAt), where the session draws
 * them; Recommended sits under the exits.
 */
export function TransporterPanel({ port }: { port: ShipPort }) {
  usePort(port);
  const [problem, attempt] = useAttempt();
  // (the list the round arrow scrolls: the one last clicked, as the original's _focus)
  const [focus, setFocus] = useState<'crew' | 'equipment'>('crew');
  const [door, setDoor] = useState(false);
  const crewList = useRef<HTMLUListElement>(null);
  const equipmentList = useRef<HTMLUListElement>(null);
  const kitList = useRef<HTMLUListElement>(null);
  const view = port.transporter();
  const plate = view === null ? null : port.shipPlate('transporter');
  // (the equipment shown in the preview box: the row the pointer or focus last was on)
  const [chosen, setChosen] = useState<string | null>(null);
  const crewEnds = useScrollEnds(crewList);
  const equipmentEnds = useScrollEnds(equipmentList);
  const kitEnds = useScrollEnds(kitList);
  // (the box registers while it is up and goes with it, as the bridge's does)
  const screenRef = useCallback((el: HTMLDivElement | null) => port.screenRect(el ? () => el.getBoundingClientRect() : null), [port]);
  if (view === null) return null;
  const { room, name } = view;

  const areas = plate?.areas ?? {};
  /** A section's place: the class and style that put it in its area, when there is a plate with that area. `base` is its own class. */
  const at = (area: string, base?: string, rect: Rect | undefined = areas[area]): { class?: string; style?: ReturnType<typeof areaStyle>; 'data-area'?: string } =>
    plate !== null && rect !== undefined
      ? { class: `${base ? `${base} ` : ''}au-area au-transporter-${area}`, style: areaStyle(rect), 'data-area': area }
      : base ? { class: base } : {};
  const heading = plate !== null ? 'au-visually-hidden' : undefined;
  const controls = areas.controls !== undefined ? split(areas.controls, BAR_SHARE) : null;

  // (the original's console pictures, when published: the buttons are clear over them, the arrows grey where their list has no more)
  const art = plate !== null ? port.transporterSprites() : null;
  const pair = (up: TransporterSpriteName, down: TransporterSpriteName = up) => (art ? { sprite: { up: art.sprite(up), down: art.sprite(down) } } : {});
  const listEnds = focus === 'crew' ? crewEnds : equipmentEnds;
  const mapUp = view.map.showing;
  const spriteFor: Partial<Record<keyof typeof PAINTED, ReturnType<typeof pair>>> = art === null ? {} : {
    // (draw: the button of the view that is up is lit; the crew figure is 14/15 and the planet 16/17, see docs/unity-ship-buttons.md)
    lists: mapUp ? pair('lists', 'lists_on') : pair('lists_on'),
    map: mapUp ? pair('map_on') : pair('map', 'map_on'),
    listUp: pair(listEnds.back ? 'up' : 'up_grey'),
    listDown: pair(listEnds.more ? 'down' : 'down_grey'),
    kitLeft: pair(kitEnds.back ? 'left' : 'left_grey'),
    kitRight: pair(kitEnds.more ? 'right' : 'right_grey'),
  };
  const paintedButton = (id: keyof typeof PAINTED, label: string, onClick: () => void, extra: { pressed?: boolean; expanded?: boolean } = {}) => (
    <PaintedButton id={id} label={label} rect={PAINTED[id]} plate={plate !== null} onClick={onClick} {...spriteFor[id]} {...extra} />
  );
  /** An item as the kit and the preview show it: its icon with the art on (the name stays for the screen reader), else its name. */
  const itemFace = (id: string) => {
    const icon = plate !== null ? port.itemIcon(id) : undefined;
    return icon === undefined
      ? name(id)
      : <><img class="au-transporter-icon" src={icon} alt="" draggable={false} /><span class="au-visually-hidden">{name(id)}</span></>;
  };
  // (the original shows it for the list chosen from, its selected row: here the row pointed at, or the first once the equipment list is the one in use)
  const previewId = chosen !== null && room.equipment.includes(chosen) ? chosen : focus === 'equipment' ? room.equipment[0] : undefined;
  const previewIcon = plate !== null && previewId !== undefined ? port.itemIcon(previewId) : undefined;
  // (the kit tray: four slots, the round arrow, four slots, as the original's)
  const kit = plate !== null ? areas.kit : undefined;
  const kitStyle = kit === undefined ? undefined : (() => {
    const from = ((PAINTED.kitLeft[0] - kit[0]) / kit[2]) * 100;
    const to = ((PAINTED.kitRight[0] + PAINTED.kitRight[2] - kit[0]) / kit[2]) * 100;
    return { gap: to - from };
  })();
  /** A pad's crew button: over the pad in the room with a plate (the original's padAt rectangle, [x1, y1, x2, y2]), in the list without. */
  const pads = plate !== null ? port.transporterPads() : [];
  const onPad = (i: number, button: JSX.Element) => {
    const r = pads.find(p => p.pad === i)?.rect;
    return r === undefined ? button : <span class="au-painted" data-area={`pad-${i}`} style={areaStyle([r[0], r[1], r[2] - r[0], r[3] - r[1]])}>{button}</span>;
  };
  // (the map: the world's own picture with the scan's lines and the blip over it, or the same in CSS; both say where the scan is for a screen reader)
  const mapArt = art?.map();
  const mapState = !view.map.hasTarget ? 'none' : view.map.locked ? 'locked' : 'scanning';
  const rectOf = (r: Rect, sprite?: { rect: readonly [number, number, number, number] }): Rect => (sprite ? [r[0], r[1], sprite.rect[2], sprite.rect[3]] : r);
  const mapText = mapState === 'none' ? 'No beamdown locations.' : mapState === 'locked' ? 'Target locked.' : 'Scanning for the target.';
  const worldPic = mapArt?.world(view.map.world) ?? mapArt?.world(0);
  const blipFrame = mapArt ? Math.floor(view.map.blipTime / mapArt.blip.ms) % mapArt.blip.frames.length : 0;
  const mapLayers = (
    <>
      {plate !== null && mapArt !== undefined && worldPic !== undefined ? (
        <>
          <span class="au-painted-sprite au-transporter-map" data-map="picture" data-world={view.map.world} style={areaStyle(rectOf(MAP_RECT, worldPic))}><img src={worldPic.url} alt="" draggable={false} /></span>
          <span class="au-painted-sprite au-transporter-scan" data-map="across" style={areaStyle(rectOf(view.map.across, mapArt.across))}><img src={mapArt.across.url} alt="" draggable={false} /></span>
          {view.map.down !== null && (
            <span class="au-painted-sprite au-transporter-scan" data-map="down" style={areaStyle(rectOf(view.map.down, mapArt.down))}><img src={mapArt.down.url} alt="" draggable={false} /></span>
          )}
          {view.map.blip !== null && (
            <span class="au-painted-sprite au-transporter-scan" data-map="blip" data-frame={blipFrame} style={areaStyle(view.map.blip)}><img src={mapArt.blip.frames[blipFrame]!.url} alt="" draggable={false} /></span>
          )}
        </>
      ) : plate !== null ? (
        <>
          <span class="au-painted-sprite au-transporter-map au-transporter-map-css" data-map="css" data-world={view.map.world} style={areaStyle(MAP_RECT)}>{mapText}</span>
          <span class="au-painted-sprite au-transporter-scan au-transporter-scan-css" data-map="across" style={areaStyle(view.map.across)} />
          {view.map.down !== null && <span class="au-painted-sprite au-transporter-scan au-transporter-scan-css" data-map="down" style={areaStyle(view.map.down)} />}
          {view.map.blip !== null && <span class="au-painted-sprite au-transporter-scan au-transporter-blip-css" data-map="blip" style={areaStyle(view.map.blip)} />}
        </>
      ) : null}
      <section aria-label="Map" data-map-state={mapState} {...(plate !== null ? { class: 'au-visually-hidden' } : {})}>
        <h3 class={heading}>Map</h3>
        {/* (with no target the room's own note says so) */}
        <p role={mapState === 'none' ? undefined : 'status'}>{mapText}</p>
      </section>
    </>
  );
  const body = (
    <>
      {art !== null && (
        <>
          {/* (the kit's eight slots, under the kit's own buttons) */}
          {KIT_SLOT_X.map(x => (
            <span key={x} class="au-painted-sprite au-transporter-slot" data-sprite="kit_slot" style={areaStyle([x, art.sprite('kit_slot').rect[1], art.sprite('kit_slot').rect[2], art.sprite('kit_slot').rect[3]])}>
              <img src={art.sprite('kit_slot').url} alt="" draggable={false} />
            </span>
          ))}
        </>
      )}
      {!mapUp && previewIcon !== undefined && (
        <span class="au-painted-sprite au-transporter-preview" data-preview={previewId} style={areaStyle(PREVIEW)}><img src={previewIcon} alt="" draggable={false} /></span>
      )}
      {mapUp && mapLayers}
      <h2 class={heading}>Transporter room</h2>
      {room.target === null && <p role="status" class={plate !== null ? 'au-transporter-note' : undefined}>No transporter target.</p>}
      <section aria-label="Pads" {...(plate !== null ? { class: 'au-transporter-room-pads' } : at('controls', undefined, controls?.top))}>
        <h3 class={heading}>Pads</h3>
        <ol class="au-transporter-pads">
          {room.pads.map((crew, i) => (
            <li key={i}>
              {crew === null
                ? <span class={plate !== null ? 'au-visually-hidden' : 'au-transporter-empty'}>Empty</span>
                : onPad(i, <button type="button" class={plate !== null ? 'au-painted-btn' : undefined} data-pad={i} disabled={view.walking.includes(i)} onClick={() => attempt(() => port.unpad(i))}>{name(crew)}</button>)}
            </li>
          ))}
        </ol>
      </section>
      <section aria-label="Crew" hidden={mapUp} {...at('crew')} onClick={() => setFocus('crew')}>
        <h3 class={heading}>Crew</h3>
        <ul ref={crewList}>
          {room.crew.map(id => (
            <li key={id}><button type="button" data-crew={id} onClick={() => attempt(() => port.pad(id))}>{name(id)}</button></li>
          ))}
        </ul>
      </section>
      <section aria-label="Equipment" hidden={mapUp} {...at('equipment')} onClick={() => setFocus('equipment')}>
        <h3 class={heading}>Equipment</h3>
        <ul ref={equipmentList}>
          {room.equipment.map(id => (
            <li key={id}><button type="button" data-item={id} onPointerEnter={() => setChosen(id)} onFocus={() => setChosen(id)} onClick={() => attempt(() => port.kit(id))}>{name(id)}</button></li>
          ))}
        </ul>
      </section>
      <section aria-label="Kit" {...at('kit')} >
        <h3 class={heading}>Kit</h3>
        <ul ref={kitList} class={kitStyle ? 'au-transporter-kit-tray' : undefined} style={kitStyle ? { gridTemplateColumns: `repeat(4, 1fr) ${kitStyle.gap}% repeat(4, 1fr)` } : undefined}>
          {room.kit.map(id => (
            <li key={id}><button type="button" data-kit={id} class={port.itemIcon(id) !== undefined && plate !== null ? 'au-transporter-icon-btn' : undefined} onClick={() => attempt(() => port.unkit(id))}>{itemFace(id)}</button></li>
          ))}
        </ul>
      </section>
      <div {...(plate !== null ? { class: 'au-ship-bar au-transporter-bar' } : at('controls', 'au-ship-bar', controls?.bottom))}>
        {plate !== null
          ? <span class="au-area au-transporter-recommended" data-area="recommended" style={areaStyle(RECOMMENDED)}><button type="button" onClick={() => attempt(() => port.recommend())}>Recommended</button></span>
          : <button type="button" onClick={() => attempt(() => port.recommend())}>Recommended</button>}
        {/* (pulling the painted sliders energizes, transporter.cpp:673) */}
        <PaintedButton id="sliders" label="Energize" rect={PAINTED.sliders} plate={plate !== null} disabled={!view.canEnergize} onClick={() => attempt(() => port.energize())} />
      </div>
      <ul aria-label="Exits" {...at('exits', 'au-transporter-exits')}>
        {view.exits.map(exit => (
          <li key={exit.code}><button type="button" data-code={exit.code} onClick={() => attempt(() => port.leave(exit.code))}>{exit.label}</button></li>
        ))}
      </ul>
      <div class="au-transporter-painted" aria-label="Console">
        {paintedButton('lists', 'Lists', () => port.transporterShowMap(false), { pressed: !mapUp })}
        {paintedButton('map', 'Map', () => port.transporterShowMap(true), { pressed: mapUp })}
        {/* (the lists' round arrow is drawn only with the lists up) */}
        {!mapUp && paintedButton('listUp', 'List up', () => scrollRows(focus === 'crew' ? crewList.current : equipmentList.current, -1))}
        {!mapUp && paintedButton('listDown', 'List down', () => scrollRows(focus === 'crew' ? crewList.current : equipmentList.current, 1))}
        {paintedButton('kitLeft', 'Kit left', () => scrollRows(kitList.current, -1))}
        {paintedButton('kitRight', 'Kit right', () => scrollRows(kitList.current, 1))}
        {paintedButton('door', 'Door', () => { port.sound(door ? 'doorClose' : 'doorOpen'); setDoor(!door); }, { expanded: door })}
      </div>
      {door && (
        <ul class="au-ship-lift au-transporter-door" aria-label="Door">
          {view.exits.map(exit => (
            <li key={exit.code}><button type="button" data-door-code={exit.code} onClick={() => { setDoor(false); attempt(() => port.leave(exit.code)); }}>{exit.label}</button></li>
          ))}
          <li><button type="button" onClick={() => setDoor(false)}>Cancel</button></li>
        </ul>
      )}
      {problem !== null && <p class={plate !== null ? 'au-problem au-transporter-note' : 'au-problem'} role="alert">{problem}</p>}
    </>
  );
  if (plate === null) return <div class="au-transporter">{body}</div>;
  return (
    <div class="au-transporter au-transporter-plate">
      <div key="screen" class="au-ship-screen" ref={screenRef} style={{ aspectRatio: '640 / 480' }}>{body}</div>
    </div>
  );
}
