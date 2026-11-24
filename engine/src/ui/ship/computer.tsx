// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useRef } from 'preact/hooks';
import type { Rect } from '../../view/art';
import type { ShipPort } from '../../web/shipPort';
import { areaStyle } from './areas';
import { useAttempt, usePort } from './hooks';
import { PaintedButton } from './painted';

/**
 * The ship's computer (ComputerScreen, computer.cpp): the tree's rows on the left, the selected entry on the right, and
 * the buttons to leave. The entry text wraps and scrolls with CSS: the original's line breaks are presentation.
 *
 * With a plate (Plan 16 R17) the same sections sit in a 4:3 `.au-ship-screen` box over the repainted screen, each in its named area:
 * the rows list in `rows`, the entry in `entry`, Up and Down over the two painted round arrows (`scroll`, which keeps the painted arrows
 * showing) and Bridge, Astrogation and Tactical as clear buttons over the plate's own grey exit buttons. The markup, labels, order and handlers are the same.
 */
/**
 * The two painted round arrows (computer.cpp kButtons): each is an up half over a down half, the left one scrolling the list and the right
 * one the entry's text, as [x, y, w, h] in the original's pixels.
 */
/** The three grey exit buttons the plate paints (computer.cpp kButtons), [x, y, w, h]. */
const EXITS: { to: 'bridge' | 'astrogation' | 'tactical'; label: string; rect: Rect }[] = [
  { to: 'bridge', label: 'Bridge', rect: [490, 370, 112, 30] },
  { to: 'astrogation', label: 'Astrogation', rect: [490, 402, 112, 30] },
  { to: 'tactical', label: 'Tactical', rect: [490, 434, 112, 30] },
];

const SCROLL_BUTTONS: Record<'listUp' | 'listDown' | 'textUp' | 'textDown', Rect> = {
  listUp: [61, 412, 57, 28], listDown: [61, 440, 57, 28], textUp: [217, 412, 57, 28], textDown: [217, 440, 57, 28],
};

/** Scroll the entry's text by a few lines (the original moves it a line at a time; the box wraps its own lines). */
export function scrollText(el: HTMLElement | null, by: -1 | 1): void {
  if (el === null) return;
  const line = parseFloat(getComputedStyle(el).lineHeight) || 16;
  el.scrollTop = Math.max(0, el.scrollTop + by * line * 3);
}

export function ComputerPanel({ port }: { port: ShipPort }) {
  usePort(port);
  const entryRef = useRef<HTMLElement>(null);
  const [problem, attempt] = useAttempt();
  const view = port.computer();
  const plate = view === null ? null : port.shipPlate('computer');
  // (the box registers while it is up and goes with it, as the bridge's does)
  const screenRef = useCallback((el: HTMLDivElement | null) => port.screenRect(el ? () => el.getBoundingClientRect() : null), [port]);
  if (view === null) return null;
  const areas = plate?.areas ?? {};
  /** A section's place: the class and style that put it in its area, when there is a plate with that area. `base` is its own class. */
  const at = (area: string, base: string): { class: string; style?: ReturnType<typeof areaStyle>; 'data-area'?: string } => {
    const rect: Rect | undefined = areas[area];
    return plate !== null && rect !== undefined ? { class: `${base} au-area au-computer-${area}`, style: areaStyle(rect), 'data-area': area } : { class: base };
  };
  // (the scroll halves sit at their own places over the painted arrows: the `scroll` area holds them without a box of its own)
  const plated = plate !== null;
  const body = (
    <>
      <ul {...at('rows', 'au-ship-computer-rows')} aria-label="Entries">
        {view.rows.map((row, i) => (
          <li key={i}>
            <button
              type="button"
              data-row={i}
              data-child={row.child ? 'true' : 'false'}
              aria-current={row.selected ? 'true' : undefined}
              onClick={() => attempt(() => port.computerRow(i))}
            >{row.title}</button>
          </li>
        ))}
      </ul>
      <div {...at('scroll', 'au-ship-computer-scroll')}>
        <PaintedButton id="list-up" label="Scroll the list up" text="Up" rect={SCROLL_BUTTONS.listUp} plate={plated} disabled={!view.canScrollUp} onClick={() => attempt(() => port.computerScroll(-1))} />
        <PaintedButton id="list-down" label="Scroll the list down" text="Down" rect={SCROLL_BUTTONS.listDown} plate={plated} disabled={!view.canScrollDown} onClick={() => attempt(() => port.computerScroll(1))} />
        <PaintedButton id="text-up" label="Scroll the entry up" text="Text up" rect={SCROLL_BUTTONS.textUp} plate={plated} onClick={() => scrollText(entryRef.current, -1)} />
        <PaintedButton id="text-down" label="Scroll the entry down" text="Text down" rect={SCROLL_BUTTONS.textDown} plate={plated} onClick={() => scrollText(entryRef.current, 1)} />
      </div>
      <article ref={entryRef} {...at('entry', 'au-ship-computer-entry')} aria-label="Entry">
        <h2>{view.heading}</h2>
        <p>{view.text}</p>
      </article>
      <div class="au-ship-bar au-computer-exits">
        {EXITS.map(e => (
          <PaintedButton key={e.to} id={`exit-${e.to}`} label={e.label} rect={e.rect} plate={plated} onClick={() => attempt(() => port.computerLeave(e.to))} />
        ))}
      </div>
      {problem !== null && <p class={plate !== null ? 'au-problem au-computer-note' : 'au-problem'} role="alert">{problem}</p>}
    </>
  );
  if (plate === null) return <div class="au-ship-computer">{body}</div>;
  return (
    <div class="au-ship-computer au-computer-plate">
      <div key="screen" class="au-ship-screen" ref={screenRef} style={{ aspectRatio: '640 / 480' }}>{body}</div>
    </div>
  );
}
