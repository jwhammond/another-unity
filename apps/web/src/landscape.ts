// SPDX-License-Identifier: GPL-3.0-or-later
/** What a browser may offer for playing in landscape; each part is optional (iOS Safari has neither). */
export interface LandscapeEnv {
  documentElement: { requestFullscreen?: (options?: FullscreenOptions) => Promise<void> };
  screen?: { orientation?: { lock?: (orientation: 'landscape') => Promise<void> } };
}

/** What `requestLandscape` got: either may be refused (a refusal is an answer, never an error). */
export interface LandscapeResult {
  fullscreen: boolean;
  locked: boolean;
}

/**
 * Asks for fullscreen, then for the landscape lock (which browsers allow only in fullscreen). Call it inside a user
 * gesture. It never throws: a refusal, or no support, only leaves that part false, and the rotate overlay stays up in portrait.
 */
export async function requestLandscape(env: LandscapeEnv = { documentElement: document.documentElement, screen: screen as LandscapeEnv['screen'] }): Promise<LandscapeResult> {
  const result: LandscapeResult = { fullscreen: false, locked: false };
  const root = env.documentElement;
  try {
    if (typeof root.requestFullscreen === 'function') {
      await root.requestFullscreen();
      result.fullscreen = true;
    }
  } catch {
    // (refused: for example, not in a user gesture, or the browser says no)
  }
  try {
    const orientation = env.screen?.orientation;
    if (typeof orientation?.lock === 'function') {
      await orientation.lock('landscape');
      result.locked = true;
    }
  } catch {
    // (refused or unsupported: the overlay asks the player to turn the device instead)
  }
  return result;
}

/** A touch device: coarse pointer, or touch points. A desktop with a mouse is not, whatever the window's shape. */
export function isTouchDevice(win: Window = window): boolean {
  return win.matchMedia?.('(any-pointer: coarse)').matches === true || (win.navigator.maxTouchPoints ?? 0) > 0;
}

/** Whether the fullscreen API is there to ask (not on iOS Safari's document). */
export function canFullscreen(doc: Document = document): boolean {
  return typeof doc.documentElement.requestFullscreen === 'function';
}

/**
 * Marks the page for the CSS: `au-touch` on a touch device, `au-portrait` while it is tall, `au-fullscreen` while the
 * page is fullscreen. The rotate overlay in index.html shows when a page has `au-touch` and `au-portrait`; a desktop never has
 * `au-touch`, so never sees it. Returns what stops it.
 */
export function bindOrientation(win: Window = window): () => void {
  const root = win.document.documentElement;
  const update = () => {
    root.classList.toggle('au-touch', isTouchDevice(win));
    root.classList.toggle('au-portrait', win.innerHeight > win.innerWidth);
    root.classList.toggle('au-fullscreen', win.document.fullscreenElement !== null && win.document.fullscreenElement !== undefined);
    root.classList.toggle('au-can-fullscreen', canFullscreen(win.document));
  };
  update();
  win.addEventListener('resize', update);
  win.addEventListener('orientationchange', update);
  win.document.addEventListener('fullscreenchange', update);
  return () => {
    win.removeEventListener('resize', update);
    win.removeEventListener('orientationchange', update);
    win.document.removeEventListener('fullscreenchange', update);
  };
}

/** Wires every `.au-fs` button (the loading screen's, the HUD's) not yet wired to ask for landscape; the HUD's is made if the page has none. Safe to call again. */
export function bindFullscreenButtons(doc: Document = document, request: () => Promise<LandscapeResult> = () => requestLandscape()): void {
  if (doc.querySelector('#game') && !doc.querySelector('#game .au-fs')) {
    const hud = doc.createElement('button');
    hud.type = 'button';
    hud.className = 'au-fs au-fs-hud';
    hud.textContent = 'Landscape';
    hud.setAttribute('aria-label', 'Fullscreen, landscape');
    doc.querySelector('#game')!.appendChild(hud);
  }
  doc.querySelectorAll<HTMLElement>('.au-fs:not([data-bound])').forEach(button => {
    button.dataset.bound = '1';
    button.addEventListener('click', e => {
      // (not a click on the game under it: it would skip a line)
      e.stopPropagation();
      void request();
    });
  });
}
