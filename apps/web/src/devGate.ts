// SPDX-License-Identifier: GPL-3.0-or-later
/** Whether the page has the dev tools, and what comes with them (Decision 16). */
export interface DevGate {
  /** `?dev` asked for, where a deploy build allows it. */
  devParam: boolean;
  /** The dev tools: a dev server's page, or `?dev`. */
  dev: boolean;
  /** Tactical fights the combat sim for everyone (M8 spec §10); only the dev tools' `?combat=dialog` brings back the M4 dialog (Plan 31 R7). */
  realCombat: boolean;
}

/**
 * The dev tools' gate. Players get them and window.__au only with ?dev; a deploy build (docs/deploy.md:
 * VITE_AU_DEPLOY=1) has no ?dev at all.
 */
export function devGate(params: URLSearchParams, env: { devServer: boolean; deploy: boolean }): DevGate {
  const devParam = !env.deploy && params.has('dev');
  const dev = env.devServer || devParam;
  return { devParam, dev, realCombat: !(dev && params.get('combat') === 'dialog') };
}

/**
 * The frame-rate overlay's gate (Plan 34 Task 8): `?perf`, bare, on any build, for a look at a phone's frame rate.
 * `?perf=<scenario>` is the perf runner's timed battle (`?dev` only), not the overlay.
 */
export function perfOverlayAsked(params: URLSearchParams): boolean {
  return params.getAll('perf').includes('');
}
