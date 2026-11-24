// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Where the wide view's HUD (hud.tsx) covers the space view, for the target's arrow to keep clear of (targetMarks.ts): the HUD's
 * root, and its panels over the view, each marked with HUD_PANEL by hud.tsx. Apart from hud.tsx so the tactical panel, outside
 * the combat chunk, can read them.
 */
export const HUD_ROOT = 'au-combat-hud';
export const HUD_PANEL = 'data-hud-panel';

type Rect = Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'>;

/**
 * The boxes of `frame` (the wide view's element) its HUD covers, as the page lays them out now: each panel, and the band under
 * the HUD's root (it stops above the game's bar, ship.css). None without a HUD.
 */
export function hudPanelRects(frame: Element): Rect[] {
  const root = frame.querySelector(`.${HUD_ROOT}`);
  if (!root) return [];
  const panels: Rect[] = [...root.querySelectorAll(`[${HUD_PANEL}]`)].map(e => e.getBoundingClientRect());
  const f = frame.getBoundingClientRect(), r = root.getBoundingClientRect();
  if (f.bottom > r.bottom) panels.push({ left: f.left, top: r.bottom, right: f.right, bottom: f.bottom, width: f.width, height: f.bottom - r.bottom });
  return panels;
}
