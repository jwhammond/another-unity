// SPDX-License-Identifier: GPL-3.0-or-later
import type { AssetIndex } from '../view/assets';
import { BitmapFont } from '../view/indexed';
import type { PresentationConfig } from '../view/package';

/** What the session lends the console's fonts. */
export interface ConsoleFontsHost {
  presentation(): PresentationConfig;
  assets(): AssetIndex;
  /** Tells the panels the fonts are in. */
  bump(): void;
  warn(message: string): void;
  /** The browser's fetch of a URL's bytes; a test's own. */
  fetchBytes(url: string): Promise<Uint8Array>;
}

/** The fonts the console draws in: kStatusFont 0 and kManeuverFont 2 (tactical.cpp:180, 199), so the first three files. */
export const CONSOLE_FONTS = 3;

/**
 * The console's fonts (Plan 27 R14): the game's own font files as `art.fonts` publishes them, fetched on first use whatever the
 * art setting (they are the original's, not repaints). Null until loaded; null for good, said once, when they aren't published.
 * `settled` says whether there is nothing more to wait for: loaded, failed, or not published.
 */
export function consoleFontsLoader(host: ConsoleFontsHost): { fonts(): readonly BitmapFont[] | null; settled(): boolean } {
  let fonts: readonly BitmapFont[] | null = null;
  let asked = false;
  let settled = false;
  return {
    fonts() {
      if (asked) return fonts;
      asked = true;
      const urls = (host.presentation().art?.fonts?.files ?? []).slice(0, CONSOLE_FONTS).map(f => host.assets().url(f));
      if (urls.length < CONSOLE_FONTS || urls.some(u => u === undefined)) {
        settled = true;
        host.warn('combat: the game\'s fonts (art.fonts) aren\'t published, so the console draws no text: npm run art -- astro publish (docs/unity-local.md)');
        return null;
      }
      Promise.all((urls as string[]).map(u => host.fetchBytes(u))).then(files => {
        fonts = files.map(f => new BitmapFont(f));
        host.bump();
      }).catch((err: unknown) => host.warn(`combat: the console's fonts did not load (${err instanceof Error ? err.message : String(err)}): it draws no text`))
        .finally(() => { settled = true; });
      return null;
    },
    settled: () => settled,
  };
}
