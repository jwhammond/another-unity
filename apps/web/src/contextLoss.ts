// SPDX-License-Identifier: GPL-3.0-or-later
/** What a lost WebGL context needs of the page (a test gives its own). */
export interface ContextLossHooks {
  /** The context went: write the game down now, in case it never comes back. */
  lost(): void;
  /** The browser gave the context back (three has rebuilt its state; its textures upload again from the images they still hold). */
  restored(): void;
  /** It has not come back in time: the page reloads, into Continue. */
  giveUp(): void;
}

/** How long a lost context is waited for before the page reloads. */
export const CONTEXT_WAIT_MS = 5000;

/**
 * Handles `webglcontextlost` and `webglcontextrestored`: the loss is announced as one the page will wait out
 * (preventDefault, which is what lets the browser restore it), and if the browser does not restore it within `wait` ms, the
 * page gives up and reloads from the autosave. Returns how to take the handlers off.
 */
export function bindContextLoss(canvas: Pick<HTMLCanvasElement, 'addEventListener' | 'removeEventListener'>, hooks: ContextLossHooks, wait = CONTEXT_WAIT_MS, timers: { set: (f: () => void, ms: number) => ReturnType<typeof setTimeout>; clear: (id: ReturnType<typeof setTimeout>) => void } = { set: (f, ms) => setTimeout(f, ms), clear: id => clearTimeout(id) }): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const lost = (e: Event) => {
    e.preventDefault();
    hooks.lost();
    if (timer === null) timer = timers.set(() => { timer = null; hooks.giveUp(); }, wait);
  };
  const restored = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
    hooks.restored();
  };
  canvas.addEventListener('webglcontextlost', lost);
  canvas.addEventListener('webglcontextrestored', restored);
  return () => {
    if (timer !== null) timers.clear(timer);
    canvas.removeEventListener('webglcontextlost', lost);
    canvas.removeEventListener('webglcontextrestored', restored);
  };
}
