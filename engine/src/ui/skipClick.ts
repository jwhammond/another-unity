// SPDX-License-Identifier: GPL-3.0-or-later
import type { UiStore } from './store';

/**
 * A click while someone speaks ends the line, wherever it lands (as in the original): on the room, on a ship screen's
 * buttons, on the HUD. One capture-phase listener on the game's root takes the press before anything under it, and the
 * click that follows too, so no button underneath is pressed. Returns how to take it off.
 */
export function bindSkipClick(root: HTMLElement, store: UiStore, skipLine: () => void): () => void {
  // set by a swallowed press: the click that ends it is swallowed too
  let swallowed = false;
  const down = (e: PointerEvent) => {
    swallowed = false;
    // (not through the admin console, which stops the game, the line with it: its buttons are pressed)
    if (e.button !== 0 || store.state.subtitle === null || store.state.panel === 'admin') return;
    swallowed = true;
    e.preventDefault();
    e.stopPropagation();
    skipLine();
  };
  const click = (e: MouseEvent) => {
    if (!swallowed) return;
    swallowed = false;
    e.preventDefault();
    e.stopPropagation();
  };
  root.addEventListener('pointerdown', down, true);
  root.addEventListener('click', click, true);
  return () => {
    root.removeEventListener('pointerdown', down, true);
    root.removeEventListener('click', click, true);
  };
}
