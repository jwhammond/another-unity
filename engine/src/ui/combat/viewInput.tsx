// SPDX-License-Identifier: GPL-3.0-or-later
import type { JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { NO_AXES, type Axes } from '../../view/combat/consoleInput';
import { dragAxes, isClick } from '../../view/combat/controls';

/** What the view under the pointer does (the console's own ways: console.tsx). */
export interface ViewActions {
  /** A click or a tap at (fx, fy) of the view, fractions of its width and height from its top left: the ship there becomes the target. */
  pick(fx: number, fy: number): void;
  /** What a drag holds now: NO_AXES as it ends. */
  drag(axes: Axes): void;
  /** The wheel turned: away from the player zooms in, towards out. */
  zoom(direction: 'in' | 'out'): void;
}

/**
 * The space view under the pointer (M8 spec §6.1, Decision 17; Plan 29 R6, R7), a clear surface over where the view is drawn:
 * hold and drag to steer (past 24 px each way, as the keys that match), a press that moves under 6 px and ends within 250 ms a
 * click, which targets the ship under it; the wheel zooms. A pointer, a pen or a touch alike: on a phone a tap targets and a drag
 * steers. `where` puts a pointer on the view (fractions of its box), or null off it; `now` is the wall clock in ms. The port's
 * own: the original's view takes no click. A drag lets go as the surface goes too (Split and Wide each have their own, so a switch
 * between them mid-drag unmounts it, and its pointer capture goes to the document, not to its handlers).
 */
export function ViewSurface({ act, where, now, class: cls, style }: {
  act: ViewActions; where: (clientX: number, clientY: number, surface: HTMLElement) => [number, number] | null; now: () => number; class: string; style?: JSX.CSSProperties;
}): JSX.Element {
  /** The press going on: where and when it began, and what it holds. */
  const press = useRef<{ id: number; x: number; y: number; at: number; held: string } | null>(null);
  /** The latest render's actions, for the let-go as the surface goes. */
  const actRef = useRef(act);
  actRef.current = act;
  const end = () => {
    const p = press.current;
    press.current = null;
    if (p && p.held !== JSON.stringify(NO_AXES)) actRef.current.drag(NO_AXES);
  };
  useEffect(() => () => end(), []);
  return (
    <div class={cls} style={style} role="img" aria-label="Space view: drag to steer, click a ship to target it" data-view-input=""
      onPointerDown={e => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        end();
        press.current = { id: e.pointerId, x: e.clientX, y: e.clientY, at: now(), held: JSON.stringify(NO_AXES) };
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={e => {
        const p = press.current;
        if (!p || p.id !== e.pointerId) return;
        const axes = dragAxes(e.clientX - p.x, e.clientY - p.y);
        const held = JSON.stringify(axes);
        if (held === p.held) return;
        p.held = held;
        act.drag(axes);
      }}
      onPointerUp={e => {
        const p = press.current;
        if (!p || p.id !== e.pointerId) return;
        const click = isClick(e.clientX - p.x, e.clientY - p.y, now() - p.at);
        end();
        const at = click ? where(e.clientX, e.clientY, e.currentTarget as HTMLElement) : null;
        if (at) act.pick(...at);
      }}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onWheel={e => {
        if (e.deltaY === 0) return;
        e.preventDefault();
        act.zoom(e.deltaY < 0 ? 'in' : 'out');
      }} />
  );
}
