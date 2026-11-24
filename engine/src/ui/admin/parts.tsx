// SPDX-License-Identifier: GPL-3.0-or-later
import type { ComponentChildren } from 'preact';
import type { RefObject } from 'preact';
import { useLayoutEffect, useMemo, useRef } from 'preact/hooks';
import { textImage, type AstroFonts } from '../../view/bitmapText';

/**
 * The admin console's own pieces, shared by the console (adminConsole.tsx) and its SETTINGS page (settingsPage.tsx): its rectangles in the
 * original's pixels, its two blues, the words in the game's font, its pictures and its controls.
 */

/** The console's place on the original's screen, and its size. */
export const ORIGIN = { x: 110, y: 1 };
export const W = 420;
export const H = 478;
export type Rect = readonly [x: number, y: number, w: number, h: number];

/** A rectangle given by the notes in the original's screen (the slots, CANCEL, YES, NO, the bars), from the console. */
export const screenRect = (x1: number, y1: number, x2: number, y2: number): Rect => [x1 - ORIGIN.x, y1 - ORIGIN.y, x2 - x1 + 1, y2 - y1 + 1];
/** A rectangle the notes give from the console, by its corners. */
export const rect = (x1: number, y1: number, x2: number, y2: number): Rect => [x1, y1, x2 - x1 + 1, y2 - y1 + 1];

const pct = (v: number, of: number) => `${(v / of) * 100}%`;
/** A rectangle of the console as CSS. */
export const at = ([x, y, w, h]: Rect) => ({ left: pct(x, W), top: pct(y, H), width: pct(w, W), height: pct(h, H) });
/** A picture's rectangle inside a control's, as CSS of the control. */
export const within = (outer: Rect, [x, y, w, h]: Rect) => ({ left: pct(x - outer[0], outer[2]), top: pct(y - outer[1], outer[3]), width: pct(w, outer[2]), height: pct(h, outer[3]) });

/** A sound bar's segments (the original's 27, 6 apart: segment i of the screen's bars at y 81+6i). */
export const SEGMENTS = 27;

/**
 * The game's font the console's words are drawn in: font2.fon, 16 high. adminmnu.cpp's font index is not in the notes (phase4_rest.md §6.2), so this
 * is the controller's ruling (Plan 32 Task 7, fix round 1) until the reverse engineering finds it.
 */
export const ADMIN_FONT = 2;

/** The strip's words for a SAVE or EXPORT refused while the game is busy (a line being said, an action) with no reason of its own. */
export const CANT_SAVE = 'The game cannot be saved just now';
/** The small font of the original's F1 options screen's key list (help.cpp: font 0, tactical_hooks_ui.md §8), for the KEYS tab's table. */
export const KEYS_FONT = 0;
export type Rgb = readonly [number, number, number];
/** The screen's two blues: the lit one (the pages' frames, the names and the message) and the plain one (the pills, the questions). */
export const LIT: Rgb = [104, 224, 252];
export const INK: Rgb = [32, 140, 224];

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Words in the game's own font, as the original draws them (BitmapText's way: a canvas of the string's own size, its hard pixels scaled with the
 * console), placed in `r` (left, centred or right) and upright in the middle of its height. The words themselves stay in the page, in the control or
 * line they belong to: this is for the eye only.
 */
export function BitmapWords({ fonts, text, r, outer, align = 'left', ink, class: cls, fit = false, face = ADMIN_FONT }: {
  fonts: AstroFonts; text: string; r: Rect; outer?: Rect; align?: 'left' | 'centre' | 'right'; ink: Rgb; class?: string;
  /** Kept inside `r`'s width: a longer string is cut at a letter and ends "..." (the remake's own long messages; the console's are short). */
  fit?: boolean;
  /** Which of the game's fonts (ADMIN_FONT unless said). */
  face?: number;
}) {
  const font = fonts.fonts[face];
  const shown = font && fit ? fitText(font, text, r[2]) : text;
  const image = useMemo(() => (font && shown !== '' ? textImage(font, shown, fonts.palette, undefined, ink) : null), [font, shown, fonts.palette, ink]);
  const canvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    if (!image) return;
    try {
      canvas.current?.getContext('2d')?.putImageData(new ImageData(image.data as never, image.width, image.height), 0, 0);
    } catch {
      // (no canvas: the words are in the page)
    }
  }, [image]);
  if (!image) return null;
  const x = align === 'centre' ? r[0] + Math.round((r[2] - image.width) / 2) : align === 'right' ? r[0] + r[2] - image.width : r[0];
  const place: Rect = [x, r[1] + Math.round((r[3] - image.height) / 2), image.width, image.height];
  return <canvas ref={canvas} class={cls ? `au-admin-bt ${cls}` : 'au-admin-bt'} width={image.width} height={image.height} aria-hidden="true" data-bitmap-text={shown} style={outer ? within(outer, place) : at(place)} />;
}

/** `text` as it fits `width` in `font`: whole, or cut at a letter boundary with "..." after it. */
export function fitText(font: { stringWidth(text: string): number }, text: string, width: number): string {
  if (font.stringWidth(text) <= width) return text;
  let n = text.length;
  while (n > 0 && font.stringWidth(`${text.slice(0, n).trimEnd()}...`) > width) n--;
  return n > 0 ? `${text.slice(0, n).trimEnd()}...` : '';
}

/** A picture of the console, placed by its rectangle: hard pixels, never dragged, not read out. */
export function Pic({ src, r, outer, class: cls, data }: { src: string; r: Rect; outer?: Rect; class?: string; data?: Record<string, string> }) {
  return <img class={cls ? `au-admin-pic ${cls}` : 'au-admin-pic'} src={src} alt="" aria-hidden="true" draggable={false} style={outer ? within(outer, r) : at(r)} {...data} />;
}

/**
 * One of the console's controls over its rectangle: the original's pictures in it, or its label in CSS. Its kinds: the original's pills, keys and
 * slot rows, the screen's plain words, and the SETTINGS page's pills (`cap`, the CANCEL shape), choice cells and key rows (the F1 screen's).
 */
export function Control({ name, r, label, kind, disabled, on, onClick, onFocus, children, data }: {
  name: string; r: Rect; label?: string; kind: 'pill' | 'key' | 'row' | 'plain' | 'cap' | 'cell' | 'keyrow'; disabled?: boolean; on?: boolean;
  onClick: () => void; onFocus?: () => void; children?: ComponentChildren; data?: Record<string, string | undefined>;
}) {
  return (
    <button type="button" class={`au-admin-btn au-admin-${kind}`} style={at(r)} aria-label={name} disabled={disabled} data-on={on ? '' : undefined} onClick={onClick} onFocus={onFocus} {...data}>
      {children ?? (label !== undefined ? <span class="au-admin-label">{label}</span> : null)}
    </button>
  );
}

/**
 * A modal screen over the game (the admin console, Tactical's F1 Combat Options): while `box` is up its first control has the focus, and what had
 * it gets it back; everything behind it, from its shade up to the game's frame, is inert, so no key or focus reaches the game.
 */
export function useModal(box: RefObject<HTMLElement>): void {
  useLayoutEffect(() => {
    const before = document.activeElement;
    const shade = box.current?.parentElement ?? null;
    const stop = shade?.closest('#game') ?? document.body;
    const made: Element[] = [];
    for (let el: Element | null = shade; el && el !== stop && el.parentElement; el = el.parentElement) {
      for (const other of Array.from(el.parentElement.children)) {
        if (other === el || other.hasAttribute('inert')) continue;
        other.setAttribute('inert', '');
        made.push(other);
      }
    }
    box.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    return () => {
      for (const el of made) el.removeAttribute('inert');
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);
}

/**
 * A modal screen's own keys (the admin console, Tactical's F1 Combat Options), for its window capture handlers, keydown and keyup alike: Tab and
 * Shift+Tab go round the screen's controls (true: the key is done with); Enter or Space on something behind the screen, should the focus be there,
 * presses nothing, down or up (the browser presses a focused button as Space comes up).
 */
export function modalKey(box: HTMLElement | null, e: KeyboardEvent): boolean {
  const inside = box !== null && e.target instanceof Node && box.contains(e.target);
  if (e.type === 'keydown' && e.key === 'Tab' && box) {
    e.preventDefault();
    const order = Array.from(box.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]'));
    if (order.length > 0) {
      const at = order.indexOf(document.activeElement as HTMLElement);
      order[at < 0 ? 0 : (at + (e.shiftKey ? -1 : 1) + order.length) % order.length]!.focus();
    }
    return true;
  }
  if (!inside && (e.key === ' ' || (e.type === 'keydown' && e.key === 'Enter'))) e.preventDefault();
  return false;
}
