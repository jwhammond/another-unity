// SPDX-License-Identifier: GPL-3.0-or-later
import { cursorCss, loadSpriteCursors, originalCursorSource, type SpriteCursors } from '../ui/cursors';
import type { CursorArt } from '../ui/faces';

/** What the session lends the exits' pointer. */
export interface ExitCursorHost {
  /** The original's pointers (art.cursors) with the art on, when they are published. */
  cursorArt(): CursorArt | undefined;
  /** Tells the panels something changed. */
  bump(): void;
}

/**
 * The pointer over astrogation's exits (AstrogationScreen::mouseMove, astrogation.cpp:1917-1925): `setCursor(3)` while an exit is open, which is cursor.dat's
 * frame 3, the use pointer lit, as the away team draws it over something to act on. It is the published picture once that is scaled; until then, with the
 * art off, or with no pointers published, the drawn lit use pointer.
 */
export function exitCursorPort(host: ExitCursorHost): { exitCursor(): string } {
  let sprites: SpriteCursors = {};
  let key = '';
  return {
    exitCursor() {
      const art = host.cursorArt();
      const want = art ? art.sprite('use_lit') : '';
      if (want !== key) {
        key = want;
        sprites = {};
        if (art) {
          void loadSpriteCursors({ use_lit: originalCursorSource(art.sprite('use_lit'), art.scale, art.hotspot('use')) }).then(made => {
            if (key === want) { sprites = made; host.bump(); }
          });
        }
      }
      return cursorCss('use', sprites, true);
    },
  };
}
