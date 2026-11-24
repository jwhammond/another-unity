// SPDX-License-Identifier: GPL-3.0-or-later
import type { JSX } from 'preact';
import { useRef, useState } from 'preact/hooks';
import type { Rect } from '../../view/art';
import type { AstroSprite } from '../faces';
import { areaStyle } from './areas';

/**
 * A button the original paints on a ship screen's background. With a plate it is a clear button over its painted place: a `data-area`
 * box at the original's rectangle (so the button's attributes are the same with art on and off), outlined and named with the hotspots on.
 * Without a plate it is a plain button where its panel puts it.
 */
export function PaintedButton({ id, label, text, rect, plate, onClick, disabled, pressed, expanded, hold, sprite, art, held, lit, cursor }: {
  /** `label` is its accessible name; `text` what it says, when shorter (the label by default). */
  id: string; label: string; text?: string; rect: Rect; plate: boolean; onClick: () => void;
  disabled?: boolean; pressed?: boolean; expanded?: boolean;
  /** Held down, it repeats `onClick` every `hold` milliseconds after a pause (the original's Faster and Slower, changeSpeed). */
  hold?: number;
  /**
   * The original's sprite for this button and its pressed frame (a plate only): drawn at the sprite's own rectangle, the pressed frame while the
   * pointer is down on the button; the button itself is clear over it. Without it the button is drawn in CSS.
   */
  sprite?: { up: AstroSprite; down: AstroSprite };
  /** The place is painted with the original's own picture that is not this button's (the course panel's Warp and Impulse): the button is clear over it, as with a sprite. */
  art?: boolean;
  /**
   * The original's picture of the button while it is held (`_pressed` in drawButtons: the pad, the cursor arrows and the exits), for a plate that paints the unpressed
   * button itself: drawn at the button's own corner, at the picture's own size, only while the pointer is down on it.
   */
  held?: AstroSprite;
  /** The original's picture of the button while it is on (`pressed`; the view the map shows), drawn the same way for as long as it is. */
  lit?: AstroSprite;
  /** The pointer over the button (a CSS `cursor` value), when it is not the page's own hand: astrogation's exits show the lit use pointer (setCursor(3)). */
  cursor?: string;
}): JSX.Element {
  const [down, setDown] = useState(false);
  const timer = useRef<{ wait: ReturnType<typeof setTimeout>; every?: ReturnType<typeof setInterval>; repeated: boolean } | null>(null);
  const release = () => {
    setDown(false);
    const t = timer.current;
    if (!t) return;
    clearTimeout(t.wait);
    if (t.every !== undefined) clearInterval(t.every);
    // (the click that ends a long hold is not another step)
    setTimeout(() => { if (timer.current === t) timer.current = null; }, 0);
  };
  const press = () => {
    setDown(true);
    if (hold === undefined) return;
    const t: NonNullable<typeof timer.current> = { wait: setTimeout(() => { t.repeated = true; t.every = setInterval(onClick, hold); }, 500), repeated: false };
    timer.current = t;
  };
  const button = (
    <button
      type="button"
      class={plate && (sprite || art) ? 'au-painted-btn au-painted-art' : 'au-painted-btn'}
      data-painted={id}
      aria-label={label}
      aria-pressed={pressed}
      aria-expanded={expanded}
      disabled={disabled}
      style={cursor !== undefined && !disabled ? { cursor } : undefined}
      onPointerDown={press}
      onPointerUp={release}
      onPointerLeave={release}
      onPointerCancel={release}
      onClick={() => { if (timer.current?.repeated) return; onClick(); }}
    >{text ?? label}</button>
  );
  if (!plate) return button;
  const shown = sprite === undefined ? null : down && !disabled ? sprite.down : sprite.up;
  // (a held or lit picture goes at the button's corner at its own size: the corner the original draws it from)
  const over = (sprite: AstroSprite, which: 'held' | 'lit') => (
    <span class="au-painted-sprite" data-sprite={`${id}-${which}`} style={areaStyle([rect[0], rect[1], sprite.rect[2], sprite.rect[3]])}>
      <img src={sprite.url} alt="" draggable={false} />
    </span>
  );
  return (
    <>
      {held !== undefined && down && !disabled && over(held, 'held')}
      {lit !== undefined && pressed === true && over(lit, 'lit')}
      {shown && sprite && (
        <span class="au-painted-sprite" data-sprite={id} data-frame={shown === sprite.down ? 'down' : 'up'} style={areaStyle([...shown.rect])}>
          <img src={shown.url} alt="" draggable={false} />
        </span>
      )}
      <span class="au-painted" data-area={`painted-${id}`} style={areaStyle(rect)}>{button}</span>
    </>
  );
}
